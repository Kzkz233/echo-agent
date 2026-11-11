import { Events } from '../../packages/kernel/events.ts';
import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collectionRequest, collectionResult } from '../../packages/contracts/knowledge-collections.ts';
import { id, invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import type { Plugin, Caller } from '../../packages/kernel/registry.ts';
import {
  Retrieval,
  type KnowledgeScope,
  type SearchStrategy,
  type SearchQuery,
} from '../../packages/kernel/retrieval.ts';
import { logicalEntryPath } from '../files/entries.ts';
import { Files, type Vault } from '../files/index.ts';
import { workerTask } from '../../packages/kernel/worker-task.ts';
import { keywordCandidates, prepareKeywordIndex } from '../files/keyword-index.ts';
import { type ParsedDocument } from '../../packages/contracts/documents.ts';
import { documentTitle } from './title.ts';
import { registerRetrievalOptions } from './retrieval-options.ts';
import {
  entryPersona,
  ownPersona,
  type ResourceReader,
} from '../../packages/kernel/resource-access.ts';
export type { Vault } from '../files/index.ts';
export type { LibraryEntry as KnowledgeDocument } from '../files/entries.ts';
const configuration = z.object({
  strategy: z.enum(['keyword', 'semantic', 'hybrid']).default('keyword'),
  retrievalProvider: z.string().default(''),
  parserProvider: z.string().default('documents.local'),
});
const searchHitId = /^(\w[\w.-]{0,159}):(\w[\w.-]{0,159})\.c\.(\d{1,8})$/;
export class Knowledge {
  private tasks = new Map<string, Promise<void>>();
  private life?: AbortSignal;
  private tail: Promise<void> = Promise.resolve();
  private scope?: import('../../packages/kernel/registry.ts').PluginContext['capabilities'];
  constructor(
    readonly store: Store,
    readonly retrieval = new Retrieval(),
    readonly files = new Files(store),
    readonly project = '',
    readonly events?: Events,
  ) {}
  config() {
    return configuration.parse(this.store.get('knowledge.config', {}));
  }
  list(vaultId?: string, reader?: ResourceReader) {
    return this.files.entries.list(vaultId, reader);
  }
  private find(documentId: string, vaultId?: string) {
    return this.files.entries.find(documentId, vaultId);
  }
  async collections(vaultId: string, collectionId?: string, signal?: AbortSignal) {
    const point = 'knowledge.collections@1';
    const providers = this.scope?.list(point).filter((p) => p.state === 'active') ?? [];
    const responses = (await Promise.all(providers.map(async (provider) =>
      collectionResult.nullable().parse(await this.scope!.invoke(
        point, provider.id, { vaultId, collectionId }, signal,
      )),
    ))).filter((result) => result !== null);
    const matching = responses.filter((result) => result.documentIds !== undefined);
    invariant(!collectionId || matching.length === 1, 'knowledge_collection_missing', '当前分组不可用，请刷新后重新选择。');
    return {
      nodes: responses.flatMap((result) => result.nodes),
      documentIds: collectionId ? matching[0].documentIds : undefined,
    };
  }
  private async collectionScope<T extends KnowledgeScope>(filter: T, signal?: AbortSignal): Promise<T> {
    if (!filter.collectionId) return filter;
    invariant(filter.vaultId, 'knowledge_collection_scope', '按组检索时请选择知识库。');
    const { documentIds } = await this.collections(filter.vaultId, filter.collectionId, signal);
    const allowed = new Set(filter.documentIds);
    return {
      ...filter, collectionId: undefined,
      documentIds: filter.documentIds ? documentIds!.filter((id) => allowed.has(id)) : documentIds,
    };
  }
  async records(filter: KnowledgeScope = {}, reader?: ResourceReader) {
    return this.files.entries.records(await this.collectionScope(filter), reader);
  }
  async search(
    query: string,
    signal: AbortSignal,
    limit = 10,
    filter: KnowledgeScope & {
      strategy?: SearchStrategy;
      queries?: SearchQuery[];
      semanticWeight?: number;
      directoryBoost?: { folder: string; weight: number };
      rerank?: boolean;
    } = {},
    reader?: ResourceReader,
  ) {
    filter = await this.collectionScope(filter, signal);
    const strategy = filter.strategy ?? this.config().strategy;
    let documents = filter.documentIds;
    if (strategy === 'keyword') {
      documents = [];
      for (const vault of this.vaults().filter((v) => !filter.vaultId || v.id === filter.vaultId)) {
        const db = await this.files.database(vault.id),
          allowed = (
            db.db.prepare('SELECT id,kind,logical_path,metadata FROM entries').all() as any[]
          )
            .filter(
              (d) =>
                !JSON.parse(d.metadata).sourceUnavailable &&
                Boolean(JSON.parse(d.metadata).archived) === Boolean(filter.archived) &&
                (!filter.documentIds || filter.documentIds.includes(d.id)) &&
                (filter.kind === 'all' || d.kind === (filter.kind ?? 'knowledge')) &&
                (!filter.folder ||
                  (filter.folderExact
                    ? (d.logical_path ?? '').split('/').slice(0, -1).join('/') === filter.folder
                    : (d.logical_path ?? '').startsWith(filter.folder + '/'))),
            )
            .map((d) => d.id);
        documents.push(
          ...keywordCandidates(
            db,
            filter.queries?.length ? filter.queries.map((q) => q.text) : [query],
            allowed,
          ),
        );
      }
    }
    const records = await this.records({ ...filter, documentIds: documents }, reader),
      lookup = new Map(records.map((r) => [r.id, r]));
    if (!records.length) return [];
    const hits = await this.retrieval.search(
      'knowledge',
      filter.queries?.length ? filter.queries : [{ text: query, weight: 1 }],
      records,
      signal,
      strategy,
      filter.semanticWeight ?? 0.7,
    );
    let ranked = hits
      .map((h) => ({
        ...lookup.get(h.id)!,
        ...h,
        score:
          h.score *
          (filter.directoryBoost &&
          (lookup.get(h.id) as any)?.logicalPath?.startsWith(filter.directoryBoost.folder + '/')
            ? filter.directoryBoost.weight
            : 1),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(40, limit * 2));
    if (filter.rerank && ranked.length) {
      const provider = this.scope?.list('knowledge.rerank@1').find((p) => p.state === 'active');
      invariant(provider, 'rerank_missing', '请先启用语义检索增强并配置检索词模型后端。');
      const order = (await this.scope!.invoke(
        'knowledge.rerank@1',
        provider.id,
        { query, candidates: ranked.map((r) => ({ id: r.id, text: r.text.slice(0, 800) })) },
        signal,
      )) as string[];
      const priority = new Map(order.map((id, n) => [id, n]));
      ranked.sort((a, b) => (priority.get(a.id) ?? 1000) - (priority.get(b.id) ?? 1000));
    }
    // A source refresh can finish while this search awaits embeddings or a reranker.
    const current = await Promise.all(ranked.map(async (hit) => {
      if (!hit.vaultId || !hit.documentId) return true;
      const db = await this.files.database(hit.vaultId);
      return Boolean(db.db.prepare(
        "SELECT 1 FROM entries WHERE id=? AND json_extract(metadata,'$.sourceUnavailable') IS NULL",
      ).get(hit.documentId));
    }));
    return ranked.filter((_, i) => current[i]).slice(0, limit);
  }
  async maintain(v: {
    vaultId: string;
    items: { id: string; revision: number }[];
    action: 'move' | 'archive' | 'restore' | 'delete';
    folder?: string;
  }) {
    this.files.assertWrite(v.vaultId);
    const database = await this.files.database(v.vaultId),
      folder = logicalEntryPath(v.folder ?? '');
    prepareKeywordIndex(database);
    const result = database.transaction(() =>
      v.items.map((item) => {
        const row = database.db.prepare('SELECT * FROM entries WHERE id=?').get(item.id) as any;
        invariant(
          row && row.revision === item.revision,
          'revision_conflict',
          '条目已变化，请刷新后重试',
        );
        if (v.action === 'delete') {
          invariant(
            JSON.parse(row.metadata).archived,
            'knowledge_archive',
            '请先将条目移入归档，再永久删除',
          );
          database.db.prepare('DELETE FROM entries WHERE id=?').run(item.id);
          return { id: item.id, deleted: true };
        }
        const meta = JSON.parse(row.metadata);
        if (v.action !== 'move') meta.archived = v.action === 'archive';
        const path =
          v.action === 'move'
            ? [folder, (row.logical_path ?? item.id + '.md').split('/').at(-1)]
                .filter(Boolean)
                .join('/')
            : row.logical_path;
        const version = createHash('sha256')
            .update(JSON.stringify([row.title, row.body, meta, path]))
            .digest('hex'),
          at = new Date().toISOString(),
          revision = row.revision + 1;
        database.db
          .prepare(
            'UPDATE entries SET metadata=?,logical_path=?,revision=?,version=?,updated_at=? WHERE id=?',
          )
          .run(JSON.stringify(meta), path, revision, version, at, item.id);
        database.db
          .prepare('INSERT INTO entry_revisions VALUES(?,?,?,?,?,?,?)')
          .run(item.id, revision, row.title, row.body, JSON.stringify(meta), version, at);
        return { id: item.id, revision };
      }),
    );
    this.events?.emit('knowledge.updated', { vaultId: v.vaultId });
    return result;
  }
  async inspectSource(vaultId: string, documentId: string) {
    const doc = await this.find(documentId, vaultId);
    if (doc.metadata.producer)
      return {
        state: 'managed',
        producer: doc.metadata.producer,
        source: doc.source,
        sourceChanged: Boolean((doc.metadata.legacy as any)?.sourceChanged),
      };
    if (!doc.source) return { state: 'note' };
    try {
      const path = await realpath(doc.source),
        info = await stat(path);
      if (!info.isFile()) return { state: 'missing' };
      if (info.size > 128000000) return { state: 'oversize' };
      const hash = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      return {
        state: hash === doc.sourceHash ? 'current' : 'changed',
        source: path,
        bytes: info.size,
      };
    } catch (e: any) {
      return { state: e.code === 'ENOENT' ? 'missing' : 'unavailable', source: doc.source };
    }
  }
  async rebind(v: { vaultId: string; id: string; revision: number; source: string }) {
    this.files.assertWrite(v.vaultId);
    const doc = await this.find(v.id, v.vaultId);
    invariant(!doc.metadata.producer, 'knowledge_owner', '此条目由对应插件维护');
    invariant(doc.revision === v.revision, 'revision_conflict', '条目已变化');
    const physical = await realpath(v.source),
      info = await stat(physical);
    invariant(info.isFile() && info.size <= 128000000, 'source_size', '源文件需不超过128 MB');
    const bytes = await readFile(physical),
      hash = createHash('sha256').update(bytes).digest('hex');
    invariant(
      hash === doc.sourceHash,
      'source_mismatch',
      '新路径内容与已保存原件不同，请使用导入重新解析',
    );
    invariant(doc.sourceFileId, 'source_missing', '此条目没有已登记原件');
    const db = await this.files.database(v.vaultId);
    return db.transaction(() => {
      const current = db.db.prepare('SELECT revision FROM entries WHERE id=?').get(doc.id) as any;
      invariant(current.revision === v.revision, 'revision_conflict', '条目已变化');
      db.db
        .prepare('UPDATE files SET source_uri=?,revision=revision+1 WHERE id=?')
        .run(physical, doc.sourceFileId!);
      db.db
        .prepare('UPDATE entries SET source_uri=?,revision=revision+1 WHERE id=?')
        .run(physical, doc.id);
      return { ...doc, source: physical, revision: doc.revision + 1 };
    });
  }
  async queueImport(vaultId: string, source: string, requestId: string, parserProvider?: string) {
    this.files.assertWrite(vaultId);
    const findPrior = () => {
      const prior = this.store.document<any>('knowledge-jobs', requestId);
      if (!prior) return;
      invariant(
        prior.vaultId === vaultId &&
          prior.requestedSource === source &&
          (!parserProvider || prior.parserProvider === parserProvider),
        'idempotency_conflict',
        '导入编号对应其他文件或解析器',
      );
      return prior;
    };
    const prior = findPrior();
    if (prior) return prior;
    const selected = parserProvider ?? this.config().parserProvider;
    if (parserProvider)
      invariant(
        this.scope
          ?.list('files.extract@1')
          .some((p) => p.id === parserProvider && p.state === 'active'),
        'parser_missing',
        '当前解析器不可用',
      );
    const original = await this.files.import(vaultId, source),
      existing = (await this.list(vaultId)).find((d) => d.sourceFileId === original.id);
    const current = findPrior();
    if (current) return current;
    const job = {
      id: requestId,
      vaultId,
      requestedSource: source,
      original,
      documentId: existing?.id ?? randomUUID(),
      revision: existing?.revision ?? 0,
      state: 'queued',
      parserProvider: selected,
      createdAt: new Date().toISOString(),
    };
    this.store.put('knowledge-jobs', job.id, job);
    void this.executeImport(job.id);
    return job;
  }
  private executeImport(id: string) {
    if (this.tasks.has(id)) return this.tasks.get(id);
    const task = this.tail.then(() => this.runImport(id)).finally(() => this.tasks.delete(id));
    this.tail = task.catch(() => {});
    this.tasks.set(id, task);
    return task;
  }
  private async runImport(id: string) {
    let job = this.store.document<any>('knowledge-jobs', id);
    if (!job || !this.life || this.life.aborted) return;
    const signal = this.life;
    try {
      job = { ...job, state: 'running', error: undefined };
      this.store.put('knowledge-jobs', id, job);
      const path = await this.files.path(job.vaultId, job.original.relativePath),
        bytes = await readFile(path);
      invariant(
        createHash('sha256').update(bytes).digest('hex') === job.original.hash,
        'file_changed',
        '保存的原件已变化',
      );
      const parsed = await this.parse(bytes, job.original.name, signal, job.id, job.parserProvider);
      const text = await this.materializeParsed(job.vaultId, parsed, signal);
      signal.throwIfAborted();
      const doc = await this.save(
        job.vaultId,
        documentTitle(job.original.name, text, job.original.source),
        text,
        {
          id: job.documentId,
          source: job.original.source,
          sourceHash: job.original.hash,
          sourceFileId: job.original.id,
          revision: job.revision,
        },
      );
      job = {
        ...job,
        state: 'completed',
        documentId: doc.id,
        completedAt: new Date().toISOString(),
      };
    } catch (e: any) {
      job = { ...job, state: signal.aborted ? 'paused' : 'failed', error: e.message };
    } finally {
      this.store.put('knowledge-jobs', id, job);
      this.events?.emit('knowledge.updated', { vaultId: job.vaultId });
    }
  }
  vaults() {
    return this.files.roots();
  }
  async register(vault: Vault) {
    return this.files.register(vault);
  }
  managedVault(owner: string, name: string) {
    return this.files.managed(owner, name);
  }
  async path(vaultId: string, subpath: string) {
    return this.files.path(vaultId, subpath);
  }
  save(...args: Parameters<Files['entries']['save']>) {
    return this.files.entries.save(...args);
  }
  read(...args: Parameters<Files['entries']['read']>) {
    return this.files.entries.read(...args);
  }
  async attach(vaultId: string, documentId: string, fileId: string, role = 'attachment') {
    this.files.assertWrite(vaultId);
    const record = await this.find(documentId, vaultId),
      file = (await this.files.records(vaultId)).find((f) => f.id === fileId);
    invariant(file, 'file_missing', '附件必须已导入同一知识库');
    const database = await this.files.database(vaultId);
    const prior = database.db
      .prepare('SELECT id,name FROM entry_attachments WHERE entry_id=? AND object_hash=? LIMIT 1')
      .get(record.id, file.hash) as any;
    if (prior)
      return { id: prior.id, name: prior.name, hash: file.hash, uri: 'echo-asset:' + file.hash };
    const attachmentId = randomUUID();
    database.db
      .prepare('INSERT INTO entry_attachments VALUES(?,?,?,?,?)')
      .run(record.id, attachmentId, file.name, file.hash, role);
    return { id: attachmentId, name: file.name, hash: file.hash, uri: 'echo-asset:' + file.hash };
  }
  async import(
    vaultId: string,
    source: string,
    signal: AbortSignal = new AbortController().signal,
  ) {
    this.files.assertWrite(vaultId);
    const physical = await realpath(source),
      info = await stat(physical);
    invariant(info.isFile() && info.size <= 16000000, 'source_size', '文件需小于16 MB。');
    const bytes = await readFile(physical),
      hash = createHash('sha256').update(bytes).digest('hex');
    const existing = (await this.list(vaultId)).find((d) => d.source === physical);
    if (existing?.sourceHash === hash) return existing;
    const text = await this.materializeParsed(
      vaultId,
      await this.parse(bytes, basename(physical), signal),
      signal,
    );
    signal.throwIfAborted();
    const original = await this.files.import(vaultId, physical, bytes);
    return this.save(vaultId, documentTitle(basename(physical), text, physical), text, {
      id: existing?.id,
      source: physical,
      sourceHash: hash,
      sourceFileId: original.id,
    });
  }
  async extract(bytes: Buffer, name: string, signal: AbortSignal) {
    return (await this.parse(bytes, name, signal)).text;
  }
  async materializeParsed(vaultId: string, parsed: ParsedDocument, signal: AbortSignal) {
    let text = parsed.text,
      total = 0;
    for (const asset of parsed.assets ?? []) {
      signal.throwIfAborted();
      const name = asset.name.replace(/\\/g, '/');
      invariant(
        !name.startsWith('/') && !name.split('/').includes('..'),
        'asset_path',
        '解析附件路径无效',
      );
      const data = Buffer.from(asset.data, 'base64'),
        hash = createHash('sha256').update(data).digest('hex');
      total += data.length;
      invariant(total <= 48000000, 'asset_size', '解析附件超过大小上限');
      await this.files.write(vaultId, `Parsed/${hash}${extname(name)}`, data, { name }, signal);
      text = text
        .split('](' + name + ')')
        .join('](echo-asset:' + hash + ')')
        .split('](<' + name + '>)')
        .join('](echo-asset:' + hash + ')');
    }
    return text;
  }
  async parse(
    bytes: Buffer,
    name: string,
    signal: AbortSignal,
    requestId?: string,
    parserProvider?: string,
  ): Promise<ParsedDocument> {
    let text: string;
    if (
      ['.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.log', '.html', '.htm'].includes(
        extname(name).toLowerCase(),
      )
    )
      text = bytes.toString('utf8');
    else {
      const providers =
          this.scope?.list('files.extract@1').filter((p) => p.state === 'active') ?? [],
        selected = parserProvider ?? this.config().parserProvider,
        provider = selected
          ? providers.find((p) => p.id === selected)
          : providers.length === 1
            ? providers[0]
            : undefined;
      invariant(provider, 'parser_missing', '请启用文档解析插件，或明确选择一个解析提供方');
      const result = (await this.scope!.invoke(
        'files.extract@1',
        provider.id,
        {
          extension: extname(name).toLowerCase(),
          name,
          data: bytes.toString('base64'),
          requestId,
        },
        signal,
      )) as ParsedDocument | null;
      invariant(result, 'parser_unsupported', '当前解析器不支持此类型');
      signal.throwIfAborted();
      return result;
    }
    signal.throwIfAborted();
    return { text };
  }
  plugin(): Plugin {
    return {
      api: { version: 1, value: this },
      config: { schema: configuration },
      manifest: defineManifest(packageManifest),
      activate: ({ registry, capabilities, dispose, signal }) => {
        this.life = signal;
        for (const j of this.store
          .documents<any>('knowledge-jobs')
          .filter((j) => ['running', 'queued'].includes(j.state)))
          this.store.put('knowledge-jobs', j.id, { ...j, state: 'paused' });
        dispose(async () => {
          await Promise.allSettled(this.tasks.values());
          this.life = undefined;
        });
        this.scope = capabilities;
        registerRetrievalOptions(capabilities);
        dispose(() => {
          this.scope = undefined;
        });
        capabilities.define({
          id: 'knowledge.collections@1',
          description: '提供指定知识库的分组树与条目成员范围',
          input: collectionRequest,
          output: collectionResult.nullable(),
          providePermission: 'knowledge.source',
          consumePermission: 'knowledge.read',
        });
        capabilities.define({
          id: 'knowledge.rerank@1',
          description: '明确选择时的候选重排',
          input: z.object({
            query: z.string(),
            candidates: z.array(z.object({ id: z.string(), text: z.string() })).max(40),
          }),
          output: z.array(z.string()).max(40),
          providePermission: 'knowledge.enhance',
          consumePermission: 'knowledge.read',
          cardinality: 'one',
        });
        const searchScope = z.object({
          vaultId: id.optional(),
          collectionId: id.optional(),
          kind: z.string().optional(),
          folder: z.string().optional(),
          folderExact: z.boolean().default(false),
          archived: z.boolean().default(false),
          limit: z.number().int().min(1).max(50).default(10),
        });
        registry.register({
          name: 'knowledge.search',
          description: '搜索资料。将结果的 id 传给 knowledge_read 可从命中位置阅读，也可传 documentId 和 vaultId 读取原文。',
          owner: 'knowledge',
          permission: 'knowledge.read',
          mcp: true,
          input: z.object({
            query: z.string().min(1).max(10000),
            ...searchScope.shape,
          }),
          output: z.any(),
          run: (v, caller, s) => this.search(v.query, s, v.limit, v, caller),
        });
        registry.register({
          name: 'knowledge.searchAdvanced',
          description: '工作台高级搜索，可调整候选词、检索策略与重排',
          owner: 'knowledge',
          permission: 'knowledge.read',
          mcp: false,
          input: z.object({
            query: z.string().min(1).max(10000),
            ...searchScope.shape,
            strategy: z.enum(['keyword', 'semantic', 'hybrid']).optional(),
            queries: z
              .array(
                z.object({
                  text: z.string().trim().min(1).max(1000),
                  weight: z.number().positive().max(10).default(1),
                }),
              )
              .max(8)
              .optional(),
            semanticWeight: z.number().min(0).max(1).default(0.7),
            directoryBoost: z
              .object({ folder: z.string().min(1), weight: z.number().min(0.1).max(3) })
              .optional(),
            rerank: z.boolean().default(false),
            limit: z.number().int().min(1).max(50).default(10),
          }),
          output: z.any(),
          run: (v, caller, s) => this.search(v.query, s, v.limit, v, caller),
        });
        const op = (
          name: string,
          description: string,
          input: z.ZodType,
          permission: string,
          run: (v: any, signal: AbortSignal, caller: Caller) => any,
          mcp = true,
        ) =>
          registry.register({
            name,
            description,
            input,
            output: z.any(),
            permission,
            owner: 'knowledge',
            mcp,
            run: (v, c, s) => run(v, s, c),
          });
        op(
          'knowledge.character-library',
          '读取角色统一资料目录',
          z.object({ personaId: id }),
          'knowledge.read',
          async (v, _s, caller) => {
            const personaId = ownPersona(caller, v.personaId);
            const entries = (await this.list(undefined, caller)).filter(
              (entry) => entryPersona(entry) === personaId,
            );
            return { id: 'character:' + personaId, personaId, entries };
          },
          false,
        );
        op(
          'knowledge.maintain',
          '批量移动、归档、恢复或删除条目',
          z.object({
            vaultId: id,
            items: z
              .array(z.object({ id, revision: z.number().int().min(1) }))
              .min(1)
              .max(100),
            action: z.enum(['move', 'archive', 'restore', 'delete']),
            folder: z.string().optional(),
            confirmed: z.literal(true),
          }),
          'knowledge.write',
          (v) => this.maintain(v),
          false,
        );
        op(
          'knowledge.source',
          '检查源文件状态',
          z.object({ vaultId: id, id }),
          'knowledge.read',
          (v) => this.inspectSource(v.vaultId, v.id),
          false,
        );
        op(
          'knowledge.rebind',
          '修复相同原件的来源路径',
          z.object({ vaultId: id, id, revision: z.number().int().min(1), source: z.string() }),
          'knowledge.write',
          (v) => this.rebind(v),
          false,
        );
        op(
          'knowledge.revisions',
          '查看知识正文历史版本',
          z.object({ vaultId: id, id }),
          'knowledge.read',
          async (v, _s, caller) => {
            await this.files.entries.find(v.id, v.vaultId, caller);
            return (await this.files.database(v.vaultId)).db
              .prepare(
                'SELECT revision,title,updated_at AS updatedAt,version,length(body) AS chars FROM entry_revisions WHERE entry_id=? ORDER BY revision DESC LIMIT 100',
              )
              .all(v.id);
          },
        );
        op(
          'knowledge.restore-revision',
          '将历史正文恢复为一个新版本',
          z.object({
            vaultId: id,
            id,
            revision: z.number().int(),
            targetRevision: z.number().int(),
            confirmed: z.literal(true),
          }),
          'knowledge.write',
          async (v) => {
            const doc = await this.find(v.id, v.vaultId);
            invariant(!doc.metadata.producer, 'knowledge_owner', '此条目由对应插件维护');
            const db = await this.files.database(v.vaultId),
              old = db.db
                .prepare('SELECT * FROM entry_revisions WHERE entry_id=? AND revision=?')
                .get(v.id, v.targetRevision) as any;
            invariant(old, 'revision_missing', '历史版本不存在');
            return this.save(v.vaultId, old.title, old.body, { id: v.id, revision: v.revision });
          },
          false,
        );
        op(
          'knowledge.import-job',
          '保存原件并开始可恢复解析',
          z.object({
            vaultId: id,
            source: z.string(),
            requestId: id,
            parserProvider: id.optional(),
          }),
          'knowledge.write',
          (v) => this.queueImport(v.vaultId, v.source, v.requestId, v.parserProvider),
          false,
        );
        op(
          'knowledge.jobs',
          '查看文档解析任务',
          z.object({}),
          'knowledge.read',
          () => this.store.documents('knowledge-jobs'),
          false,
        );
        op(
          'knowledge.resume',
          '继续未完成的文档解析',
          z.object({ id }),
          'knowledge.write',
          (v) => {
            const j = this.store.document<any>('knowledge-jobs', v.id);
            invariant(j && ['failed', 'paused'].includes(j.state), 'job_state', '任务无法继续');
            void this.executeImport(v.id);
            return { accepted: true };
          },
          false,
        );
        op('knowledge.vaults', '列出已授权的知识库目录', z.object({}), 'knowledge.read', () =>
          this.vaults(),
        );
        op(
          'knowledge.collections', '列出知识库分组；检索时可传入对应的 collectionId',
          collectionRequest, 'knowledge.read',
          async (v, signal, caller) => {
            const result = await this.collections(v.vaultId, v.collectionId, signal);
            if (!result.documentIds || caller.kind !== 'mcp') return result;
            const allowed = new Set((await this.list(v.vaultId, caller)).map((entry) => entry.id));
            return { ...result, documentIds: result.documentIds.filter((id) => allowed.has(id)) };
          },
        );
        op(
          'knowledge.list',
          '列出知识包',
          z.object({ vaultId: id.optional() }),
          'knowledge.read',
          (v, _s, caller) => this.list(v.vaultId, caller),
        );
        op(
          'knowledge.read',
          '分段读取知识条目。接受搜索结果的完整 id，或使用 documentId 作为 id 并指定 vaultId。',
          z.object({
            id: z.union([id, z.string().regex(searchHitId)]),
            vaultId: id.optional(),
            offset: z.number().int().min(0).optional(),
            limit: z.number().int().min(1).max(30000).default(12000),
          }),
          'knowledge.read',
          (v, _s, caller) => {
            const hit = searchHitId.exec(v.id);
            if (!hit) return this.files.entries.read(v.id, v.offset, v.limit, v.vaultId, caller);
            const [, vaultId, documentId, offset] = hit;
            invariant(!v.vaultId || v.vaultId === vaultId, 'vault_mismatch', '命中片段属于另一个知识库。');
            return this.files.entries.read(documentId, v.offset ?? Number(offset), v.limit, vaultId, caller);
          },
        );
        op(
          'knowledge.export',
          'Export a portable library bundle or ordinary Markdown with attachments',
          z.object({
            vaultId: id,
            destination: z.string(),
            mode: z.enum(['bundle', 'markdown']).default('bundle'),
            kinds: z
              .array(z.enum(['knowledge', 'persona', 'memory', 'observation', 'review']))
              .min(1)
              .default(['knowledge']),
            sourceLocations: z.boolean().default(false),
          }),
          'knowledge.read',
          async (v, s) => {
            const root = this.vaults().find((r) => r.id === v.vaultId);
            invariant(root, 'vault_missing', '知识库不存在');
            return workerTask(
              this.project,
              'library-export-worker',
              'plugins/knowledge/export-worker.ts',
              { ...v, directory: root.path },
              s,
              600000,
            );
          },
          false,
        );
        op(
          'knowledge.attach',
          'Attach an imported media object to a knowledge entry',
          z.object({
            vaultId: id,
            id,
            fileId: id,
            role: z.enum(['attachment', 'image', 'audio', 'video']).default('attachment'),
          }),
          'knowledge.write',
          (v) => {
            this.files.assertWrite(v.vaultId);
            return this.attach(v.vaultId, v.id, v.fileId, v.role);
          },
        );
        op(
          'knowledge.import',
          '把指定文本文件固化为知识包',
          z.object({ vaultId: id, source: z.string().min(1) }),
          'knowledge.write',
          (v, s) => this.import(v.vaultId, v.source, s),
          false,
        );
        op(
          'knowledge.save',
          '写入知识包',
          z.object({
            vaultId: id,
            title: z.string().min(1),
            text: z.string().max(1000000),
            id: id.optional(),
            revision: z.number().int().min(0).optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            path: z.string().optional(),
          }),
          'knowledge.write',
          async (v, _s, caller) => {
            const writer = caller.kind === 'extension' ? caller.pluginId : undefined;
            this.files.assertWrite(v.vaultId, writer);
            if (v.id) {
              const doc = await this.find(v.id, v.vaultId);
              invariant(
                !doc.metadata.producer || doc.metadata.producer === writer,
                'knowledge_owner',
                '此条目由对应插件维护，请在来源页面编辑',
              );
              invariant(v.revision !== undefined, 'revision_required', '编辑需要当前版本');
            }
            return this.save(
              v.vaultId,
              v.title,
              v.text,
              {
                path: v.path,
                id: v.id,
                revision: v.revision,
                metadata: v.metadata,
              },
              writer,
            );
          },
        );
      },
    };
  }
}
