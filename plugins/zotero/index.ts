import { browseLibrary } from '../../packages/contracts/library-catalog.ts';
import { buildCatalog, browseCatalog, type Item, type Reference } from './catalog.ts';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Knowledge } from '../knowledge/index.ts';
import { invariant, id } from '../../packages/contracts/index.ts';
import type { KnowledgeCollection } from '../../packages/contracts/knowledge-collections.ts';
import { defineManifest, type Plugin } from '../../packages/kernel/registry.ts';
import type { Store } from '../../packages/kernel/store.ts';
import type { Secrets } from '../../packages/kernel/secrets.ts';
import type { Files } from '../files/index.ts';
import { operations } from '../shared.ts';
import manifest from './echo-plugin.json' with { type: 'json' };

const key = z.string().regex(/^[A-Z2-9]{8}$/);
const config = z.object({
  serverId: z.string().trim().default(''),
  secretRef: z.string().trim().default(''),
});
const reference = z.object({
  itemKey: key,
  vaultId: id,
  documentId: id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

type Collection = { key: string; name: string; parentCollection: string | false };
type Catalog = { collections: Collection[]; members: Record<string, string[]> };

export function zoteroPlugin(
  store: Store,
  secrets: Secrets,
  files: Files,
  knowledge: Knowledge,
): Plugin {
  const connection = () => config.parse(store.get('zotero.config', {}));
  const scope = () => connection().serverId;
  const references = () =>
    store
      .documents<Reference & { serverId: string; jobId?: string }>('zotero-references')
      .filter(
        (r) =>
          r.serverId === scope() &&
          (!r.jobId ||
            store.document<{ state: string }>('knowledge-jobs', r.jobId)?.state === 'completed'),
      );
  async function call(path: string, signal: AbortSignal, init: RequestInit = {}) {
    const cfg = connection();
    invariant(cfg.serverId && cfg.secretRef, 'zotero_setup', '请先连接本机 Zotero 文献库。');
    const token = await secrets.get(cfg.secretRef);
    invariant(token, 'zotero_credential', '本地 Zotero 授权不可用。');
    const response = await fetch('http://127.0.0.1:23119/api/users/0/' + path, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      redirect: 'error',
      headers: {
        'Zotero-Server-ID': cfg.serverId,
        'Zotero-API-Key': token,
        'Zotero-API-Version': '3',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    invariant(
      response.ok,
      'zotero_response',
      'Zotero HTTP ' +
        response.status +
        (response.status === 412 ? '，题录已被修改，请重新读取。' : ''),
    );
    if (response.status === 204) return null;
    return path.endsWith('/file/view/url') ? response.text() : response.json();
  }
  async function all(path: string, signal: AbortSignal) {
    const rows: Item[] = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let start = 0; ; start += 100) {
      const page = z
        .array(z.object({ key, version: z.number(), data: z.record(z.string(), z.any()) }))
        .parse(await call(path + separator + 'limit=100&start=' + start, signal));
      rows.push(...page);
      if (page.length < 100) return rows;
    }
  }
  let snapshot: {scope: string; expires: number; data: ReturnType<typeof buildCatalog>} | undefined;
  let epoch = 0;
  function invalidate() { snapshot = undefined; epoch++; }
  async function refresh(signal: AbortSignal) {
    const serverId = scope();
    const [collections, items] = await Promise.all([
      all('collections', signal),
      all('items/top', signal),
    ]);
    invariant(serverId === scope(), 'zotero_changed', '文献库连接已改变');
    const catalog: Catalog = {
      collections: collections.map((c) => ({
        key: c.key,
        name: c.data.name,
        parentCollection: c.data.parentCollection || false,
      })),
      members: Object.fromEntries(items.map((i) => [i.key, i.data.collections || []])),
    };
    store.put('zotero-catalog', serverId, catalog);
    invalidate();
    return { collections: collections.length, items: items.length };
  }
  return {
    manifest: defineManifest(manifest),
    config: { schema: config },
    activate(ctx) {
      const op = operations(ctx, 'zotero');
      ctx.dispose(invalidate);
      op('browse', '按分组浏览和搜索文献库', browseLibrary, 'zotero.read', async (v, signal) => {
        const server = scope();
        if (v.refresh) invalidate();
        let data = snapshot?.scope === server && snapshot.expires > Date.now() ? snapshot.data : undefined;
        if (!data) {
          const generation = epoch;
          const [collections, items, attachments] = await Promise.all([
            all('collections', signal), all('items/top', signal), all('items?itemType=attachment', signal),
          ]);
          invariant(scope() === server,'zotero_changed','文献库连接已改变');
          data = buildCatalog(collections, items, attachments);
          if (generation === epoch) snapshot = {scope:server, expires:Date.now()+60000, data};
        }
        const links = store.documents<Reference & {serverId:string}>('zotero-references')
          .filter(r => r.serverId === server)
          .map(r => ({...r,state:r.jobId ? store.document<{state:string}>('knowledge-jobs',r.jobId)?.state : 'completed'}));
        return browseCatalog(data, v, links, async (vault, ids) => {
          try { return await knowledge.indexCoverage(vault, ids, signal); }
          catch (error) { signal.throwIfAborted(); return {}; }
        });
      }, false);
      op(
        'importAttachment',
        '按原件哈希复用已解析的 PDF，或交给选定知识库的入库流程',
        z.object({ attachment: key, vaultId: id.optional() }),
        'zotero.import',
        async (v, signal) => {
          const serverId = scope();
          const file = await call('items/' + v.attachment, signal);
          invariant(
            file.data.itemType === 'attachment' &&
              file.data.linkMode === 'imported_file' &&
              file.data.contentType === 'application/pdf' &&
              key.safeParse(file.data.parentItem).success,
            'zotero_attachment',
            '请选择文献下由 Zotero 存储的 PDF 附件。',
          );
          const location = new URL(await call('items/' + v.attachment + '/file/view/url', signal));
          invariant(
            location.protocol === 'file:' && !location.host,
            'zotero_file',
            '附件尚未下载到本机。',
          );
          const path = fileURLToPath(location);
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
          const sha256 = hash.digest('hex');
          const found = references().find(
            (r) =>
              r.itemKey === file.data.parentItem &&
              r.sha256 === sha256 &&
              (!v.vaultId || r.vaultId === v.vaultId),
          );
          if (found) return { reused: true, documentId: found.documentId, vaultId: found.vaultId };
          const vaultId = v.vaultId ?? 'local';
          const requestId =
            'zotero-' +
            createHash('sha256')
              .update([serverId, vaultId, v.attachment, sha256].join('/'))
              .digest('hex');
          const job = await knowledge.queueImport(vaultId, path, requestId);
          invariant(
            serverId === scope() && job.original.hash === sha256,
            'zotero_changed',
            '归档期间附件或连接已更改。',
          );
          store.put('zotero-references', requestId, {
            serverId,
            itemKey: file.data.parentItem,
            vaultId,
            documentId: job.documentId,
            sha256,
            jobId: job.id,
          });
          return {
            reused: false,
            jobId: job.id,
            state: job.state,
            vaultId,
            documentId: job.documentId,
          };
        },
      );
      for (const page of manifest.pages) ctx.capabilities.provide('core.ui.pages@1', page.id, page.title, () => page);
      op(
        'status',
        '读取本机文献库连接状态',
        z.object({}),
        'zotero.configure',
        () => {
          const data = store.document<Catalog>('zotero-catalog', scope());
          return {
            library: data ? 'Zotero · ' + Object.keys(data.members).length + ' 条题录' : '尚未连接',
          };
        },
        false,
      );
      op(
        'connect',
        '连接本机 Zotero 并同步分组',
        z.object({}),
        'zotero.configure',
        async (_v, signal) => {
          const base = 'http://127.0.0.1:23119/api/';
          const discovery = await fetch(base, { signal, redirect: 'error' });
          const serverId = discovery.headers.get('Zotero-Server-ID');
          invariant(discovery.ok && serverId, 'zotero_offline', '请打开 Zotero 并启用本地 API。');
          await discovery.body?.cancel();
          if (serverId !== scope() || !(await secrets.get(connection().secretRef))) {
            const res = await fetch(base + 'local/authorize', {
              method: 'POST',
              signal,
              redirect: 'error',
              headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': serverId },
              body: JSON.stringify({ appName: 'Echo Zotero' }),
            });
            invariant(res.ok, 'zotero_authorization', 'Zotero 尚未授权。');
            const grant = z.object({ key: z.string().min(1) }).parse(await res.json());
            const secretRef = 'zotero-local-api';
            await secrets.set(secretRef, grant.key);
            store.set('zotero.config', { serverId, secretRef });
          }
          return refresh(signal);
        },
        false,
      );
      op(
        'search',
        '搜索 Zotero 题录，返回文献链接及关联的知识条目',
        z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }),
        'zotero.read',
        async (v, s) => {
          const query = new URLSearchParams({
            q: v.query,
            qmode: 'everything',
            limit: String(v.limit),
          });
          const rows: Item[] = await call('items/top?' + query, s);
          const links = new Map(references().map((r) => [r.itemKey, r]));
          return rows.map((row) => {
            const ref = links.get(row.key);
            return {
              key: row.key,
              title: row.data.title,
              doi: row.data.DOI,
              uri: 'zotero://select/library/items/' + row.key,
              knowledge: ref ? { vaultId: ref.vaultId, documentId: ref.documentId } : undefined,
            };
          });
        },
      );
      op(
        'item',
        '读取题录、短评、评分和附件信息',
        z.object({ key }),
        'zotero.read',
        async (v, s) => {
          const [item, children] = await Promise.all([
            call('items/' + v.key, s),
            all('items/' + v.key + '/children', s),
          ]);
          return {
            key: item.key,
            version: item.version,
            data: item.data,
            children: children.map((row) => ({
              key: row.key,
              type: row.data.itemType,
              title: row.data.title,
              filename: row.data.filename,
              note: row.data.note,
            })),
          };
        },
      );
      op('collections', '列出 Zotero 文献分组', z.object({}), 'zotero.read', (_v, s) =>
        all('collections', s),
      );
      op(
        'setCollections',
        '按已读取的条目版本更新分组',
        z.object({
          key,
          version: z.number().int().nonnegative(),
          collections: z.array(key).max(1000),
        }),
        'zotero.write',
        (v, s) =>
          call('items/' + v.key, s, {
            method: 'PATCH',
            headers: { 'If-Unmodified-Since-Version': String(v.version) },
            body: JSON.stringify({ collections: [...new Set(v.collections)] }),
          }),
      );
      op(
        'note',
        '为题录添加纯文本笔记，用同一笔记键重试可避免重复',
        z.object({ parent: key, noteKey: key, text: z.string().min(1).max(50000) }),
        'zotero.write',
        async (v, s) => {
          const text = v.text
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
          const note = '<p>' + text.replaceAll('\n', '<br/>') + '</p>';
          const existing = (await all('items/' + v.parent + '/children', s)).find(
            (r) => r.key === v.noteKey,
          );
          if (existing) {
            invariant(
              existing.data.itemType === 'note' && existing.data.note === note,
              'zotero_conflict',
              '相同编号的笔记内容已变化。',
            );
            return { key: v.noteKey };
          }
          const result = await call('items', s, {
            method: 'POST',
            body: JSON.stringify([
              { key: v.noteKey, version: 0, itemType: 'note', parentItem: v.parent, note },
            ]),
          });
          invariant(
            !Object.keys(result.failed ?? {}).length,
            'zotero_write',
            'Zotero 未接受笔记。',
          );
          return { key: v.noteKey };
        },
      );
      op(
        'refresh',
        '更新知识库可用分组',
        z.object({}),
        'zotero.configure',
        (_v, s) => refresh(s),
        false,
      );
      op(
        'link',
        '关联具有相同原件哈希的已解析文献',
        z.object({ items: z.array(reference).min(1).max(100) }),
        'zotero.configure',
        async ({ items }, s) => {
          const serverId = scope();
          const catalog = store.document<Catalog>('zotero-catalog', serverId);
          for (const row of items as Reference[]) {
            s.throwIfAborted();
            invariant(
              catalog && Object.hasOwn(catalog.members, row.itemKey),
              'zotero_item',
              '请先刷新文献分组并核对题录',
            );
            const db = (await files.database(row.vaultId)).db;
            invariant(
              db
                .prepare(
                  'SELECT 1 FROM entries WHERE id=? AND source_hash=? UNION SELECT 1 FROM entry_attachments WHERE entry_id=? AND object_hash=?',
                )
                .get(row.documentId, row.sha256, row.documentId, row.sha256),
              'zotero_hash',
              '知识条目原件指纹不匹配',
            );
          }
          store.transaction(() => {
            for (const row of items as Reference[])
              store.put('zotero-references', serverId + '.' + row.itemKey, { ...row, serverId });
          });
          return { linked: items.length };
        },
        false,
      );
      ctx.capabilities.provide(
        'knowledge.collections@1',
        'zotero.collections',
        'Zotero',
        ({ vaultId, collectionId }) => {
          const links = references().filter((r) => r.vaultId === vaultId);
          const catalog = store.document<Catalog>('zotero-catalog', scope());
          if (!links.length || !catalog) return null;
          const root = 'zotero-library',
            prefix = 'zotero-collection-';
          const nodes: KnowledgeCollection[] = [
            { id: root, title: 'Zotero', kind: 'library' },
            ...catalog.collections.map((c) => ({
              id: prefix + c.key,
              parentId: c.parentCollection ? prefix + c.parentCollection : root,
              title: c.name,
              kind: 'group' as const,
            })),
          ];
          if (!collectionId || !nodes.some((n) => n.id === collectionId)) return { nodes };
          const descendants = new Set([collectionId]);
          for (let size = -1; size !== descendants.size;) {
            size = descendants.size;
            for (const n of nodes)
              if (n.parentId && descendants.has(n.parentId)) descendants.add(n.id);
          }
          return {
            nodes,
            documentIds: links
              .filter(
                (r) =>
                  Object.hasOwn(catalog.members, r.itemKey) &&
                  (collectionId === root ||
                    catalog.members[r.itemKey].some((k) => descendants.has(prefix + k))),
              )
              .map((r) => r.documentId),
          };
        },
      );
    },
  };
}
