import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invariant, EchoError } from '../contracts/index.ts';
export type CapabilityOwner = {
  id: string;
  permissions: Set<string>;
  signal: AbortSignal;
  ready?: () => boolean;
};
export type ExtensionPoint = {
  id: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  providePermission: string;
  consumePermission: string;
  cardinality?: 'one' | 'many';
};
type Definition = {
  contract: ExtensionPoint;
  owner: CapabilityOwner;
  token: string;
  controller: AbortController;
};
type Provider = {
  point: string;
  id: string;
  label: string;
  owner: CapabilityOwner;
  handler: (input: any, signal: AbortSignal) => Promise<unknown> | unknown;
  token: string;
  controller: AbortController;
};
const name = /^[a-z][\w.-]*@[1-9]\d*$/;
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
/** Generic, versioned extension-point host. It has no knowledge of mail, Review or retrieval. */
export class Capabilities {
  private definitions = new Map<string, Definition>();
  private providers = new Map<string, Provider>();
  private contracts = new Map<string, string>();
  private calls = new Map<string, Set<Promise<unknown>>>();
  private listeners = new Set<() => void>();
  private notification = false;
  changed() {
    if (this.notification) return;
    this.notification = true;
    queueMicrotask(() => {
      this.notification = false;
      for (const fn of this.listeners)
        try {
          fn();
        } catch {}
    });
  }
  define(owner: CapabilityOwner, contract: ExtensionPoint) {
    invariant(!owner.signal.aborted, 'plugin_unloading', '插件正在卸载');
    invariant(
      name.test(contract.id) && contract.id.startsWith(owner.id + '.'),
      'extension_point_namespace',
      '扩展点必须使用定义插件的命名空间及 @版本',
    );
    invariant(!this.definitions.has(contract.id), 'extension_point_duplicate', '扩展点已定义');
    const hash = createHash('sha256')
      .update(
        canonical({
          input: z.toJSONSchema(contract.input),
          output: z.toJSONSchema(contract.output),
          provide: contract.providePermission,
          consume: contract.consumePermission,
          cardinality: contract.cardinality ?? 'many',
        }),
      )
      .digest('hex');
    invariant(
      !this.contracts.has(contract.id) || this.contracts.get(contract.id) === hash,
      'extension_contract_changed',
      '同版本扩展点的约定不能静默改变，请增加版本',
    );
    this.contracts.set(contract.id, hash);
    const definition = { contract, owner, token: randomUUID(), controller: new AbortController() };
    this.definitions.set(contract.id, definition);
    this.changed();
    return () => {
      definition.controller.abort();
      if (this.definitions.get(contract.id) === definition) this.definitions.delete(contract.id);
      this.changed();
    };
  }
  provide(
    owner: CapabilityOwner,
    point: string,
    id: string,
    label: string,
    handler: Provider['handler'],
  ) {
    invariant(!owner.signal.aborted, 'plugin_unloading', '插件正在卸载');
    invariant(name.test(point), 'extension_point_name', '扩展点需包含 @版本');
    invariant(
      /^[a-z][\w.-]{1,199}$/.test(id) && id.startsWith(owner.id + '.'),
      'capability_namespace',
      '提供项必须使用自己的命名空间',
    );
    const key = point + '::' + id;
    invariant(!this.providers.has(key), 'capability_duplicate', '提供项已注册');
    const provider = {
      point,
      id,
      label,
      handler,
      owner,
      token: randomUUID(),
      controller: new AbortController(),
    };
    this.providers.set(key, provider);
    this.changed();
    return () => {
      provider.controller.abort();
      if (this.providers.get(key) === provider) this.providers.delete(key);
      this.changed();
    };
  }
  list(point?: string) {
    return [...this.providers.values()]
      .filter((p) => !point || p.point === point)
      .map((p) => {
        const definition = this.definitions.get(p.point);
        const permitted =
          definition &&
          (p.owner.permissions.has('*') ||
            p.owner.permissions.has(definition.contract.providePermission));
        return {
          point: p.point,
          id: p.id,
          label: p.label,
          owner: p.owner.id,
          state: p.owner.signal.aborted
            ? 'stopping'
            : !definition
              ? 'pending'
              : !permitted
                ? 'denied'
                : definition.owner.signal.aborted ||
                    definition.owner.ready?.() === false ||
                    p.owner.ready?.() === false
                  ? 'pending'
                  : 'active',
        };
      });
  }
  points() {
    return [...this.definitions.values()].map((d) => ({
      id: d.contract.id,
      owner: d.owner.id,
      description: d.contract.description,
      providePermission: d.contract.providePermission,
      consumePermission: d.contract.consumePermission,
      cardinality: d.contract.cardinality ?? 'many',
      contractHash: this.contracts.get(d.contract.id),
    }));
  }
  instanceKey(point: string, id: string) {
    const definition = this.definitions.get(point), provider = this.providers.get(point + '::' + id);
    return definition && provider ? definition.token + ':' + provider.token : undefined;
  }
  async invoke(
    caller: CapabilityOwner,
    point: string,
    id: string,
    input: unknown,
    signal: AbortSignal = caller.signal,
  ) {
    const definition = this.definitions.get(point),
      provider = this.providers.get(point + '::' + id);
    invariant(definition && provider, 'capability_missing', '扩展点或提供项当前不可用');
    invariant(
      definition.owner.ready?.() !== false && provider.owner.ready?.() !== false,
      'capability_loading',
      '扩展点或提供方尚未就绪',
    );
    invariant(
      caller.permissions.has('*') || caller.permissions.has(definition.contract.consumePermission),
      'capability_consume_denied',
      '没有调用此扩展点的权限',
    );
    invariant(
      provider.owner.permissions.has('*') ||
        provider.owner.permissions.has(definition.contract.providePermission),
      'capability_provide_denied',
      '提供方没有贡献此扩展点的权限',
    );
    const combined = AbortSignal.any([
      signal,
      caller.signal,
      provider.owner.signal,
      definition.owner.signal,
      provider.controller.signal,
      definition.controller.signal,
    ]);
    combined.throwIfAborted();
    const parsed = definition.contract.input.parse(input);
    const task = Promise.resolve()
      .then(() => provider.handler(parsed, combined))
      .then((result) => {
        combined.throwIfAborted();
        invariant(
          this.providers.get(point + '::' + id) === provider &&
            this.definitions.get(point) === definition,
          'stale_capability',
          '旧实例的扩展结果已撤销',
        );
        return definition.contract.output.parse(result);
      });
    const owners = new Set([caller.id, provider.owner.id, definition.owner.id]);
    for (const id of owners) {
      const calls = this.calls.get(id) ?? new Set();
      calls.add(task);
      this.calls.set(id, calls);
    }
    try {
      return await task;
    } finally {
      for (const id of owners) this.calls.get(id)?.delete(task);
    }
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
              reject(new EchoError('capability_draining', '扩展调用仍未退出，暂不允许重新加载。')),
            timeout,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  forOwner(owner: CapabilityOwner, dispose: (fn: () => void | Promise<void>) => void) {
    return {
      define: (point: ExtensionPoint) => {
        const off = this.define(owner, point);
        dispose(off);
        return off;
      },
      provide: (point: string, id: string, label: string, handler: Provider['handler']) => {
        const off = this.provide(owner, point, id, label, handler);
        dispose(off);
        return off;
      },
      list: (point?: string) => this.list(point),
      subscribe: (fn: () => void) => {
        this.listeners.add(fn);
        const off = () => {
          this.listeners.delete(fn);
        };
        dispose(off);
        return off;
      },
      invoke: (point: string, id: string, input: unknown, signal?: AbortSignal) =>
        this.invoke(owner, point, id, input, signal),
    };
  }
}
