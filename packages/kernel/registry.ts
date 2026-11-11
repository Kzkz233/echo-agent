import { storagePathSchema, type StoragePaths } from '../contracts/storage.ts';
import { z } from 'zod';
import { frontendPageSchema, type FrontendPage } from '../contracts/frontend.ts';
import { EchoError, invariant } from '../contracts/index.ts';
import { Capabilities } from './capabilities.ts';
import { characterPoint, type CharacterFeature } from './characters.ts';

export type Caller = {
  kind: 'ui' | 'cli' | 'internal' | 'mcp' | 'extension';
  permissions: Set<string>;
  pluginId?: string;
  conversationId?: string;
  personaId?: string;
};
export const internal: Caller = { kind: 'internal', permissions: new Set(['*']) };
export type Operation = {
  name: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  permission: string;
  mcp: boolean;
  roleOnly?: boolean;
  toolInputSchema?: Record<string, unknown>;
  owner: string;
  run: (input: any, caller: Caller, signal: AbortSignal) => unknown | Promise<unknown>;
};
type OwnerScope = {
  generation: number;
  controller: AbortController;
  closing: boolean;
  active: boolean;
};
export class Registry {
  private maintenance = false;
  beginUpdate() {
    invariant([...this.calls.values()].reduce((sum, calls) => sum + calls.size, 0) <= 1,
      'update_busy', '仍有操作正在执行，请完成后再更新。');
    this.maintenance = true;
  }
  resumeAfterUpdateFailure() { this.maintenance = false; }
  private entries = new Map<string, Operation>();
  private owners = new Map<string, OwnerScope>();
  private calls = new Map<string, Set<Promise<unknown>>>();
  private sequence = 0;
  openOwner(owner: string) {
    const scope = {
      generation: ++this.sequence,
      controller: new AbortController(),
      closing: false,
      active: false,
    };
    this.owners.set(owner, scope);
    return scope;
  }
  scoped(
    owner: string,
    permissions: Set<string>,
    scope: OwnerScope,
    dispose: (fn: () => void | Promise<void>) => void,
  ): OperationRegistry {
    return {
      register: (operation) => {
        invariant(
          !scope.closing && !scope.controller.signal.aborted,
          'plugin_unloading',
          '插件正在卸载',
        );
        invariant(
          operation.owner === owner && operation.name.startsWith(owner + '.'),
          'operation_owner',
          '插件只能注册自己的命名空间',
        );
        invariant(
          permissions.has(operation.permission) || permissions.has('*'),
          'operation_permission',
          '接口权限未在插件清单声明',
        );
        const off = this.register(operation);
        dispose(off);
        return off;
      },
      list: (caller, mcp) => this.list({ ...caller, permissions }, mcp),
      call: (name, input, caller, signal) => {
        invariant(
          !(name === 'plugins.enable' && (input as any)?.id === owner),
          'self_unload',
          '插件不能在自己的调用内卸载自己',
        );
        return this.call(
          name,
          input,
          { kind: caller.kind, pluginId: owner, permissions },
          AbortSignal.any([scope.controller.signal, signal ?? new AbortController().signal]),
        );
      },
    };
  }
  register(operation: Operation) {
    invariant(!this.entries.has(operation.name), 'duplicate_operation', operation.name);
    this.entries.set(operation.name, operation);
    return () => {
      if (this.entries.get(operation.name) === operation) this.entries.delete(operation.name);
    };
  }
  retireOwner(owner: string) {
    const scope = this.owners.get(owner);
    if (scope) {
      scope.closing = true;
      scope.controller.abort();
    }
    this.removeOwner(owner);
  }
  async drainOwner(owner: string, timeout = 5000) {
    const calls = [...(this.calls.get(owner) ?? [])];
    if (!calls.length) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(calls),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new EchoError('plugin_draining', '插件仍有无法中断的调用，暂不允许重新加载。'),
              ),
            timeout,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  removeOwner(owner: string) {
    for (const [name, op] of this.entries) if (op.owner === owner) this.entries.delete(name);
  }
  list(caller: Caller, mcp = false) {
    return [...this.entries.values()].filter(
      (op) =>
        (!mcp || op.mcp) &&
        this.inScope(op, caller) &&
        this.allowed(caller, op.permission) &&
        !this.owners.get(op.owner)?.closing &&
        (this.owners.get(op.owner)?.active ?? true),
    );
  }
  allowed(caller: Caller, permission: string) {
    return caller.permissions.has('*') || caller.permissions.has(permission);
  }
  private inScope(operation: Operation, caller: Caller) {
    return !operation.roleOnly || caller.kind === 'internal' ||
      (caller.kind === 'mcp' && Boolean(caller.personaId && caller.conversationId));
  }
  async callFromOwner(
    owner: string,
    name: string,
    input: unknown,
    permissions: Set<string>,
    signal = new AbortController().signal,
  ) {
    const scope = this.owners.get(owner);
    invariant(scope?.active && !scope.closing, 'plugin_unloading', '插件页面当前不可用。');
    const combined = AbortSignal.any([scope.controller.signal, signal]);
    const task = this.call(
      name,
      input,
      { kind: 'extension', pluginId: owner, permissions },
      combined,
    );
    const calls = this.calls.get(owner) ?? new Set();
    calls.add(task);
    this.calls.set(owner, calls);
    try {
      const result = await task;
      combined.throwIfAborted();
      invariant(this.owners.get(owner) === scope, 'stale_plugin', '旧插件实例的页面结果已失效。');
      return result;
    } finally {
      calls.delete(task);
    }
  }
  async call(
    name: string,
    input: unknown,
    caller: Caller,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<any> {
    invariant(!this.maintenance || ['system.shutdown', 'system.status', 'updates.status', 'updates.confirm'].includes(name),
      'updating', 'Echo 正在重启更新，请稍后操作。');
    const op = this.entries.get(name);
    invariant(op, 'not_found', '未找到操作：' + name);
    invariant(
      this.allowed(caller, op.permission) && this.inScope(op, caller),
      'permission_denied',
      '需要权限：' + op.permission,
    );
    const scope = this.owners.get(op.owner);
    invariant(!scope?.closing, 'plugin_unloading', '插件正在卸载');
    invariant(scope?.active ?? true, 'plugin_loading', '插件尚未就绪');
    const combined = scope ? AbortSignal.any([signal, scope.controller.signal]) : signal;
    combined.throwIfAborted();
    const parsed = op.input.parse(input);
    const task = Promise.resolve()
      .then(() => op.run(parsed, caller, combined))
      .then((result) => {
        combined.throwIfAborted();
        invariant(
          !scope || this.owners.get(op.owner) === scope,
          'stale_plugin',
          '旧插件实例的结果已撤销',
        );
        return op.output.parse(result);
      });
    const calls = this.calls.get(op.owner) ?? new Set<Promise<unknown>>();
    this.calls.set(op.owner, calls);
    calls.add(task);
    try {
      return await task;
    } finally {
      calls.delete(task);
    }
  }
}
export type OperationRegistry = Pick<Registry, 'register' | 'list' | 'call'>;
export type Field = {
  key: string;
  label: string;
  type: 'boolean' | 'number' | 'text' | 'textarea' | 'select' | 'path' | 'multi' | 'records';
  rowFields?: Field[];
  rowTitleKey?: string;
  defaults?: Record<string, unknown>;
  addLabel?: string;
  removeLabel?: string;
  resource?: 'conversation' | 'persona' | 'vault' | 'model' | 'executor' | 'permission' | 'workspace' | 'mailAccount';
  backendKinds?: string[];
  inferenceTask?:string;
  pathMode?: 'file' | 'directory' | 'save';
  description?: string;
  localOnly?: boolean;
  options?: string[];
  optionLabels?: Record<string, string>;
  min?: number;
  max?: number;
};
export type Manifest = {
  apiVersion?: 1;
  package?: string;
  id: string;
  name: string;
  description: string;
  version: string;
  dependencies: string[];
  optionalDependencies?: string[];
  storagePaths?: StoragePaths[];
  /** Legacy manifest input; normalized to optionalDependencies. */
  enhances?: string[];
  permissions: string[];
  characterPermissions?: string[];
  characterSettings?: { section: string; title: string; order?: number; editor?: string };
  category?: string;
  settings: Field[];
  views?: string[];
  pages?: FrontendPage[];
};
export const manifestSchema = z
  .object({
    apiVersion: z.literal(1).default(1),
    package: z.string().max(160).optional(),
    id: z.string().regex(/^[a-z][\w-]{0,80}$/),
    name: z.string().min(1).max(160),
    description: z.string().max(3000),
    version: z.string().min(1),
    dependencies: z.array(z.string()).default([]),
    optionalDependencies: z.array(z.string()).default([]),
    storagePaths: z.array(storagePathSchema).max(30).default([]),
    enhances: z
      .array(z.string().regex(/^[a-z][\w-]{0,80}$/))
      .max(20)
      .default([]),
    permissions: z.array(z.string()).default([]),
    characterPermissions: z.array(z.string()).max(100).default([]),
    category: z.string().min(1).max(80).default('Other extensions'),
    characterSettings: z
      .object({
        section: z.string().regex(/^[a-z][\w-]{0,80}$/),
        title: z.string().min(1).max(100),
        order: z.number().int().default(0),
        editor: z
          .string()
          .regex(/^[a-z][\w.-]{0,80}$/)
          .optional(),
      })
      .optional(),
    settings: z
      .array(
        z.object({
          key: z.string().regex(/^[\w.-]{1,80}$/),
          label: z.string().min(1).max(200),
          type: z.enum([
            'boolean',
            'number',
            'text',
            'textarea',
            'select',
            'path',
            'multi',
            'records',
          ]),
          rowFields: z.array(z.any()).optional(),
          rowTitleKey: z.string().regex(/^[\w.-]{1,80}$/).optional(),
          defaults: z.record(z.string(), z.unknown()).optional(),
          addLabel: z.string().max(100).optional(),
          removeLabel: z.string().max(100).optional(),
          resource: z.enum(['conversation', 'persona', 'vault', 'model', 'executor', 'permission', 'workspace', 'mailAccount']).optional(),
          localOnly: z.boolean().optional(),
          backendKinds: z.array(z.string()).optional(),
          inferenceTask:z.string().optional(),
          pathMode: z.enum(['file', 'directory', 'save']).optional(),
          description: z.string().max(2000).optional(),
          options: z.array(z.string().max(200)).max(100).optional(),
          optionLabels: z.record(z.string(), z.string()).optional(),
          min: z.number().optional(),
          max: z.number().optional(),
        }),
      )
      .max(100)
      .default([]),
    views: z.array(z.string()).default([]),
    pages: z.array(frontendPageSchema).max(30).default([]),
  })
  .superRefine((manifest, context) => {
    for (const permission of manifest.characterPermissions) {
      if (!manifest.permissions.includes(permission))
        context.addIssue({
          code: 'custom',
          path: ['characterPermissions'],
          message: `Character permission ${permission} must also be declared in permissions.`,
        });
    }
  });
export function defineManifest(value: unknown): Manifest {
  const parsed = manifestSchema.parse(value);
  const { enhances, ...manifest } = parsed;
  return {
    ...manifest,
    optionalDependencies: [...new Set([...manifest.optionalDependencies, ...enhances])].filter(
      (id) => !manifest.dependencies.includes(id),
    ),
  };
}
export type PluginContext = {
  registry: OperationRegistry;
  capabilities: ReturnType<Capabilities['forOwner']>;
  signal: AbortSignal;
  dispose: (fn: () => void | Promise<void>) => void;
};
export type ConversationReference = {
  label: string;
  page: string;
  role: 'channel' | 'trigger' | 'material' | 'report';
  enabled?: boolean;
  blocksDeletion?: boolean;
  type?: string;
  taskId?: string;
};
export type Plugin = {
  api?: { version: number; value: object };
  /** Application-owned assembly metadata, never supplied by an installed extension. */
  component?: string;
  internalComponent?: boolean;
  character?: CharacterFeature;
  distribution?: 'bundled' | 'local';
  manifest: Manifest;
  config?: { schema: z.ZodType };
  // Read saved references even when this bundled plugin is inactive.
  references?: (conversationId: string) => ConversationReference[];
  activate: (context: PluginContext) => void | Promise<void>;
};
class PendingDependency extends Error {}
export class PluginManager {
  readonly plugins = new Map<string, Plugin>();
  private readonly builtins = new Set<string>();
  readonly active = new Map<string, (() => void | Promise<void>)[]>();
  readonly intent = new Map<string, boolean>();
  private states = new Map<string, { state: string; error?: string }>();
  private serial = Promise.resolve();
  private started = false;
  private closing = false;
  constructor(
    readonly registry: Registry,
    readonly capabilities = new Capabilities(),
  ) {}
  isBuiltin(id: string) {
    return this.builtins.has(id);
  }
  characterPermissions() {
    // Resource ownership and permission to use a tool are independent. Every
    // active model-facing operation can be granted, including shared modules.
    return new Set(this.registry.list(internal, true).map((operation) => operation.permission));
  }
  addBuiltin(plugin: Plugin) {
    invariant(
      !this.started && plugin.distribution !== 'local',
      'builtin_registration',
      '内建模块只能由应用装配。',
    );
    this.add(plugin);
    this.builtins.add(plugin.manifest.id);
  }
  add(plugin: Plugin) {
    invariant(
      plugin.distribution !== 'local' || (!plugin.component && !plugin.internalComponent),
      'component_owner',
      '扩展不能声明为内置组件。',
    );
    plugin.manifest = defineManifest({
      ...plugin.manifest,
      package:
        plugin.manifest.package ??
        (plugin.distribution === 'local' ? 'echo-plugin-' : '@echo/') + plugin.manifest.id,
    });
    invariant(!this.plugins.has(plugin.manifest.id), 'duplicate_plugin', plugin.manifest.id);
    this.validateReplacement(plugin.manifest, plugin.distribution === 'local');
    this.plugins.set(plugin.manifest.id, plugin);
    try {
      this.order();
    } catch (e) {
      this.plugins.delete(plugin.manifest.id);
      throw e;
    }
    if (this.started && !this.closing) void this.enqueue(() => this.reconcile()).catch(() => {});
  }
  validateReplacement(manifest: Manifest, local = true, pending: Manifest[] = []) {
    if (local)
      for (const entry of manifest.storagePaths ?? [])
        invariant(
          entry.collection === manifest.id ||
            entry.collection.startsWith(manifest.id + '.') ||
            entry.collection.startsWith(manifest.id + '-') ||
            entry.collection === 'character-settings.' + manifest.id,
          'storage_owner',
          '插件只能声明自己数据的迁移路径',
        );
    const edges = (m: Manifest) => [...m.dependencies, ...(m.optionalDependencies ?? [])];
    const graph = new Map(
      [...this.plugins.values()].map((plugin) => [plugin.manifest.id, edges(plugin.manifest)]),
    );
    for (const staged of pending) graph.set(staged.id, edges(staged));
    graph.set(manifest.id, edges(manifest));
    const visiting = new Set<string>(),
      seen = new Set<string>();
    const visit = (id: string) => {
      invariant(!visiting.has(id), 'dependency_cycle', '插件循环依赖：' + id);
      if (seen.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) if (graph.has(dependency)) visit(dependency);
      visiting.delete(id);
      seen.add(id);
    };
    for (const id of graph.keys()) visit(id);
  }
  private order() {
    const seen = new Set<string>(),
      visiting = new Set<string>(),
      result: string[] = [];
    const visit = (id: string) => {
      if (visiting.has(id)) throw new EchoError('dependency_cycle', '插件循环依赖：' + id);
      if (seen.has(id)) return;
      visiting.add(id);
      for (const dep of [
        ...(this.plugins.get(id)?.manifest.dependencies ?? []),
        ...(this.plugins.get(id)?.manifest.optionalDependencies ?? []),
      ])
        if (this.plugins.has(dep)) visit(dep);
      visiting.delete(id);
      seen.add(id);
      result.push(id);
    };
    for (const id of this.plugins.keys()) visit(id);
    return result;
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.then(fn, fn);
    this.serial = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  async restore(intent: Record<string, boolean>) {
    this.started = true;
    for (const [id, wanted] of Object.entries(intent))
      if (!this.isBuiltin(id)) this.intent.set(id, wanted);
    await this.enqueue(() => this.reconcile());
    for (const id of this.builtins)
      invariant(this.active.has(id), 'builtin_failed', this.states.get(id)?.error ?? id);
  }
  async enable(id: string) {
    invariant(!this.closing, 'plugin_closing', '应用正在关闭');
    if (this.isBuiltin(id)) return;
    this.started = true;
    this.intent.set(id, true);
    await this.enqueue(() => this.reconcile());
    const state = this.states.get(id);
    if (state?.state === 'failed') throw new EchoError('plugin_failed', state.error ?? id);
  }
  private async activate(id: string) {
    if (this.active.has(id)) return;
    if (this.intent.get(id) === false) throw new PendingDependency('必需插件已停用：' + id);
    const plugin = this.plugins.get(id);
    if (!plugin) throw new PendingDependency('等待插件安装：' + id);
    await this.registry.drainOwner(id);
    await this.capabilities.drainOwner(id);
    for (const dep of plugin.manifest.dependencies) await this.activate(dep);
    for (const dep of plugin.manifest.optionalDependencies ?? [])
      if (this.plugins.has(dep) && (this.isBuiltin(dep) || this.intent.get(dep) === true)) {
        try {
          await this.activate(dep);
        } catch {
          /* Optional interfaces remain unavailable until their provider recovers. */
        }
      }
    const disposers: (() => void | Promise<void>)[] = [];
    const scope = this.registry.openOwner(id);
    this.states.set(id, { state: 'loading' });
    const dispose = (fn: () => void | Promise<void>) => {
      invariant(!scope.closing, 'plugin_unloading', '插件正在卸载');
      disposers.push(fn);
    };
    try {
      const context: PluginContext = {
        registry: this.registry.scoped(id, new Set(plugin.manifest.permissions), scope, dispose),
        capabilities: this.capabilities.forOwner(
          {
            id,
            permissions: new Set(plugin.manifest.permissions),
            signal: scope.controller.signal,
            ready: () => scope.active && !scope.closing,
          },
          dispose,
        ),
        dispose,
        signal: scope.controller.signal,
      };
      await plugin.activate(context);
      if (plugin.character) {
        const feature = plugin.character;
        context.capabilities.provide(
          characterPoint,
          id + '.character',
          plugin.manifest.name,
          async (input, signal) => {
            if (input.action === 'describe')
              return {
                version: feature.version,
                fields: feature.fields,
                taskTypes: feature.taskTypes ?? [],
                requires: plugin.manifest.dependencies,
                presentation: plugin.manifest.characterSettings ?? {
                  section: 'extensions',
                  title: '扩展能力',
                  order: 100,
                },
                value: feature.schema.parse({}),
              };
            if (input.action === 'unpack') {
              invariant(feature.unpack, 'package_assets', '此插件不接受随包素材。');
              return {
                version: feature.version,
                value: await feature.unpack(input.assets ?? {}, signal),
              };
            }
            invariant(input.personaId, 'character_missing', '请选择角色。');
            if (input.action === 'pack')
              return {
                version: feature.version,
                assets: (await feature.pack?.(input.personaId)) ?? {},
              };
            if (input.action === 'read')
              return { version: feature.version, value: feature.read(input.personaId) };
            const value = feature.schema.parse(input.value ?? {});
            if (input.action === 'save') await feature.save(input.personaId, value);
            return { version: feature.version, value };
          },
        );
      }
      scope.active = true;
      this.capabilities.changed();
      this.active.set(id, disposers);
      this.states.set(id, { state: 'active' });
    } catch (error) {
      this.registry.retireOwner(id);
      for (const fn of disposers.reverse())
        try {
          await fn();
        } catch {}
      this.registry.removeOwner(id);
      throw error;
    }
  }
  private async reconcile() {
    for (const [id, wanted] of [
      ...[...this.builtins].map((id) => [id, true] as const),
      ...this.intent,
    ])
      if (wanted && !this.active.has(id))
        try {
          await this.activate(id);
        } catch (error) {
          this.states.set(id, {
            state: error instanceof PendingDependency ? 'pending' : 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
  }
  async disable(id: string) {
    invariant(
      !this.isBuiltin(id),
      'builtin_module',
      '内建模块随应用运行，请在业务页面停用相应任务或绑定。',
    );
    this.intent.set(id, false);
    await this.enqueue(async () => {
      await this.deactivate(id);
      await this.reconcile();
    });
  }
  async removeLocal(id: string) {
    invariant(this.plugins.get(id)?.distribution === 'local', 'extension_owner', '只能卸载独立安装的扩展');
    await this.disable(id);
    await this.enqueue(async () => {
      this.plugins.delete(id); this.intent.delete(id); this.states.delete(id);
      await this.reconcile();
    });
  }
  private async deactivate(id: string) {
    const errors: unknown[] = [];
    for (const [activeId] of this.active)
      if (this.plugins.get(activeId)?.manifest.dependencies.includes(id))
        try {
          await this.deactivate(activeId);
        } catch (e) {
          errors.push(e);
        }
    const disposers = this.active.get(id);
    if (!disposers) {
      if (errors.length) throw new EchoError('plugin_cleanup', errors.map(String).join('; '));
      return;
    }
    this.active.delete(id);
    this.states.set(id, { state: 'unloading' });
    this.registry.retireOwner(id);
    for (const fn of [...disposers].reverse())
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    try {
      await this.registry.drainOwner(id);
      await this.capabilities.drainOwner(id);
    } catch (error) {
      errors.push(error);
    }
    this.states.set(
      id,
      errors.length
        ? { state: 'failed', error: errors.map(String).join('; ') }
        : { state: this.intent.get(id) === false ? 'disabled' : 'pending' },
    );
    if (errors.length) throw new EchoError('plugin_cleanup', errors.map(String).join('; '));
  }
  list() {
    const order = this.order();
    return [...this.plugins.values()].map((p) => ({
      ...p.manifest,
      component: p.component,
      internalComponent: p.internalComponent ?? false,
      loadOrder: order.indexOf(p.manifest.id),
      characterConfigurable: Boolean(p.character),
      scopes: ['application', ...(p.character ? ['character'] : [])],
      applicationPermissions: p.manifest.permissions.filter(
        (permission) => !p.manifest.characterPermissions?.includes(permission),
      ),
      settings: p.manifest.settings.filter(
        (field) => !p.character?.fields.some((roleField) => roleField.key === field.key),
      ),
      distribution: p.distribution ?? 'bundled',
      builtin: this.isBuiltin(p.manifest.id),
      enabled: this.active.has(p.manifest.id),
      requested: this.isBuiltin(p.manifest.id) || this.intent.get(p.manifest.id) === true,
      ...(this.states.get(p.manifest.id) ?? { state: 'disabled' }),
    }));
  }
  async close() {
    this.closing = true;
    await this.enqueue(async () => {
      const errors: unknown[] = [];
      for (const id of [...this.active.keys()].reverse())
        try {
          await this.deactivate(id);
        } catch (e) {
          errors.push(e);
        }
      if (errors.length) throw new EchoError('plugin_cleanup', errors.map(String).join('; '));
    });
  }
}
