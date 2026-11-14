import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ingestionPolicy,
  contentPolicy,
  type IngestionPolicy,
} from '../../packages/contracts/ingestion.ts';
import { ingestionHash } from '../../packages/kernel/artifact-identity.ts';
import { invariant } from '../../packages/contracts/index.ts';
import { openPortableIndex, documentKey } from './portable-index.ts';
import { workerTask } from '../../packages/kernel/worker-task.ts';
import type { PluginContext } from '../../packages/kernel/registry.ts';
import type { SearchRecord } from '../../packages/kernel/retrieval.ts';
import type { Knowledge } from '../knowledge/index.ts';
import type { SemanticSearch } from './index.ts';
import { inferenceTasks } from '../../packages/contracts/inference.ts';
import { contributeJobs } from '../../packages/kernel/jobs.ts';
type Binding = {
  space: string;
  modelId: string;
  fingerprint: string;
  versions: Record<string, string>;
  jobId: string;
  policy: IngestionPolicy;
};

/** Side-by-side index generations. Query encoders follow the active index, not a pending default. */
export class IndexGenerations {
  private running?: { id: string; controller: AbortController; promise: Promise<void> };
  private life?: AbortSignal;
  private maintenance = false;
  private draining = false;
  private drainTask?: Promise<void>;
  constructor(
    readonly semantic: SemanticSearch,
    readonly knowledge: Knowledge,
  ) {}
  private get store() {
    return this.semantic.store;
  }
  private modelFingerprint(id: string) {
    const model = this.semantic.router.inference.models().find((m) => m.id === id);
    return ingestionHash([this.semantic.router.inference.fingerprint(id), model?.options.videoFps]);
  }
  bindings() {
    return this.store.get<Record<string, Binding>>('semantic.active-generations', {});
  }
  private hydrated(id: string) {
    const saved = this.store.document<any>('knowledge-migrations', id);
    if (!saved) return undefined;
    const plan = this.store.document<any>('knowledge-migration-plans', saved.planId);
    invariant(plan, 'migration_plan', '迁移计划不存在');
    return {
      ...plan,
      ...saved,
      documents: plan.documents.map((d: any) => ({
        ...d,
        ...this.store.document<any>(
          'knowledge-migration-items',
          ingestionHash([id, d.vaultId, d.id]),
        ),
      })),
    };
  }
  async coverage(records: SearchRecord[]) {
    const bindings = this.bindings();
    const heads = new Map(
      (await this.knowledge.list()).map((d) => [
        documentKey({ vaultId: d.vaultId, documentId: d.id }),
        d.version,
      ]),
    );
    return new Set(
      records
        .filter((r) => {
          const b = bindings[documentKey(r)];
          return b && heads.get(documentKey(r)) === b.versions[r.documentId!];
        })
        .map((r) => r.id),
    );
  }
  model(policy: IngestionPolicy) {
    const catalog = this.semantic.router.inference;
    const model = catalog
      .models()
      .find(
        (m) => m.id === (policy.modelId || this.semantic.router.route(inferenceTasks.embedding).id),
      );
    invariant(model?.embedding.enabled, 'embedding_missing', '请选择可用的语义索引模型');
    return model;
  }
  async plan(v: {
    vaultIds: string[];
    documentIds?: string[];
    policy?: IngestionPolicy;
    refreshParsing?: boolean;
  }) {
    const policy = ingestionPolicy.parse(v.policy ?? this.knowledge.pipeline.policy());
    const model = this.model(policy);
    const vaultIds = [...new Set(v.vaultIds)];
    invariant(
      vaultIds.length > 0 &&
        vaultIds.every((id) => this.knowledge.files.roots().some((r) => r.id === id)),
      'vault_missing',
      '请选择已注册的知识库',
    );
    const documents: any[] = [];
    const needed = new Set<'image' | 'audio' | 'video'>();
    for (const vaultId of vaultIds)
      for (const entry of await this.knowledge.list(vaultId)) {
        this.life?.throwIfAborted();
        if (entry.metadata.archived || entry.metadata.sourceUnavailable) continue;
        if (v.documentIds && !v.documentIds.includes(entry.id)) continue;
        const doc = await this.knowledge.read(entry.id, 0, 1, vaultId);
        if (String(doc.original?.mediaType ?? '').startsWith('audio/')) needed.add('audio');
        if (String(doc.original?.mediaType ?? '').startsWith('video/')) {
          needed.add('audio');
          needed.add('video');
        }
        if (
          String(doc.original?.mediaType ?? '').startsWith('image/') ||
          (doc.attachments as any[]).some((a) => a.mediaType?.startsWith('image/'))
        )
          needed.add('image');
        let parse = 'reuse',
          reason = '复用已保存的正文、附件和转录',
          parsePlan: any;
        if (v.refreshParsing && doc.original && doc.sourceHash && doc.sourceFileId) {
          if (doc.metadata.producer) {
            parse = 'blocked';
            reason = '原件由所属插件维护，请通过来源插件重新解析';
          } else {
            const parser = await this.knowledge.pipeline.parser(doc.original as any, policy);
            if (!parser) {
              parse = 'blocked';
              reason = '目标解析器不可用';
            } else {
              const db = await this.knowledge.files.database(vaultId);
              const originalBody = doc.parsing
                ? (db.db
                    .prepare('SELECT body FROM entry_revisions WHERE entry_id=? AND revision=?')
                    .get(entry.id, doc.parsing.revision) as any)
                : undefined;
              const body = db.db
                .prepare('SELECT body FROM entries WHERE id=?')
                .get(entry.id) as any;
              if (!doc.parsing) {
                reason = '旧解析来源未记录，复用现有正文；可在条目中明确重解析';
              } else {
                const original = await this.knowledge.files.original(
                  vaultId,
                  doc.sourceFileId,
                  doc.sourceHash,
                );
                const next = await this.knowledge.files.parsers.freeze(
                  parser,
                  original,
                  'preview-' + randomUUID(),
                );
                const identity = (p: any) => {
                  const { model, ...provenance } = p.provenance ?? {};
                  return {
                    id: p.parser.id,
                    version: p.parser.version,
                    provenance: provenance.modelSha256 ? provenance : { model, ...provenance },
                  };
                };
                if (ingestionHash(identity(next)) !== ingestionHash(identity(doc.parsing))) {
                  if (originalBody && originalBody.body !== body.body) {
                    parse = 'blocked';
                    reason = '正文含人工修改，请先在条目中确认重解析';
                  } else {
                    parse = 'reparse';
                    parsePlan = next;
                    reason = '解析配置已改变，仅更新受影响的原件';
                  }
                } else reason = '解析配置未改变，复用现有正文和转录';
              }
            }
          }
        }
        documents.push({
          vaultId,
          id: entry.id,
          title: entry.title,
          version: entry.version,
          revision: entry.revision,
          parse,
          reason,
          ...(parsePlan ? { parsePlan } : {}),
        });
      }
    const fingerprint = this.modelFingerprint(model.id);
    const mediaPlans: Record<string, unknown> = {};
    for (const modality of needed)
      if (policy.modalities.includes(modality) && model.embedding.inputs.includes(modality))
        mediaPlans[modality] = await this.knowledge.files.parsers.freezeMedia(
          modality,
          modality === 'image' ? policy.imageProcessor : policy.mediaProcessor,
        );
    const value = {
      format: 'echo-migration-plan-v1',
      vaultIds,
      policy,
      modelId: model.id,
      fingerprint,
      documents,
      unsupported: policy.modalities.filter((m) => !model.embedding.inputs.includes(m)),
      reuseParsing: documents.filter((d) => d.parse === 'reuse').length,
      reparse: documents.filter((d) => d.parse === 'reparse').length,
      blocked: documents.filter((d) => d.parse === 'blocked').length,
      previousBindings: this.bindings(),
      mediaPlans,
    };
    const id = ingestionHash(value);
    this.store.put('knowledge-migration-plans', id, value);
    return { ...value, id };
  }
  async start(planId: string, requestId: string) {
    const old = this.store.document<any>('knowledge-migrations', requestId);
    if (old) {
      invariant(old.planId === planId, 'idempotency_conflict', '请求编号已用于其他迁移');
      return old;
    }
    const plan = this.store.document<any>('knowledge-migration-plans', planId);
    invariant(plan && !plan.blocked, 'migration_plan', '请重新预览并处理被阻塞的条目');
    invariant(!this.running, 'index_busy', '已有入库流程迁移正在执行');
    const job = {
      ...plan,
      id: requestId,
      planId,
      state: 'queued',
      phase: 'preparing',
      completed: 0,
      vectors: 0,
      createdAt: new Date().toISOString(),
      space: 'generation-' + randomUUID(),
    };
    const { documents, previousBindings, ...record } = job;
    this.store.put('knowledge-migrations', job.id, { ...record, total: documents.length });
    this.launch(job.id);
    return job;
  }
  private launch(id: string) {
    invariant(this.life && !this.life.aborted && !this.running, 'index_busy', '索引迁移不可运行');
    const controller = new AbortController();
    const signal = AbortSignal.any([this.life!, controller.signal]);
    const promise = this.execute(id, signal).finally(() => {
      this.running = undefined;
      queueMicrotask(() => void this.drain());
    });
    this.running = { id, controller, promise };
  }
  pause() {
    this.running?.controller.abort();
    return this.running?.promise;
  }
  private drain() {
    if (this.drainTask) return this.drainTask;
    this.drainTask = this.drainQueue().finally(() => {
      this.drainTask = undefined;
      if (
        this.life &&
        !this.life.aborted &&
        !this.running &&
        !this.maintenance &&
        this.store.documents<any>('knowledge-index-queue').some((j) => j.state === 'queued')
      )
        queueMicrotask(() => void this.drain());
    });
    return this.drainTask;
  }
  private async drainQueue() {
    if (!this.life || this.life.aborted || this.running || this.maintenance || this.draining)
      return;
    const queued = this.store
      .documents<any>('knowledge-index-queue')
      .find((j) => j.state === 'queued');
    if (!queued) return;
    this.draining = true;
    this.store.put('knowledge-index-queue', queued.id, { ...queued, state: 'submitted' });
    try {
      const plan = await this.plan({
        vaultIds: [queued.vaultId],
        documentIds: [queued.documentId],
      });
      if (this.maintenance || this.life.aborted) {
        this.store.put('knowledge-index-queue', queued.id, { ...queued, state: 'queued' });
        return;
      }
      await this.start(plan.id, queued.id);
      this.store.put('knowledge-index-queue', queued.id, { ...queued, state: 'submitted' });
    } catch (e) {
      this.store.put('knowledge-index-queue', queued.id, {
        ...queued,
        state: 'failed',
        error: String((e as Error).message),
      });
    } finally {
      this.draining = false;
    }
  }
  private async execute(id: string, signal: AbortSignal) {
    let job = this.hydrated(id);
    const db = openPortableIndex(this.semantic.portableIndexPath);
    const save = () => {
      const { documents, previousBindings, ...record } = job;
      this.store.put('knowledge-migrations', id, { ...record, total: documents.length });
      this.semantic.events.emit('semantic.updated', { jobId: id });
    };
    try {
      job.vectors = Number(
        (db.prepare('SELECT count(*) AS n FROM vectors WHERE space=?').get(job.space) as any).n,
      );
      job.state = 'running';
      job.error = undefined;
      save();
      invariant(
        this.modelFingerprint(job.modelId) === job.fingerprint,
        'model_changed',
        '模型配置已变化，请重新预览迁移',
      );
      const model = this.model({ ...job.policy, modelId: job.modelId });
      db.prepare('INSERT OR IGNORE INTO spaces VALUES(?,?,?)').run(
        job.space,
        model.embedding.dimensions ?? 0,
        JSON.stringify({ fingerprint: job.fingerprint, policy: contentPolicy(job.policy) }),
      );
      for (let i = job.completed; i < job.documents.length; i++) {
        signal.throwIfAborted();
        const item = job.documents[i];
        let doc = await this.knowledge.files.entries.find(item.id, item.vaultId);
        const parseId = id + '-parse-' + ingestionHash([item.vaultId, item.id]).slice(0, 16);
        if (item.parse === 'reparse') {
          const library = await this.knowledge.files.database(item.vaultId);
          const committed = library.db
            .prepare('SELECT revision FROM parse_generations WHERE job_id=? AND entry_id=?')
            .get(parseId, item.id) as any;
          if (committed && doc.revision === committed.revision) {
            item.version = doc.version;
            item.revision = doc.revision;
            item.parse = 'reuse';
            this.store.put(
              'knowledge-migration-items',
              ingestionHash([id, item.vaultId, item.id]),
              { version: item.version, revision: item.revision, parse: 'reuse' },
            );
          }
        }
        invariant(
          doc.version === item.version,
          'migration_stale',
          '迁移期间条目已变化，请重新预览；旧索引仍然生效',
        );
        if (item.parse === 'reparse') {
          job.phase = 'parsing';
          save();
          const parser = await this.knowledge.pipeline.parser(
            (await this.knowledge.read(item.id, 0, 1, item.vaultId)).original as any,
            job.policy,
          );
          const parsing = await this.knowledge.reparse({
            vaultId: item.vaultId,
            id: item.id,
            revision: item.revision,
            requestId: parseId,
            parserProvider: parser!.id,
            plan: item.parsePlan,
          });
          if (['paused', 'failed'].includes(parsing.state))
            void this.knowledge.continueImport(parsing.id);
          await this.knowledge.waitImport(parsing.id, signal);
          invariant(
            this.store.document<any>('knowledge-jobs', parsing.id)?.state === 'completed',
            'parse_failed',
            '原件解析未完成，请核对后续跑',
          );
          doc = await this.knowledge.files.entries.find(item.id, item.vaultId);
          item.version = doc.version;
          item.revision = doc.revision;
          item.parse = 'reuse';
          this.store.put('knowledge-migration-items', ingestionHash([id, item.vaultId, item.id]), {
            version: item.version,
            revision: item.revision,
            parse: item.parse,
          });
          save();
        }
        job.phase = 'indexing';
        save();
        const graph = await this.knowledge.pipeline.graph(
          item.vaultId,
          item.id,
          job.policy,
          signal,
        );
        const bodyHash = ingestionHashText(graph.document.content);
        const previous = db
          .prepare('SELECT body_hash FROM documents WHERE space=? AND vault_id=? AND document_id=?')
          .get(job.space, item.vaultId, item.id) as any;
        invariant(
          !previous || previous.body_hash === bodyHash,
          'migration_stale',
          '待建索引正文已变化',
        );
        db.prepare('INSERT OR IGNORE INTO documents VALUES(?,?,?,?)').run(
          job.space,
          item.vaultId,
          item.id,
          bodyHash,
        );
        for (const node of graph.nodes) {
          if (
            !['text', 'image', 'audio', 'video'].includes(node.kind) ||
            !model.embedding.inputs.includes(node.kind as any)
          )
            continue;
          signal.throwIfAborted();
          if (
            db
              .prepare('SELECT 1 FROM vectors WHERE space=? AND vault_id=? AND node_id=?')
              .get(job.space, item.vaultId, node.id)
          )
            continue;
          const content =
            node.kind === 'text'
              ? { type: 'text' as const, text: graph.document.title + '\n' + node.text }
              : await this.knowledge.files.parsers.encodeMedia(
                  {
                    vaultId: item.vaultId,
                    sourceHash: node.sourceHash!,
                    modality: node.kind,
                    start: node.start ?? 0,
                    end: node.end,
                  },
                  signal,
                  job.mediaPlans[node.kind],
                );
          const [vector] = await this.semantic.embeddingsService.encode(
            model.id,
            [{ content: [content] }],
            'document',
            signal,
          );
          const dimension = (
            db.prepare('SELECT dimension FROM spaces WHERE fingerprint=?').get(job.space) as any
          ).dimension;
          if (!dimension)
            db.prepare('UPDATE spaces SET dimension=? WHERE fingerprint=?').run(
              vector.length,
              job.space,
            );
          else
            invariant(
              dimension === vector.length,
              'embedding_output',
              '向量维度变化，尚未切换索引',
            );
          signal.throwIfAborted();
          invariant(
            this.modelFingerprint(model.id) === job.fingerprint,
            'model_changed',
            '模型配置已变化，旧索引保持生效',
          );
          const parent = graph.nodes.find((p: any) => p.id === node.parentId);
          db.prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?,?,?,?)').run(
            job.space,
            item.vaultId,
            item.id,
            node.id,
            node.kind,
            node.parentId ?? null,
            node.text,
            Buffer.from(new Float32Array(vector).buffer),
            JSON.stringify({
              ...node,
              parent,
              entryVersion: doc.version,
              graphPolicy: graph.policyHash,
            }),
          );
          job.vectors++;
          if (job.vectors % 8 === 0) save();
        }
        job.completed = i + 1;
        save();
      }
      job.phase = 'validating';
      save();
      for (const item of job.documents)
        invariant(
          (await this.knowledge.files.entries.find(item.id, item.vaultId)).version === item.version,
          'migration_stale',
          '条目发生变更，请重新预览，尚未切换索引',
        );
      invariant(
        ingestionHash(this.bindings()) === ingestionHash(job.previousBindings),
        'index_changed',
        '当前索引已被其他操作切换，请重新预览',
      );
      signal.throwIfAborted();
      const bindings = this.bindings();
      for (const item of job.documents)
        bindings[documentKey({ vaultId: item.vaultId, documentId: item.id })] = {
          space: job.space,
          modelId: job.modelId,
          fingerprint: job.fingerprint,
          versions: { [item.id]: item.version },
          jobId: id,
          policy: job.policy,
        };
      this.store.transaction(() => {
        this.store.set('semantic.active-generations', bindings);
        job.state = 'completed';
        job.phase = 'active';
        job.finishedAt = new Date().toISOString();
        save();
      });
    } catch (e) {
      job.state = signal.aborted ? 'paused' : 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = signal.aborted ? undefined : String((e as Error).message);
      save();
    } finally {
      db.close();
    }
  }
  async rank(query: string, records: SearchRecord[], signal: AbortSignal) {
    const result: any[] = [],
      bindings = this.bindings();
    const groups = new Map<string, { binding: Binding; records: SearchRecord[] }>();
    for (const record of records) {
      const binding = bindings[documentKey(record)];
      if (!binding) continue;
      const key = binding.space + ':' + binding.modelId;
      if (!groups.has(key)) groups.set(key, { binding, records: [] });
      groups.get(key)!.records.push(record);
    }
    const heads = new Map(
      (await this.knowledge.list()).map((d) => [
        documentKey({ vaultId: d.vaultId, documentId: d.id }),
        d.version,
      ]),
    );
    for (const { binding, records: group } of groups.values()) {
      invariant(
        this.modelFingerprint(binding.modelId) === binding.fingerprint,
        'index_model_changed',
        '当前索引模型配置已变化，请迁移索引',
      );
      const candidates = new Map(
        group
          .filter(
            (r) => heads.get(documentKey(r)) === bindings[documentKey(r)].versions[r.documentId!],
          )
          .map((r) => [documentKey(r), r]),
      );
      if (!candidates.size) continue;
      const [vector] = await this.semantic.embeddingsService.encode(
        binding.modelId,
        [{ content: [{ type: 'text', text: query }] }],
        'query',
        signal,
      );
      const hits = await workerTask<any[]>(
        this.semantic.root,
        'semantic-search-worker',
        'plugins/semantic/search-worker.ts',
        {
          path: this.semantic.portableIndexPath,
          space: binding.space,
          vector,
          entries: [...candidates.values()].map((r) => ({
            vaultId: r.vaultId,
            documentId: r.documentId,
            bodyHash: r.bodyHash,
          })),
        },
        signal,
      );
      for (const hit of hits.filter((h) => h.score >= this.semantic.config().threshold)) {
        const record = candidates.get(hit.key)!;
        result.push({
          id: record.id,
          version: record.version,
          score: hit.score,
          method: 'semantic',
          text: hit.text,
          node: hit.node,
        });
      }
    }
    return result;
  }
  register(ctx: PluginContext) {
    this.life = ctx.signal;
    for (const j of this.store.documents<any>('knowledge-migrations'))
      if (['running', 'queued'].includes(j.state))
        this.store.put('knowledge-migrations', j.id, { ...j, state: 'paused' });
    ctx.dispose(async () => {
      await this.drainTask;
      await this.pause();
    });
    for (const queued of this.store.documents<any>('knowledge-index-queue'))
      if (queued.state === 'submitted' && !this.store.document('knowledge-migrations', queued.id))
        this.store.put('knowledge-index-queue', queued.id, { ...queued, state: 'queued' });
    ctx.dispose(
      this.semantic.events.subscribe((event) => {
        if (event.type === 'system.maintenance') {
          this.maintenance = Boolean(event.data.paused);
          if (!this.maintenance) void this.drain();
        }
        if (
          event.type !== 'knowledge.import.completed' ||
          !this.knowledge.pipeline.policy().indexOnImport
        )
          return;
        const id = 'auto-' + String(event.data.jobId);
        if (!this.store.document('knowledge-index-queue', id))
          this.store.put('knowledge-index-queue', id, {
            id,
            state: 'queued',
            vaultId: event.data.vaultId,
            documentId: event.data.documentId,
          });
        void this.drain();
      }),
    );
    queueMicrotask(() => void this.drain());
    ctx.capabilities.provide('core.ui.badges@1', 'semantic.badges', '索引迁移提醒', () =>
      this.store
        .documents<any>('knowledge-migrations')
        .filter((j) => ['failed', 'completed'].includes(j.state))
        .map((j) => ({
          id: 'semantic.' + j.id + '.' + j.state,
          page: 'knowledge',
          at: j.finishedAt ?? j.createdAt,
        })),
    );
    contributeJobs(
      ctx,
      'semantic.migrations',
      '入库流程迁移',
      () =>
        this.store.documents<any>('knowledge-migrations').map((j) => ({
          id: j.id,
          state: j.state,
          phase: j.phase,
          completed: j.completed,
          total: j.total,
          error: j.error,
          createdAt: j.createdAt,
          controls: ['running', 'queued'].includes(j.state)
            ? ['pause']
            : ['paused', 'failed'].includes(j.state)
              ? ['resume']
              : [],
        })),
      async (action, id) => {
        if (action === 'pause') await this.pause();
        else this.launch(id);
      },
    );
    const op = (name: string, input: z.ZodType, write: boolean, run: (v: any) => unknown) =>
      ctx.registry.register({
        name,
        owner: 'semantic',
        description: '管理可回滚的知识入库迁移',
        permission: write ? 'semantic.write' : 'semantic.read',
        mcp: false,
        input,
        output: z.unknown(),
        run,
      });
    op(
      'semantic.migration.plan',
      z.object({
        vaultIds: z.array(z.string()).min(1),
        documentIds: z.array(z.string()).optional(),
        policy: ingestionPolicy.optional(),
        refreshParsing: z.boolean().default(false),
      }),
      true,
      (v) => this.plan(v),
    );
    op(
      'semantic.migration.start',
      z.object({ planId: z.string(), requestId: z.string().min(1) }),
      true,
      (v) => this.start(v.planId, v.requestId),
    );
    op('semantic.migration.status', z.object({ id: z.string().optional() }), false, (v) => ({
      jobs: this.store.documents<any>('knowledge-migrations').filter((j) => !v.id || j.id === v.id),
      activeDocuments: Object.keys(this.bindings()).length,
    }));
    op('semantic.migration.pause', z.object({}), true, async () => {
      await this.pause();
      return { accepted: true };
    });
    op('semantic.migration.resume', z.object({ id: z.string() }), true, (v) => {
      const j = this.store.document<any>('knowledge-migrations', v.id);
      invariant(j && ['paused', 'failed'].includes(j.state), 'job_state', '此迁移不能续跑');
      this.launch(v.id);
      return { accepted: true };
    });
    op('semantic.migration.rollback', z.object({ id: z.string() }), true, (v) => {
      invariant(!this.running, 'index_busy', '请先暂停正在执行的迁移');
      const j = this.hydrated(v.id);
      invariant(j?.state === 'completed', 'job_state', '此迁移没有生效');
      const bindings = this.bindings();
      for (const item of j.documents) {
        const key = documentKey({ vaultId: item.vaultId, documentId: item.id });
        invariant(bindings[key]?.jobId === j.id, 'index_changed', '索引已再次更新');
        if (j.previousBindings[key]) bindings[key] = j.previousBindings[key];
        else delete bindings[key];
      }
      this.store.set('semantic.active-generations', bindings);
      return { restored: true };
    });
  }
}
import { createHash } from 'node:crypto';
function ingestionHashText(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
