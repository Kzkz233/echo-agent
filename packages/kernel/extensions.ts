import {
  inspectPluginPackage,
  extractPluginPackage,
  packageMetadata,
  packagePath,
} from './plugin-package.ts';
import { readFile, realpath, stat, mkdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ExtensionHost, ModuleExtension } from './extension-host.ts';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invariant } from '../contracts/index.ts';
import { Store } from './store.ts';
import { PluginManager, manifestSchema, type Plugin } from './registry.ts';
import { StdioRpc } from '../backends/rpc.ts';

const extensionSchema = manifestSchema.extend({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export class Extensions {
  private clients = new Map<string, StdioRpc>();
  private records<T = any>(): T[] {
    return [
      ...this.store.documents<T>('extensions'),
      ...this.store.documents<T>('module-extensions'),
    ];
  }
  private record<T = any>(id: string): T | undefined {
    return (
      this.store.document<T>('module-extensions', id) ?? this.store.document<T>('extensions', id)
    );
  }
  private saveRecord(id: string, row: any) {
    const collection = row.runtime === 'module' ? 'module-extensions' : 'extensions';
    this.store.transaction(() => {
      this.store.put(collection, id, row);
      this.store.remove(collection === 'extensions' ? 'module-extensions' : 'extensions', id);
    });
  }
  constructor(
    readonly store: Store,
    readonly plugins: PluginManager,
    readonly host?: Pick<ExtensionHost, 'store' | 'events'>,
  ) {}
  async install(directory: string, confirmed: boolean) {
    invariant(confirmed, 'extension_consent', '加载本地扩展需要明确确认。');
    const root = await realpath(directory);
    const manifest = extensionSchema.parse(
      JSON.parse(await readFile(join(root, 'echo-plugin.json'), 'utf8')),
    );
    invariant(
      !manifest.package?.startsWith('@echo/'),
      'extension_identity',
      '@echo/ 命名空间保留给随应用验证的内置包',
    );
    invariant(
      !this.plugins.plugins.has(manifest.id) && !this.record(manifest.id),
      'duplicate_plugin',
      '插件 ID 已存在。',
    );
    this.plugins.intent.set(manifest.id, false);
    this.add(root, manifest);
    this.store.set('plugins.intent', Object.fromEntries(this.plugins.intent));
    this.store.put('extensions', manifest.id, { directory: root, manifest });
    return manifest;
  }
  async inspectPackage(path: string) {
    const { manifest, meta, sha256, bytes } = await inspectPluginPackage(path);
    this.plugins.validateReplacement(
      manifest,
      true,
      this.records().map((entry) => entry.manifest),
    );
    return {
      manifest,
      entry: meta.entry,
      runtime: meta.runtime,
      fullTrust: meta.runtime === 'module',
      sha256,
      bytes,
      missingDependencies: manifest.dependencies.filter((id) => !this.plugins.plugins.has(id)),
      update: !!this.record(manifest.id),
    };
  }
  async installPackage(path: string, expectedHash: string) {
    const { manifest, meta, sha256 } = await inspectPluginPackage(path);
    invariant(sha256 === expectedHash, 'package_changed', '插件包已变化，请重新检查');
    this.plugins.validateReplacement(
      manifest,
      true,
      this.records().map((entry) => entry.manifest),
    );
    const previous = this.record(manifest.id);
    invariant(
      !this.plugins.plugins.has(manifest.id) || previous,
      'duplicate_plugin',
      '不能覆盖内置插件',
    );
    const base = join(dirname(this.store.path), 'extensions', manifest.id);
    await mkdir(base, { recursive: true });
    const destination = join(base, sha256.slice(0, 16) + '-' + randomUUID());
    const extracted = await extractPluginPackage(path, destination);
    invariant(extracted.sha256 === expectedHash, 'package_changed', '插件包在安装时发生变化');
    const executable =
      meta.runtime === 'module'
        ? manifest
        : extensionSchema.parse({
            ...manifest,
            command: process.execPath,
            args: [join(destination, meta.entry)],
          });
    if (previous) this.store.put('extension-rollback', manifest.id, previous);
    else {
      this.plugins.intent.set(manifest.id, false);
      if (meta.runtime !== 'module')
        this.add(destination, executable as z.infer<typeof extensionSchema>);
      this.store.set('plugins.intent', Object.fromEntries(this.plugins.intent));
    }
    this.saveRecord(manifest.id, {
      directory: destination,
      manifest: executable,
      sha256,
      runtime: meta.runtime,
      entry: meta.entry,
      metadataHash: createHash('sha256').update(extracted.files['echo-package.json']).digest('hex'),
    });
    return {
      id: manifest.id,
      version: manifest.version,
      requiresRestart: !!previous || meta.runtime === 'module',
    };
  }
  rollbackPackage(id: string) {
    const previous = this.store.document<any>('extension-rollback', id);
    invariant(previous, 'package_rollback', '没有可回退的插件版本');
    this.plugins.validateReplacement(
      previous.manifest,
      true,
      this.records().map((entry) => entry.manifest),
    );
    this.saveRecord(id, previous);
    return { id, requiresRestart: true };
  }
  async uninstall(id: string) {
    invariant(this.record(id), 'missing_extension', '扩展不存在');
    if (this.plugins.plugins.has(id)) await this.plugins.removeLocal(id);
    this.store.remove('extensions', id);
    this.store.remove('module-extensions', id);
    this.store.remove('extension-rollback', id);
    this.store.set('plugins.intent', Object.fromEntries(this.plugins.intent));
    return { id, dataRetained: true };
  }
  packageStatus() {
    return this.records().map((entry) => ({
      id: entry.manifest.id,
      name: entry.manifest.name,
      installedVersion: entry.manifest.version,
      loadedVersion: this.plugins.plugins.get(entry.manifest.id)?.manifest.version,
      rollbackVersion: this.store.document<any>('extension-rollback', entry.manifest.id)?.manifest
        .version,
    }));
  }
  async load() {
    for (const row of this.records<{
      directory: string;
      manifest: z.infer<typeof extensionSchema>;
      runtime?: 'node' | 'module';
      entry?: string;
      metadataHash?: string;
    }>())
      if (row.runtime === 'module') {
        // A disabled module is metadata only: no import, factory or native process.
        const shell: Plugin = {
          distribution: 'local',
          manifest: row.manifest,
          activate: async (ctx) => {
            const plugin = await this.loadModule(row);
            shell.character = plugin.character;
            shell.config = plugin.config;
            shell.api = plugin.api;
            shell.references = plugin.references;
            ctx.dispose(() => {
              shell.api = undefined;
            });
            for (const page of shell.manifest.pages ?? []) {
              invariant(
                page.id.startsWith(shell.manifest.id + '.'),
                'page_namespace',
                '页面编号必须属于插件自己的命名空间',
              );
              ctx.capabilities.provide('core.ui.pages@1', page.id, page.title, () => page);
            }
            await plugin.activate(ctx);
          },
        };
        this.plugins.add(shell);
      } else this.add(row.directory, row.manifest);
  }
  private async loadModule(row: {
    directory: string;
    manifest: z.infer<typeof manifestSchema>;
    entry?: string;
    metadataHash?: string;
  }) {
    invariant(this.host, 'extension_host', '宿主不支持模块扩展');
    const root = await realpath(row.directory);
    const bytes = await readFile(join(root, 'echo-package.json'));
    invariant(
      createHash('sha256').update(bytes).digest('hex') === row.metadataHash,
      'package_hash',
      '已安装扩展清单校验失败',
    );
    const meta = packageMetadata.parse(JSON.parse(bytes.toString('utf8')));
    invariant(
      meta.runtime === 'module' && meta.hostApi === 1 && row.entry === meta.entry,
      'package_api',
      '扩展宿主版本不兼容',
    );
    packagePath(meta.entry);
    invariant(
      meta.files[meta.entry] && meta.files['echo-plugin.json'],
      'package_entry',
      '扩展缺少已校验的入口',
    );
    for (const [name, hash] of Object.entries(meta.files)) {
      packagePath(name);
      const file = await realpath(resolve(root, name)),
        rel = relative(root, file);
      invariant(
        rel &&
          !rel.startsWith('..') &&
          !isAbsolute(rel) &&
          !(await lstat(resolve(root, name))).isSymbolicLink(),
        'package_path',
        '扩展文件越界',
      );
      invariant(
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex') === hash,
        'package_hash',
        '已安装扩展文件校验失败：' + name,
      );
    }
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(root, 'echo-plugin.json'), 'utf8')),
    );
    invariant(
      JSON.stringify(manifest) === JSON.stringify(manifestSchema.parse(row.manifest)),
      'package_manifest',
      '已安装扩展清单不一致',
    );
    this.plugins.validateReplacement(manifest, true);
    const allowed = new Set([...manifest.dependencies, ...manifest.optionalDependencies]);
    const module = (await import(pathToFileURL(join(root, meta.entry)).href)) as ModuleExtension;
    invariant(
      typeof module.createPlugin === 'function',
      'extension_entry',
      '扩展缺少 createPlugin 入口',
    );
    const host = this.host,
      plugins = this.plugins;
    const plugin = await module.createPlugin({
      apiVersion: 1,
      directory: root,
      dataDirectory: dirname(this.store.path),
      store: host.store,
      events: host.events,
      dependency<T extends object>(name: string, version: number): T {
        invariant(allowed.has(name), 'extension_dependency', '扩展未声明依赖：' + name);
        return new Proxy({} as T, {
          get(_target, key) {
            const dependency = plugins.plugins.get(name);
            invariant(
              plugins.active.has(name) && dependency?.api?.version === version,
              'extension_dependency',
              '依赖尚未就绪或 API 版本不兼容：' + name,
            );
            const api = dependency.api;
            const value = Reflect.get(api.value, key);
            return typeof value === 'function'
              ? (...args: unknown[]) => {
                  invariant(
                    plugins.active.has(name) && plugins.plugins.get(name)?.api === api,
                    'extension_dependency',
                    '依赖已停用或替换：' + name,
                  );
                  return value.apply(api.value, args);
                }
              : value;
          },
        });
      },
    });
    invariant(
      plugin && !plugin.component && !plugin.internalComponent,
      'component_owner',
      '扩展不能声明为内置组件',
    );
    invariant(
      JSON.stringify(manifestSchema.parse(plugin.manifest)) === JSON.stringify(manifest),
      'package_manifest',
      '模块与安装清单不一致',
    );
    return plugin;
  }
  settings(pluginId: string, value: Record<string, unknown>) {
    const manifest = this.record<{ manifest: z.infer<typeof extensionSchema> }>(pluginId)?.manifest;
    invariant(manifest, 'missing_extension', '扩展不存在。');
    const shape: Record<string, z.ZodType> = {};
    for (const field of manifest.settings ?? []) {
      let schema: z.ZodType =
        field.type === 'boolean'
          ? z.boolean()
          : field.type === 'number'
            ? z
                .number()
                .min(field.min ?? -Number.MAX_VALUE)
                .max(field.max ?? Number.MAX_VALUE)
            : field.type === 'select'
              ? z.enum(field.options as [string, ...string[]])
              : z.string().max(20000);
      shape[field.key] = schema.optional();
    }
    const parsed = z.object(shape).strict().parse(value);
    this.store.set(pluginId + '.config', parsed);
    this.clients.get(pluginId)?.notify('echo/settingsChanged', { settings: parsed });
    return parsed;
  }
  async pageHtml(pluginId: string, entry: string) {
    const extension = this.record<{ directory: string }>(pluginId);
    invariant(
      extension && this.plugins.active.has(pluginId),
      'page_unavailable',
      '插件页面当前不可用。',
    );
    invariant(!isAbsolute(entry), 'page_path', '页面入口必须是插件内的相对路径。');
    const root = await realpath(extension.directory),
      file = await realpath(resolve(root, entry));
    const path = relative(root, file);
    invariant(
      path && !path.startsWith('..') && !isAbsolute(path) && /[.]html?$/i.test(file),
      'page_path',
      '页面入口必须是插件目录内的 HTML 文件。',
    );
    invariant((await stat(file)).size <= 2_000_000, 'page_size', '插件页面超过大小限制。');
    return readFile(file, 'utf8');
  }
  private add(root: string, manifest: z.infer<typeof extensionSchema>) {
    this.plugins.add({
      distribution: 'local',
      manifest: { ...manifest, views: [] },
      activate: async ({ registry, dispose, capabilities, signal: ownerSignal }) => {
        for (const page of manifest.pages ?? []) {
          invariant(
            page.id.startsWith(manifest.id + '.'),
            'page_namespace',
            '页面编号必须属于插件自己的命名空间。',
          );
          capabilities.provide('core.ui.pages@1', page.id, page.title, () => page);
        }
        const registrations = new Map<string, () => void>();
        const jsonSchema = z
          .record(z.string(), z.unknown())
          .refine((v) => JSON.stringify(v).length <= 100000, 'Schema 过大');
        const pointSchema = z.object({
          id: z.string(),
          description: z.string().max(2000),
          inputSchema: jsonSchema,
          outputSchema: jsonSchema,
          providePermission: z.string(),
          consumePermission: z.string(),
          cardinality: z.enum(['one', 'many']).default('many'),
        });
        const providerSchema = z.object({
          point: z.string(),
          id: z.string(),
          label: z.string().max(200),
        });
        const define = (raw: unknown) => {
          const p = pointSchema.parse(raw);
          const off = capabilities.define({
            ...p,
            input: z.fromJSONSchema(p.inputSchema as any),
            output: z.fromJSONSchema(p.outputSchema as any),
          });
          registrations.set('point:' + p.id, off);
          return { registered: p.id };
        };
        const provide = (raw: unknown) => {
          const p = providerSchema.parse(raw);
          const off = capabilities.provide(p.point, p.id, p.label, (input, signal) =>
            invokeChild('echo/provide', { point: p.point, id: p.id, input }, signal),
          );
          registrations.set('provider:' + p.point + ':' + p.id, off);
          return { registered: p.id };
        };
        const invokeChild = async (
          method: string,
          params: Record<string, unknown>,
          signal: AbortSignal,
        ) => {
          signal.throwIfAborted();
          const invocationId = randomUUID();
          const abort = () => rpc.notify('echo/cancelInvocation', { invocationId });
          signal.addEventListener('abort', abort, { once: true });
          try {
            const result = await rpc.call(method, { ...params, invocationId });
            signal.throwIfAborted();
            return result;
          } finally {
            signal.removeEventListener('abort', abort);
          }
        };
        const rpc = new StdioRpc(
          ['node', 'node.exe'].includes(manifest.command.toLowerCase())
            ? process.execPath
            : manifest.command,
          manifest.args,
          root,
          undefined,
          async (method, params) => {
            ownerSignal.throwIfAborted();
            if (method === 'echo/capabilities.list')
              return {
                points: this.plugins.capabilities.points(),
                providers: capabilities.list(
                  z.object({ point: z.string().optional() }).parse(params).point,
                ),
              };
            if (method === 'echo/capabilities.invoke') {
              const r = z
                .object({ point: z.string(), id: z.string(), input: z.unknown() })
                .parse(params);
              invariant(
                !r.id.startsWith(manifest.id + '.'),
                'extension_recursion',
                '不允许通过宿主递归调用本扩展',
              );
              return capabilities.invoke(r.point, r.id, r.input);
            }
            if (method === 'echo/capabilities.define') return define(params);
            if (method === 'echo/capabilities.provide') return provide(params);
            if (method === 'echo/capabilities.remove') {
              const r = z.object({ key: z.string() }).parse(params);
              const off = registrations.get(r.key);
              off?.();
              registrations.delete(r.key);
              return { removed: Boolean(off) };
            }
            invariant(
              method === 'echo/call',
              'extension_method',
              '扩展只能通过 echo/call 请求已声明权限的操作。',
            );
            const request = z.object({ name: z.string(), input: z.unknown() }).parse(params);
            invariant(
              !request.name.startsWith(manifest.id + '.'),
              'extension_recursion',
              '不允许通过宿主递归调用本扩展。',
            );
            return registry.call(request.name, request.input, {
              kind: 'extension',
              pluginId: manifest.id,
              permissions: new Set(manifest.permissions),
            });
          },
        );
        this.clients.set(manifest.id, rpc);
        dispose(async () => {
          this.clients.delete(manifest.id);
          await rpc.close();
        });
        const description = await rpc.call('echo/initialize', {
          apiVersion: 1,
          pluginId: manifest.id,
          settings: this.store.get(manifest.id + '.config', {}),
        });
        for (const p of z
          .array(pointSchema)
          .max(50)
          .parse(description.extensionPoints ?? []))
          define(p);
        for (const p of z
          .array(providerSchema)
          .max(100)
          .parse(description.providers ?? []))
          provide(p);
        const operations = z
          .array(
            z.object({
              name: z.string().regex(/^[a-z][\w.-]{0,100}$/),
              description: z.string().max(2000),
              inputSchema: z.record(z.string(), z.unknown()),
              outputSchema: jsonSchema.default({}),
              permission: z.string(),
              mcp: z.boolean().default(false),
            }),
          )
          .max(100)
          .parse(description.operations ?? []);
        for (const operation of operations) {
          invariant(
            operation.name.startsWith(manifest.id + '.'),
            'extension_namespace',
            '扩展操作必须位于自己的命名空间。',
          );
          invariant(
            manifest.permissions.includes(operation.permission),
            'extension_permission',
            '扩展未声明该操作所需权限。',
          );
          const input = z.fromJSONSchema(operation.inputSchema as any);
          registry.register({
            ...operation,
            input,
            output: z.fromJSONSchema(operation.outputSchema as any),
            owner: manifest.id,
            run: (value, _caller, signal) => {
              signal.throwIfAborted();
              return invokeChild('echo/invoke', { name: operation.name, input: value }, signal);
            },
          });
        }
      },
    });
  }
}
