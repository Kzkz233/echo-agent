import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  adapterSchema,
  modelKindSchema,
  taskSchema,
  connectionSchema,
  modelProfileSchema,
  inferenceTasks,
  type AdapterDescriptor,
  type ModelProfile,
  type InferenceTask,
  type Connection,
} from '../contracts/inference.ts';
import { invariant, profileSchema, type Profile } from '../contracts/index.ts';
import { Capabilities, type CapabilityOwner } from './capabilities.ts';
import { Store } from './store.ts';
import type { PluginContext } from './registry.ts';
import { modelListingSchema, type ModelListing } from '../contracts/reasoning.ts';
import { effectiveReasoning } from '../backends/model-metadata.ts';
export function contributeInferenceTask(
  ctx: Pick<PluginContext, 'capabilities'>,
  task: z.input<typeof taskSchema>,
) {
  return ctx.capabilities.provide('core.inference.tasks@1', task.id, task.label, () =>
    taskSchema.parse(task),
  );
}
export class InferenceCatalog {
  readonly life = new AbortController();
  readonly owner: CapabilityOwner = {
    id: 'core',
    permissions: new Set(['*']),
    signal: this.life.signal,
  };
  private adapterCache = new Map<string, AdapterDescriptor & { owner: string }>();
  private taskCache = new Map<string, InferenceTask>();
  private revision = 0;
  private refreshing?: Promise<void>;
  private off: () => void;
  private catalogRequests = new Map<string, Promise<ModelListing[]>>();
  constructor(
    readonly store: Store,
    readonly capabilities: Capabilities,
    readonly changed: () => void = () => {},
  ) {
    capabilities.define(this.owner, {
      id: 'core.inference.models@1',
      description: 'Read model and reasoning metadata without running inference',
      input: z.object({ profile: profileSchema }),
      output: z.array(modelListingSchema).max(500),
      providePermission: 'inference.provide',
      consumePermission: 'inference.read',
      cardinality: 'one',
    });
    capabilities.define(this.owner, {
      id: 'core.inference.prepare-model@1',
      description: 'Validate local model artifacts without loading inference weights',
      input: z.object({
        model: z.string(),
        options: z.record(z.string(), z.unknown()),
        embedding: modelProfileSchema.shape.embedding,
      }),
      output: z.object({ model: z.string(), options: z.record(z.string(), z.unknown()) }),
      providePermission: 'inference.contribute',
      consumePermission: 'inference.read',
      cardinality: 'one',
    });
    for (const [name, output] of [
      ['adapters', adapterSchema],
      ['tasks', taskSchema],
      ['kinds', modelKindSchema],
    ] as const)
      capabilities.define(this.owner, {
        id: `core.inference.${name}@1`,
        description: `Inference ${name}`,
        input: z.object({}),
        output,
        providePermission: 'inference.contribute',
        consumePermission: 'inference.read',
        cardinality: 'many',
      });
    capabilities.provide(
      this.owner,
      'core.inference.tasks@1',
      inferenceTasks.chat,
      'Conversation',
      () => ({
        id: inferenceTasks.chat,
        label: '会话生成',
        scope: 'character',
        operation: 'generate',
        inputs: ['text'],
        description: '',
      }),
    );
    capabilities.provide(
      this.owner,
      'core.inference.kinds@1',
      'core.language',
      '语言与视觉模型',
      () => ({
        id: 'core.language',
        label: '语言与视觉模型',
        operation: 'generate',
        capability: 'generation',
        order: 0,
      }),
    );
    let shape = '';
    this.off = capabilities
      .forOwner(this.owner, () => {})
      .subscribe(() => {
        const next = JSON.stringify(
          capabilities
            .list()
            .filter((p) =>
              ['core.inference.adapters@1', 'core.inference.tasks@1'].includes(p.point),
            ),
        );
        if (next === shape) return;
        shape = next;
        void this.refresh()
          .then(() => this.changed())
          .catch(() => {});
      });
  }
  async refresh() {
    this.revision++;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      let revision: number;
      do {
        revision = this.revision;
        const adapters = new Map<string, AdapterDescriptor & { owner: string }>();
        for (const p of this.capabilities
          .list('core.inference.adapters@1')
          .filter((p) => p.state === 'active')) {
          try {
            const d = adapterSchema.parse(
              await this.capabilities.invoke(this.owner, p.point, p.id, {}),
            );
            invariant(d.id === p.id, 'adapter_identity', '接入器编号必须与提供项一致');
            invariant(
              d.presets.every((template) => template.id.startsWith(p.owner + '.')),
              'adapter_preset_owner',
              '模型模板必须属于提供它的插件',
            );
            invariant(
              [
                d.generationProvider,
                d.embeddingProvider,
                d.rerankingProvider,
                d.prepareModelProvider,
                d.modelCatalogProvider,
              ]
                .filter(Boolean)
                .every((id) => id!.startsWith(p.owner + '.')),
              'adapter_provider_owner',
              '推理提供项必须属于同一插件',
            );
            adapters.set(p.id, { ...d, owner: p.owner });
          } catch {}
        }
        this.adapterCache = adapters;
        this.taskCache = new Map((await this.loadTasks()).map((task) => [task.id, task]));
      } while (revision !== this.revision && !this.life.signal.aborted);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  adapter(id: string) {
    const d = this.adapterCache.get(id);
    invariant(
      d &&
        this.capabilities
          .list('core.inference.adapters@1')
          .some((p) => p.id === id && p.state === 'active'),
      'adapter_unavailable',
      '推理接入器当前不可用：' + id,
    );
    return d;
  }
  adapters() {
    return [...this.adapterCache.values()].filter((d) =>
      this.capabilities
        .list('core.inference.adapters@1')
        .some((p) => p.id === d.id && p.state === 'active'),
    );
  }
  async kinds() {
    const items = [];
    for (const provider of this.capabilities
      .list('core.inference.kinds@1')
      .filter((p) => p.state === 'active')) {
      const value = modelKindSchema.parse(
        await this.capabilities.invoke(this.owner, provider.point, provider.id, {}),
      );
      invariant(value.id === provider.id, 'model_kind_identity', '模型分类编号不匹配');
      items.push({ ...value, owner: provider.owner });
    }
    return items.sort((a, b) => a.order - b.order);
  }
  async tasks() {
    const result = await this.loadTasks();
    this.taskCache = new Map(result.map((task) => [task.id, task]));
    return result;
  }
  private async loadTasks() {
    const result: InferenceTask[] = [];
    for (const p of this.capabilities
      .list('core.inference.tasks@1')
      .filter((p) => p.state === 'active')) {
      try {
        const d = taskSchema.parse(await this.capabilities.invoke(this.owner, p.point, p.id, {}));
        invariant(d.id === p.id, 'task_identity', '任务编号必须与提供项一致');
        result.push({ ...d, owner: p.owner });
      } catch {}
    }
    return result;
  }
  task(id: string) {
    return this.taskCache.get(id);
  }
  models() {
    return this.store.documents<ModelProfile>('profiles');
  }
  connections() {
    return this.store.documents<Connection>('connections');
  }
  references(profileId: string) {
    const result: { id: string; kind: string; label: string }[] = [];
    for (const conversation of this.store.conversations())
      if (this.store.binding(conversation.id)?.profileId === profileId)
        result.push({ id: conversation.id, kind: 'conversation', label: conversation.title });
    const contains = (value: unknown): boolean =>
      typeof value === 'string'
        ? value === profileId
        : Array.isArray(value)
          ? value.some(contains)
          : value !== null && typeof value === 'object'
            ? Object.values(value).some(contains)
            : false;
    const configurations = this.store.db
      .prepare(
        "SELECT key,value FROM kv WHERE key='routes' OR key LIKE '%.config' OR key LIKE '%.tasks' OR key LIKE '%.rules'",
      )
      .all() as { key: string; value: string }[];
    for (const row of configurations)
      if (contains(JSON.parse(row.value)))
        result.push({ id: row.key, kind: 'configuration', label: row.key });
    const roleSettings = this.store.db
      .prepare(
        "SELECT namespace,id,data FROM documents WHERE namespace='characters' OR namespace LIKE 'character-settings.%'",
      )
      .all() as { namespace: string; id: string; data: string }[];
    for (const row of roleSettings)
      if (contains(JSON.parse(row.data)))
        result.push({
          id: row.namespace + ':' + row.id,
          kind: 'character',
          label: this.store.document<{ name: string }>('personas', row.id)?.name ?? row.id,
        });
    return result;
  }
  connectionProfile(connectionId: string, model = ''): Profile {
    const connection = this.connections().find((item) => item.id === connectionId);
    invariant(connection, 'missing_connection', '连接不存在。');
    const adapter = this.adapter(connection.adapterId);
    return profileSchema.parse({
      ...connection.config,
      id: connection.id,
      name: connection.name,
      connectionId,
      adapterId: adapter.id,
      kind: adapter.engine,
      model,
    });
  }
  private catalogKey(profile: Profile) {
    const { reasoningSupport: _support, ...configuration } = profile;
    // Key by connection settings and requested model; never reuse facts after an
    // endpoint, credential reference, protocol, host command or plugin changes.
    const connection = this.connections().find((item) => item.id === profile.connectionId);
    const provider = this.adapter(profile.adapterId!).modelCatalogProvider;
    return (
      'inference.catalog.' +
      createHash('sha256')
        .update(
          JSON.stringify({
            connection,
            provider,
            instance: provider
              ? this.capabilities.instanceKey('core.inference.models@1', provider)
              : undefined,
            model: profile.model,
            ...(connection ? {} : { configuration }),
          }),
        )
        .digest('hex')
    );
  }
  async discover(profile: Profile, refresh = false, signal?: AbortSignal): Promise<ModelListing[]> {
    signal?.throwIfAborted();
    const adapter = this.adapter(profile.adapterId!);
    if (!adapter.modelCatalogProvider) return [];
    invariant(
      this.capabilities
        .list('core.inference.models@1')
        .some((item) => item.id === adapter.modelCatalogProvider && item.state === 'active'),
      'model_catalog_unavailable',
      '模型目录提供项当前不可用。',
    );
    const key = this.catalogKey(profile);
    const cached = this.store.get<{ at: number; models: ModelListing[] } | undefined>(
      key,
      undefined,
    );
    if (!refresh && cached && Date.now() - cached.at < 300_000) return cached.models;
    const pending = this.catalogRequests.get(key);
    if (pending) return this.waitForCatalog(pending, signal);
    const task = (async () => {
      const models = z
        .array(modelListingSchema)
        .max(500)
        .parse(
          await this.capabilities.invoke(
            this.owner,
            'core.inference.models@1',
            adapter.modelCatalogProvider!,
            { profile },
            this.life.signal,
          ),
        );
      // Recheck ownership/liveness: a late response cannot revive a disabled plugin.
      invariant(this.catalogKey(profile) === key, 'adapter_unavailable', '模型目录提供项已改变。');
      this.store.set(key, { at: Date.now(), models });
      return models;
    })().finally(() => this.catalogRequests.delete(key));
    this.catalogRequests.set(key, task);
    return this.waitForCatalog(task, signal);
  }
  private async waitForCatalog(task: Promise<ModelListing[]>, signal?: AbortSignal) {
    if (!signal) return task;
    signal.throwIfAborted();
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  private cachedReasoning(profile: Profile) {
    const cached = this.store.get<{ models: ModelListing[] } | undefined>(
      this.catalogKey(profile),
      undefined,
    );
    return effectiveReasoning(
      profile,
      cached?.models.find((item) => item.id === profile.model)?.reasoning,
    );
  }
  async prepare(profile: Profile, override?: string, signal?: AbortSignal): Promise<Profile> {
    signal?.throwIfAborted();
    const requested = !override || override === 'inherit' ? profile.reasoning : override;
    if (requested === 'inherit') return profile;
    try {
      const rows = await this.discover(profile, false, signal);
      return {
        ...profile,
        reasoningSupport: effectiveReasoning(
          profile,
          rows.find((row) => row.id === profile.model)?.reasoning,
        ),
      };
    } catch {
      signal?.throwIfAborted();
      // Model discovery is advisory and has no generation side effects. A missing
      // catalog must not turn an explicitly configured manual API into an outage.
      return profile;
    }
  }
  resolve(id: string): Profile {
    const raw = this.store.document('profiles', id);
    invariant(raw, 'missing_profile', '未配置模型：' + id);
    const model = modelProfileSchema.parse(raw),
      connection = this.store.document<Connection>('connections', model.connectionId);
    invariant(connection, 'missing_connection', '模型使用的连接不存在');
    const adapter = this.adapter(connection.adapterId);
    const config = z
      .fromJSONSchema(adapter.connectionSchema as any)
      .parse(connection.config) as Record<string, unknown>;
    const options = z.fromJSONSchema(adapter.modelSchema as any).parse(model.options);
    const profile = profileSchema.parse({
      ...config,
      ...model,
      adapterId: connection.adapterId,
      kind: adapter.engine,
      apiKeyRef: config.apiKeyRef ?? '',
      vision: model.generation.enabled && model.generation.inputs.includes('image'),
      modelOptions: options,
      reasoningLevels: model.reasoningLevels,
      embeddingDimensions: model.embedding.dimensions,
    });
    profile.reasoningSupport = this.cachedReasoning(profile);
    return profile;
  }
  compatible(model: ModelProfile, task: InferenceTask) {
    return this.supports(model, task, task.id === inferenceTasks.review);
  }
  /** One selection policy for saving routes, executing requests and projecting UI choices. */
  supports(
    model: ModelProfile,
    task: Pick<InferenceTask, 'operation' | 'inputs'>,
    allowWorker = false,
  ) {
    try {
      const profile = this.resolve(model.id);
      return this.matches(model, this.adapter(profile.adapterId!), task, allowWorker);
    } catch {
      return false;
    }
  }
  private matches(
    model: ModelProfile,
    adapter: AdapterDescriptor,
    task: Pick<InferenceTask, 'operation' | 'inputs'>,
    allowWorker: boolean,
  ) {
    const declared =
        task.operation === 'generate'
          ? model.generation
          : task.operation === 'embed'
            ? model.embedding
            : model.reranking,
      supported =
        task.operation === 'generate'
          ? adapter.generation
          : task.operation === 'embed'
            ? adapter.embedding
            : (adapter.reranking ?? []);
    return (
      (!adapter.workerOnly || allowWorker) &&
      !!declared?.enabled &&
      task.inputs.every((m) => declared.inputs.includes(m) && supported.includes(m))
    );
  }
  eligibility(model: ModelProfile) {
    try {
      const profile = this.resolve(model.id),
        adapter = this.adapter(profile.adapterId!);
      const activeTasks = new Set(
        this.capabilities
          .list('core.inference.tasks@1')
          .filter((p) => p.state === 'active')
          .map((p) => p.id),
      );
      const generation = { operation: 'generate' as const, inputs: ['text' as const] };
      return {
        conversation: this.matches(model, adapter, generation, false),
        worker: this.matches(model, adapter, generation, true),
        tasks: [...this.taskCache.values()]
          .filter(
            (task) =>
              activeTasks.has(task.id) &&
              this.matches(model, adapter, task, task.id === inferenceTasks.review),
          )
          .map((task) => task.id),
      };
    } catch {
      return { conversation: false, worker: false, tasks: [] };
    }
  }
  async saveConnection(raw: unknown) {
    await this.refresh();
    const value = connectionSchema.parse(raw),
      adapter = this.adapter(value.adapterId);
    value.config = z.fromJSONSchema(adapter.connectionSchema as any).parse(value.config) as Record<
      string,
      unknown
    >;
    if (adapter.family === 'api') {
      let url: URL;
      try {
        url = new URL(String(value.config.endpoint));
      } catch {
        throw Error('请填写有效的 API Base URL');
      }
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      invariant(
        url.protocol === 'https:' || (url.protocol === 'http:' && loopback),
        'insecure_endpoint',
        '远程 API 需要 HTTPS；本机接口可用 HTTP',
      );
      invariant(
        value.deployment !== 'local' || loopback,
        'deployment_mismatch',
        '本机部署应使用回环地址；其他服务器请选择 API 连接',
      );
    }
    const old = this.store.document<Connection>('connections', value.id);
    const bound = this.models().filter((p) => p.connectionId === value.id);
    invariant(value.config.protocol !== 'anthropic-messages' ||
      !bound.some((model) => model.embedding.enabled || model.reranking?.enabled),
      'protocol_capability', 'Anthropic Messages 连接只支持生成。请将向量或重排模型放在单独的连接。');
    invariant(
      !old || old.adapterId === value.adapterId || !bound.length,
      'connection_in_use',
      '先移除或迁移连接下的模型，再更换接入器',
    );
    invariant(
      !this.store.unresolved().some((r) => bound.some((p) => p.id === r.profileId)),
      'backend_busy',
      '此连接仍有未核对的运行',
    );
    this.store.put('connections', value.id, value);
    return value;
  }
  async saveModel(raw: unknown) {
    await this.refresh();
    const value = modelProfileSchema.parse(raw),
      connection = this.connections().find((c) => c.id === value.connectionId);
    invariant(connection, 'missing_connection', '请先选择连接');
    const adapter = this.adapter(connection.adapterId),
      tasks = await this.tasks();
    invariant(connection.config.protocol !== 'anthropic-messages' ||
      (!value.embedding.enabled && !value.reranking?.enabled),
      'protocol_capability', 'Anthropic Messages 连接只支持生成。请将向量或重排模型放在单独的连接。');
    invariant(
      adapter.family === 'harness' || value.model.trim(),
      'missing_model',
      '请填写模型 ID 或本地模型路径',
    );
    const old = this.store.document<ModelProfile>('profiles', value.id);
    for (const [operation, capability] of [
      ['generate', value.generation],
      ['embed', value.embedding],
      ['rerank', value.reranking],
    ] as const) {
      if (!capability?.enabled) continue;
      invariant(
        tasks.some((t) => t.operation === operation) ||
          (operation === 'embed' && JSON.stringify(old?.embedding) === JSON.stringify(capability)),
        'task_unavailable',
        '对应推理能力插件尚未启用',
      );
      const supported =
        operation === 'generate'
          ? adapter.generation
          : operation === 'embed'
            ? adapter.embedding
            : (adapter.reranking ?? []);
      invariant(
        capability.inputs.every((m) => supported.includes(m)),
        'modality_unsupported',
        '此接入器未实现所选输入模态',
      );
    }
    invariant(
      value.generation.enabled || value.embedding.enabled || value.reranking?.enabled,
      'model_capability',
      '至少启用一种模型能力',
    );
    value.options = z.fromJSONSchema(adapter.modelSchema as any).parse(value.options) as Record<
      string,
      unknown
    >;
    if (adapter.prepareModelProvider) {
      const prepared = (await this.capabilities.invoke(
        this.owner,
        'core.inference.prepare-model@1',
        adapter.prepareModelProvider,
        { model: value.model, options: value.options, embedding: value.embedding },
        this.life.signal,
      )) as { model: string; options: Record<string, unknown> };
      value.model = prepared.model;
      value.options = z
        .fromJSONSchema(adapter.modelSchema as any)
        .parse(prepared.options) as Record<string, unknown>;
    }
    invariant(
      !this.store.unresolved().some((r) => r.profileId === value.id),
      'backend_busy',
      '请先处理此模型的运行',
    );
    this.store.put('profiles', value.id, value);
    return value;
  }
  fingerprint(profileId: string) {
    const model = this.store.document<ModelProfile>('profiles', profileId);
    invariant(model, 'missing_profile', '模型不存在');
    const connection = this.store.document<Connection>('connections', model.connectionId);
    invariant(connection, 'missing_connection', '连接不存在');
    const adapter = this.adapter(connection.adapterId);
    const identity = adapter.modelIdentityField
      ? model.options[adapter.modelIdentityField]
      : model.model;
    invariant(identity, 'model_identity', '本地模型尚未校验，请重新保存模型配置');
    const options = adapter.embeddingIdentityFields
      ? Object.fromEntries(adapter.embeddingIdentityFields.map((key) => [key, model.options[key]]))
      : model.options;
    return createHash('sha256')
      .update(
        JSON.stringify([
          connection.adapterId,
          connection.config.endpoint,
          identity,
          { dimensions: model.embedding.dimensions },
          options,
        ]),
      )
      .digest('hex');
  }
  close() {
    this.life.abort();
    this.off();
  }
}
