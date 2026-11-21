import { storedPDF } from './attachment-status.ts';
import { browseLibrary } from '../../packages/contracts/library-catalog.ts';
import {
  browseCatalog,
  linkedDocuments,
  type Item,
  type Reference,
  type LinkedEntry,
} from './catalog.ts';
import {
  archivedGroup,
  legacyDirectory,
  projectDirectory,
  reconcileDirectory,
  type Catalog,
  type Directory,
} from './library.ts';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Knowledge } from '../knowledge/index.ts';
import type { ResourceReader } from '../../packages/kernel/resource-access.ts';
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

export function zoteroPlugin(
  store: Store,
  secrets: Secrets,
  files: Files,
  knowledge: Knowledge,
): Plugin {
  const connection = () => config.parse(store.get('zotero.config', {}));
  const scope = () => connection().serverId;
  const references = () =>
    allLinks(scope()).filter(
      (r) =>
        r.serverId === scope() &&
        (!r.jobId ||
          store.document<{ state: string }>('knowledge-jobs', r.jobId)?.state === 'completed'),
    );
  async function call(
    path: string,
    signal: AbortSignal,
    init: RequestInit = {},
    inspect?: (headers: Headers) => void,
  ) {
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
    inspect?.(response.headers);
    if (response.status === 204) return null;
    return path.endsWith('/file/view/url') ? response.text() : response.json();
  }
  async function all(path: string, signal: AbortSignal, inspect?: (headers: Headers) => void) {
    const rows: Item[] = [];
    const keys = new Set<string>();
    let expected: number | undefined;
    const separator = path.includes('?') ? '&' : '?';
    for (let start = 0; ; start += 100) {
      const page = z
        .array(z.object({ key, version: z.number(), data: z.record(z.string(), z.any()) }))
        .parse(
          await call(path + separator + 'limit=100&start=' + start, signal, {}, (h) => {
            inspect?.(h);
            const total = h.get('Total-Results');
            if (total !== null) {
              invariant(
                expected === undefined || expected === Number(total),
                'zotero_changed',
                '同步期间文献库已改变，请刷新',
              );
              expected = Number(total);
            }
          }),
        );
      for (const row of page) {
        invariant(!keys.has(row.key), 'zotero_changed', '同步期间文献库已改变，请刷新');
        keys.add(row.key);
      }
      rows.push(...page);
      if (page.length < 100 || rows.length === expected) {
        invariant(
          expected === undefined || rows.length === expected,
          'zotero_incomplete',
          '文献目录读取不完整，请刷新',
        );
        return rows;
      }
    }
  }
  const allLinks = (server: string) => {
    const rows = store
      .documents<Reference & { serverId: string }>('zotero-references')
      .filter((r) => r.serverId === server);
    const keyOf = (r: Reference) => JSON.stringify([r.itemKey, r.vaultId, r.documentId, r.sha256]);
    const bound = new Set(rows.filter((r) => r.attachmentKey).map(keyOf));
    return rows.filter((r) => r.attachmentKey || !bound.has(keyOf(r)));
  };
  async function localLinks(server: string, reader?: ResourceReader) {
    const links = allLinks(server);
    const titles = new Map<string, Map<string, string>>();
    for (const vault of new Set(links.map((l) => l.vaultId))) {
      titles.set(
        vault,
        await files.entries.titles(
          vault,
          links.filter((l) => l.vaultId === vault).map((l) => l.documentId),
          reader,
        ),
      );
    }
    invariant(server === scope(), 'zotero_changed', '文献库连接已改变');
    return links.map((link) => {
      const title = titles.get(link.vaultId)?.get(link.documentId);
      const jobState = link.jobId
        ? store.document<{ state: string }>('knowledge-jobs', link.jobId)?.state
        : 'completed';
      return {
        ...link,
        title,
        state: jobState === 'completed' && title === undefined ? 'unavailable' : jobState,
      };
    });
  }
  async function verifyLegacy(
    server: string,
    links: LinkedEntry[],
    attachments: Item[],
    signal: AbortSignal,
  ) {
    const resolved: LinkedEntry[] = [];
    for (const link of links) {
      const candidates =
        !link.attachmentKey && link.state === 'completed'
          ? attachments.filter(
              (f) =>
                f.data.parentItem === link.itemKey &&
                storedPDF(f) &&
                /^[a-f0-9]{32}$/i.test(f.data.md5 ?? ''),
            )
          : [];
      if (!candidates.length) {
        resolved.push(link);
        continue;
      }
      const cacheKey = link.vaultId + '/' + link.sha256;
      let md5 = store.document<string>('zotero-original-checksums', cacheKey);
      if (!md5) {
        try {
          const object = await files.mediaObject(link.vaultId, link.sha256);
          const original = createHash('sha256'),
            checksum = createHash('md5');
          for await (const chunk of createReadStream(object.path, {
            signal: AbortSignal.any([signal, object.signal]),
          })) {
            original.update(chunk);
            checksum.update(chunk);
          }
          if (original.digest('hex') === link.sha256) {
            md5 = checksum.digest('hex');
            store.put('zotero-original-checksums', cacheKey, md5);
          }
        } catch (error) {
          signal.throwIfAborted();
          if (
            !['ENOENT', 'file_missing', 'file_changed'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
        }
      }
      signal.throwIfAborted();
      invariant(server === scope(), 'zotero_changed', '文献库连接已改变');
      const matched = candidates.filter((f) => f.data.md5.toLowerCase() === md5);
      if (!matched.length) resolved.push(link);
      for (const file of matched) {
        const verified = {
          serverId: server,
          itemKey: link.itemKey,
          vaultId: link.vaultId,
          documentId: link.documentId,
          sha256: link.sha256,
          jobId: link.jobId,
          attachmentKey: file.key,
          sourceMd5: md5,
          sourceName: file.data.filename,
          sourceMtime: file.data.mtime,
          sourceVersion: file.version,
        };
        const identity = JSON.stringify([
          server,
          link.itemKey,
          link.vaultId,
          file.key,
          link.sha256,
        ]);
        const existing = store.document<Reference>('zotero-references', identity);
        if (!existing) store.put('zotero-references', identity, verified);
        resolved.push({ ...link, ...(existing ?? verified) });
      }
    }
    return resolved;
  }
  let active: AbortSignal;
  let inFlight: { server: string; promise: Promise<Directory> } | undefined;
  let cached:
    { server: string; data: Directory; view: ReturnType<typeof projectDirectory> } | undefined;
  let lastAttempt = 0;
  let syncIssue = '';
  function remember(server: string, data: Directory) {
    cached = { server, data, view: projectDirectory(data) };
    return cached;
  }
  function invalidate() {
    cached = undefined;
    inFlight = undefined;
    lastAttempt = 0;
    syncIssue = '';
  }
  function sync(server: string) {
    if (inFlight?.server === server) return inFlight.promise;
    lastAttempt = Date.now();
    syncIssue = '';
    const request = { server, promise: Promise.resolve().then(fetchDirectory) };
    inFlight = request;
    return request.promise;
    async function fetchDirectory(): Promise<Directory> {
      try {
        const signal = active;
        const previous =
          cached?.server === server
            ? cached.data
            : store.document<Directory>('zotero-directory', server);
        let version: string | null = null;
        function sameVersion(h: Headers) {
          const next = h.get('Last-Modified-Version');
          if (next !== null) {
            invariant(
              version === null || next === version,
              'zotero_changed',
              '同步期间文献库已改变，请刷新',
            );
            version = next;
          }
        }
        const [collections, items, attachments] = await Promise.all([
          all('collections', signal, sameVersion),
          all('items/top', signal, sameVersion),
          all('items?itemType=attachment', signal, sameVersion),
        ]);
        signal.throwIfAborted();
        invariant(server === scope() && inFlight === request, 'zotero_changed', '文献库连接已改变');
        const links = allLinks(server);
        const old =
          previous ??
          (await legacyDirectory(store, server, links, (vault, ids) =>
            files.entries.titles(vault, ids, { kind: 'mcp' }),
          ));
        signal.throwIfAborted();
        invariant(server === scope() && inFlight === request, 'zotero_changed', '文献库连接已改变');
        const data = reconcileDirectory(
          old,
          collections.filter((r) => !r.data.deleted),
          items.filter((r) => !r.data.deleted),
          attachments.filter((r) => !r.data.deleted),
          links,
        );
        const catalog: Catalog = {
          collections: data.collections.map((c) => ({
            key: c.key,
            name: c.data.name,
            parentCollection: c.data.parentCollection || false,
          })),
          members: Object.fromEntries(data.items.map((i) => [i.key, i.data.collections || []])),
        };
        store.transaction(() => {
          store.put('zotero-catalog', server, catalog);
          store.put('zotero-directory', server, data);
        });
        remember(server, data);
        syncIssue = '';
        return data;
      } catch (error) {
        if (server === scope() && !active.aborted)
          syncIssue =
            error instanceof TypeError
              ? '无法连接本机 Zotero'
              : error instanceof Error
                ? error.message
                : '文献库刷新失败';
        throw error;
      } finally {
        if (inFlight === request) inFlight = undefined;
      }
    }
  }
  async function directory(force = false) {
    const server = scope();
    invariant(server, 'zotero_setup', '请先在扩展设置中连接本机 Zotero 文献库。');
    if (cached && cached.server !== server) invalidate();
    if (!cached) {
      const saved = store.document<Directory>('zotero-directory', server);
      if (saved) remember(server, saved);
      else if (store.document<Catalog>('zotero-catalog', server)) {
        const old = await legacyDirectory(store, server, allLinks(server), (v, ids) =>
          files.entries.titles(v, ids, { kind: 'mcp' }),
        );
        invariant(server === scope(), 'zotero_changed', '文献库连接已改变');
        if (!cached) remember(server, old);
      }
    }
    if (force || !cached) {
      try {
        await sync(server);
      } catch (e) {
        invariant(server === scope(), 'zotero_changed', '文献库连接已改变');
        if (!cached) throw new Error(syncIssue || '请打开 Zotero，完成首次目录同步。');
      }
    } else if (Date.now() - lastAttempt > 60000) {
      void sync(server).catch(() => {});
    }
    invariant(cached?.server === server, 'zotero_changed', '文献库连接已改变');
    return cached;
  }
  async function refresh(signal: AbortSignal) {
    const data = await sync(scope());
    signal.throwIfAborted();
    return { collections: data.collections.length, items: data.items.length };
  }
  return {
    manifest: defineManifest(manifest),
    config: { schema: config },
    activate(ctx) {
      const op = operations(ctx, 'zotero');
      active = ctx.signal;
      ctx.dispose(invalidate);
      op(
        'browse',
        '按分组浏览和搜索文献库',
        browseLibrary,
        'zotero.read',
        async (v, signal) => {
          const { server, data, view } = await directory(v.refresh);
          const links = await localLinks(server);
          const rows = await browseCatalog(
            view,
            v,
            links,
            async (vault, ids) => {
              try {
                return await knowledge.indexCoverage(vault, ids, signal);
              } catch (error) {
                signal.throwIfAborted();
                return {};
              }
            },
            data.baselines,
            (refs, attachments) => verifyLegacy(server, refs, attachments, signal),
          );
          invariant(server === scope(), 'zotero_changed', '文献库连接已改变');
          return {
            ...rows,
            importDestination: 'Zotero 文献库',
            knowledgeScopes: knowledge
              .vaults()
              .filter((vault) =>
                links.some((l) => l.vaultId === vault.id && l.state === 'completed'),
              )
              .map((vault) => ({
                vaultId: vault.id,
                title: vault.name,
                collectionId:
                  v.group === archivedGroup
                    ? archivedGroup
                    : v.group
                      ? 'zotero-collection-' + v.group
                      : 'zotero-library',
              })),
            sync: {
              updatedAt: data.syncedAt,
              pending: inFlight?.server === server,
              issue: syncIssue || undefined,
            },
          };
        },
        false,
      );
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
              storedPDF(file) &&
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
          const hash = createHash('sha256'),
            checksum = createHash('md5');
          for await (const chunk of createReadStream(path, { signal })) {
            hash.update(chunk);
            checksum.update(chunk);
          }
          const sourceMd5 = checksum.digest('hex');
          invariant(
            !file.data.md5 || String(file.data.md5).toLowerCase() === sourceMd5,
            'zotero_changed',
            '本机附件与目录不一致，请先同步 Zotero。',
          );
          invariant(serverId === scope(), 'zotero_changed', '文献库连接已改变');
          const sha256 = hash.digest('hex');
          const linked = await localLinks(serverId);
          const available = linked.filter(
            (r) =>
              r.state === 'completed' &&
              r.sha256 === sha256 &&
              (!v.vaultId || r.vaultId === v.vaultId),
          );
          const found = available.find((r) => r.itemKey === file.data.parentItem) ?? available[0];
          if (found) {
            const identity = JSON.stringify([
              serverId,
              file.data.parentItem,
              found.vaultId,
              v.attachment,
              sha256,
            ]);
            store.put('zotero-references', identity, {
              serverId,
              vaultId: found.vaultId,
              documentId: found.documentId,
              jobId: found.jobId,
              sha256,
              itemKey: file.data.parentItem,
              attachmentKey: v.attachment,
              sourceMd5,
              sourceName: file.data.filename,
              sourceMtime: file.data.mtime,
              sourceVersion: file.version,
            });
            return { reused: true, documentId: found.documentId, vaultId: found.vaultId };
          }
          // A retry after an upgrade keeps its original destination and receipt.
          const existing = linked.find(
            (r) =>
              r.attachmentKey === v.attachment &&
              r.sha256 === sha256 &&
              r.jobId &&
              r.state !== 'unavailable',
          );
          const vaultId =
            v.vaultId ??
            existing?.vaultId ??
            (await knowledge.managedVault('zotero', 'Zotero 文献库')).id;
          const missing = linked.filter(
            (r) =>
              r.state === 'unavailable' &&
              r.vaultId === vaultId &&
              r.attachmentKey === v.attachment &&
              r.sha256 === sha256,
          );
          const requestId =
            'zotero-' +
            createHash('sha256')
              .update(
                [
                  serverId,
                  vaultId,
                  v.attachment,
                  sha256,
                  ...new Set(missing.map((r) => r.documentId).sort()),
                ].join('/'),
              )
              .digest('hex');
          const job = await knowledge.queueImport(
            vaultId,
            path,
            requestId,
            undefined,
            undefined,
            vaultId === 'managed-zotero' ? 'zotero' : undefined,
          );
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
            attachmentKey: v.attachment,
            sourceMd5,
            sourceName: file.data.filename,
            sourceMtime: file.data.mtime,
            sourceVersion: file.version,
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
      for (const page of manifest.pages)
        ctx.capabilities.provide('core.ui.pages@1', page.id, page.title, () => page);
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
        async (v, _s, caller) => {
          const { data, view } = await directory();
          const activeKeys = new Map(data.items.map((i) => [i.key, i]));
          const words = v.query.toLocaleLowerCase().trim().split(/\s+/);
          const links = (await localLinks(scope(), caller)).filter((r) => r.state === 'completed');
          return view.entries
            .filter(
              (i) => activeKeys.has(i.key) && words.every((w: string) => i.search.includes(w)),
            )
            .slice(0, v.limit)
            .map((i) => {
              const docs = linkedDocuments(
                i,
                links.filter((l) => l.itemKey === i.key),
                data.baselines[i.key],
              );
              const current = docs.filter((d) => !d.sourceState);
              return {
                key: i.key,
                title: i.title,
                doi: activeKeys.get(i.key)?.data.DOI,
                uri: 'zotero://select/library/items/' + i.key,
                knowledge: current.length === 1 ? current[0] : undefined,
                documents: docs,
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
          const server = scope();
          let item: Item,
            children: Item[],
            local = false;
          try {
            [item, children] = await Promise.all([
              call('items/' + v.key, s),
              all('items/' + v.key + '/children', s),
            ]);
          } catch (error) {
            s.throwIfAborted();
            if (!(
              error instanceof TypeError ||
              (error instanceof Error && error.name === 'TimeoutError')
            ))
              throw error;
            const { data } = await directory();
            const saved =
              data.items.find((i) => i.key === v.key) ?? data.archived.find((i) => i.key === v.key);
            if (!saved) throw error;
            item = saved;
            children = data.attachments.filter((i) => i.data.parentItem === v.key);
            local = true;
          }
          invariant(server === scope(), 'zotero_changed', '文献库连接已改变');
          return {
            key: item.key,
            cached: local,
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
      op(
        'collections',
        '列出 Zotero 文献分组',
        z.object({}),
        'zotero.read',
        async () => (await directory()).data.collections,
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
        async (v, s) => {
          const result = await call('items/' + v.key, s, {
            method: 'PATCH',
            headers: { 'If-Unmodified-Since-Version': String(v.version) },
            body: JSON.stringify({ collections: [...new Set(v.collections)] }),
          });
          if (inFlight) await inFlight.promise.catch(() => {});
          lastAttempt = 0;
          return result;
        },
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
              store.put(
                'zotero-references',
                JSON.stringify([serverId, row.itemKey, row.vaultId, row.documentId, row.sha256]),
                { ...row, serverId },
              );
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
          const archived = links.filter((r) => !Object.hasOwn(catalog.members, r.itemKey));
          if (archived.length || collectionId === archivedGroup) {
            nodes.push({ id: archivedGroup, title: '已移出文献库', kind: 'group' });
            if (collectionId === archivedGroup)
              return { nodes, documentIds: archived.map((r) => r.documentId) };
          }
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
