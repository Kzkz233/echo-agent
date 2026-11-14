import { z } from 'zod';
import { extname } from 'node:path';
import { ingestionPolicy, contentPolicy } from '../../packages/contracts/ingestion.ts';
import { ingestionHash } from '../../packages/kernel/artifact-identity.ts';
import { id, invariant } from '../../packages/contracts/index.ts';
import { parserAccepts } from '../../packages/contracts/parsing.ts';
import { mediaExtensions } from '../../packages/contracts/speech.ts';
import { textExtensions } from '../files/parsers.ts';
import type { Knowledge } from './index.ts';
import type { FileRecord } from '../files/index.ts';
import type { PluginContext } from '../../packages/kernel/registry.ts';
import { evidenceGraph } from './graph.ts';

export class KnowledgePipeline {
  private scope?: PluginContext['capabilities'];
  constructor(readonly knowledge: Knowledge) {}
  policy() {
    const old = this.knowledge.config();
    return ingestionPolicy.parse(
      this.knowledge.store.get('knowledge.pipeline', {
        documentParser: old.parserProvider,
        mediaParser: old.mediaParserProvider,
      }),
    );
  }
  async parser(source: Pick<FileRecord, 'name' | 'bytes'>, policy = this.policy()) {
    const catalog = await this.knowledge.files.parsers.list();
    const extension = extname(source.name).toLowerCase();
    const compatible = catalog.filter((p) => parserAccepts(p, source.name, source.bytes));
    const selected = textExtensions.includes(extension)
      ? 'files.text'
      : mediaExtensions.includes(extension)
        ? policy.mediaParser
        : /\.(png|jpe?g|webp|gif|bmp)$/i.test(extension)
          ? policy.imageParser || policy.documentParser
          : policy.documentParser;
    return (
      compatible.find((p) => p.id === selected) ??
      compatible.find((p) => p.id === 'files.image') ??
      ((!selected || !this.knowledge.store.get('knowledge.pipeline', null)) &&
      compatible.length === 1
        ? compatible[0]
        : undefined)
    );
  }
  async graph(
    vaultId: string,
    documentId: string,
    policy = this.policy(),
    signal = new AbortController().signal,
  ) {
    const doc = await this.knowledge.read(documentId, 0, 16000000, vaultId);
    const db = await this.knowledge.files.database(vaultId);
    db.db
      .exec(`CREATE TABLE IF NOT EXISTS content_graphs(entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      entry_version TEXT NOT NULL,policy_hash TEXT NOT NULL,nodes TEXT NOT NULL,PRIMARY KEY(entry_id,entry_version,policy_hash))`);
    const policyHash = ingestionHash(contentPolicy(policy));
    const old = db.db
      .prepare(
        'SELECT nodes FROM content_graphs WHERE entry_id=? AND entry_version=? AND policy_hash=?',
      )
      .get(documentId, doc.version, policyHash) as any;
    if (old) return { document: doc, policyHash, nodes: JSON.parse(old.nodes), reused: true };
    let duration: number | undefined;
    let hasAudio = true;
    if (/^(audio|video)\//.test(String(doc.original?.mediaType)) && doc.sourceHash) {
      const info = await this.knowledge.files.parsers.inspectMedia(vaultId, doc.sourceHash, signal, policy.mediaProcessor);
      duration = info?.duration;
      hasAudio = info?.hasAudio ?? true;
    }
    const nodes = evidenceGraph(doc as any, policy, duration, hasAudio);
    signal.throwIfAborted();
    const current = await this.knowledge.files.entries.find(documentId, vaultId);
    invariant(
      current.version === doc.version,
      'revision_conflict',
      '条目已变化，请重新生成内容结构',
    );
    db.db
      .prepare('INSERT OR IGNORE INTO content_graphs VALUES(?,?,?,?)')
      .run(documentId, doc.version, policyHash, JSON.stringify(nodes));
    return { document: doc, policyHash, nodes, reused: false };
  }
  async evidence(vaultId: string, documentId: string, nodeId: string, policyHash?: string) {
    const db = await this.knowledge.files.database(vaultId),
      entry = await this.knowledge.files.entries.find(documentId, vaultId);
    const exists = db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='content_graphs'").get();
    let nodes: any[] = [];
    if (exists) {
      const rows = policyHash
        ? db.db
            .prepare(
              'SELECT nodes FROM content_graphs WHERE entry_id=? AND entry_version=? AND policy_hash=?',
            )
            .all(documentId, entry.version, policyHash)
        : db.db
            .prepare('SELECT nodes FROM content_graphs WHERE entry_id=? AND entry_version=?')
            .all(documentId, entry.version);
      for (const row of rows as any[]) {
        const candidate = JSON.parse(row.nodes);
        if (candidate.some((n: any) => n.id === nodeId)) {
          nodes = candidate;
          break;
        }
      }
    }
    const node = nodes.find((n) => n.id === nodeId);
    if (!node && this.scope) {
      const body = (db.db.prepare('SELECT body FROM entries WHERE id=?').get(documentId) as any)
        .body as string;
      for (const p of this.scope.list('knowledge.evidence@1').filter((p) => p.state === 'active')) {
        const result = (await this.scope.invoke('knowledge.evidence@1', p.id, {
          vaultId,
          documentId,
          nodeId,
          bodyHash: createHash('sha256').update(body).digest('hex'),
        })) as any;
        if (result?.node) {
          const offset = body.indexOf(result.node.text);
          return { ...result, node: { ...result.node, ...(offset >= 0 ? { offset } : {}) } };
        }
      }
    }
    invariant(node, 'evidence_missing', '证据片段已变化，请重新检索');
    return { node, parent: nodes.find((n) => n.id === node.parentId) };
  }
  register(ctx: PluginContext) {
    this.scope = ctx.capabilities;
    ctx.dispose(() => {
      this.scope = undefined;
    });
    ctx.capabilities.define({
      id: 'knowledge.evidence@1',
      description: 'Resolve evidence from optional indexes using current content identity',
      input: z.object({ vaultId: id, documentId: id, nodeId: z.string(), bodyHash: z.string() }),
      output: z.unknown(),
      providePermission: 'knowledge.enhance',
      consumePermission: 'knowledge.read',
    });
    const op = (
      name: string,
      input: z.ZodType,
      permission: string,
      run: (v: any, signal: AbortSignal) => unknown,
    ) =>
      ctx.registry.register({
        name: 'knowledge.' + name,
        description: '知识入库流程与内容结构',
        owner: 'knowledge',
        input,
        output: z.unknown(),
        permission,
        mcp: false,
        run: (v, _c, s) => run(v, s),
      });
    op('pipeline.status', z.object({}), 'knowledge.read', async () => ({
      policy: this.policy(),
      fingerprint: ingestionHash(this.policy()),
      parsers: await this.knowledge.files.parsers.list(),
      mediaProcessors: await this.knowledge.files.parsers.mediaProcessors(),
    }));
    op(
      'pipeline.save',
      z.object({ policy: ingestionPolicy, expected: z.string() }),
      'knowledge.write',
      async (v) => {
        invariant(
          v.expected === ingestionHash(this.policy()),
          'revision_conflict',
          '入库流程已由其他窗口修改，请刷新',
        );
        const parsers = await this.knowledge.files.parsers.list();
        for (const name of ['documentParser', 'mediaParser', 'imageParser'] as const)
          invariant(
            !v.policy[name] ||
              parsers.some((p) => p.id === v.policy[name] && p.version !== 'legacy'),
            'parser_missing',
            '解析器不可用',
          );
        this.knowledge.store.set('knowledge.pipeline', v.policy);
        this.knowledge.events?.emit('knowledge.updated', {});
        return { policy: this.policy(), fingerprint: ingestionHash(this.policy()) };
      },
    );
    ctx.capabilities.provide('core.cli.commands@1', 'knowledge.cli', '知识入库命令', () => [
      {
        id: 'knowledge.pipeline.status',
        label: '查看默认入库流程',
        operation: 'knowledge.pipeline.status',
        permission: 'knowledge.read',
        inputSchema: z.toJSONSchema(z.object({})),
      },
    ]);
    op('graph', z.object({ vaultId: id, id }), 'knowledge.read', (v, signal) =>
      this.graph(v.vaultId, v.id, undefined, signal),
    );
    op(
      'evidence',
      z.object({ vaultId: id, id, nodeId: id }),
      'knowledge.read',
      async (v, signal) => {
        const graph = await this.graph(v.vaultId, v.id, undefined, signal);
        const node = graph.nodes.find((n: any) => n.id === v.nodeId);
        invariant(node, 'evidence_missing', '证据片段不存在');
        return {
          node,
          parent: graph.nodes.find((n: any) => n.id === node.parentId),
          document: { id: graph.document.id, title: graph.document.title },
        };
      },
    );
  }
}
import { createHash } from 'node:crypto';
