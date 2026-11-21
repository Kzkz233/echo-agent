import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import type { Item } from '../plugins/zotero/catalog.ts';

const paper = 'ARTICLEA',
  attachment = 'FILEAAAA',
  group = 'COLLECTA';
const item = (key: string, data: Record<string, unknown>, version = 1): Item => ({
  key,
  version,
  data,
});

test('offline reading and reconciliation survive renames, replacement, deletion, restoration and interrupted scans', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('zotero');
  app.store.set('zotero.config', { serverId: 'fixture', secretRef: 'fixture' });
  t.mock.method(app.secrets, 'get', async () => 'test');
  const doc = await app.knowledge.save(
    'local',
    'Original knowledge title',
    'Edited local text to preserve.',
  );
  const link = {
    serverId: 'fixture',
    itemKey: paper,
    vaultId: 'local',
    documentId: doc.id,
    sha256: 'a'.repeat(64),
  };
  app.store.put('zotero-references', 'legacy', link);
  app.store.put('zotero-catalog', 'fixture', {
    collections: [{ key: group, name: 'Earlier group', parentCollection: false }],
    members: { [paper]: [group] },
  });
  let parents = [item(paper, { title: 'Original paper', collections: [group] })];
  let files = [
    item(attachment, {
      parentItem: paper,
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      md5: 'one',
    }),
  ];
  let offline = true,
    partial = false;
  let version = 1,
    inconsistent = false;
  t.mock.method(globalThis, 'fetch', async (input: any) => {
    if (offline) throw new TypeError('fetch failed');
    const url = new URL(input);
    const attachments = url.searchParams.get('itemType') === 'attachment';
    if (partial && attachments) return new Response('', { status: 503 });
    const rows = attachments
      ? files
      : url.pathname.endsWith('/collections')
        ? [item(group, { name: 'Live group' })]
        : parents;
    return Response.json(rows, {
      headers: {
        'Last-Modified-Version': String(attachments && inconsistent ? version + 1 : version),
        'Total-Results': String(rows.length),
      },
    });
  });
  const browse = (extra: Record<string, unknown> = {}) =>
    app.frontend.invoke('zotero.library', 'zotero.browse', extra);
  const sync = () => app.registry.call('zotero.refresh', {}, internal);
  const read = () =>
    app.registry.call('knowledge.read', { vaultId: 'local', id: doc.id }, internal);
  assert.equal((await browse()).rows[0].cells.title, 'Original knowledge title');
  await assert.rejects(sync());
  offline = false;
  await sync();
  assert.equal((await browse()).rows[0].cells.title, 'Original paper');
  parents = [
    item(paper, { title: 'Renamed paper', collections: [] }, ++version),
    item('ARTICLEB', { title: 'New paper', collections: [group] }),
  ];
  await sync();
  assert.equal((await browse({ group })).total, 1);
  const renamed = (await browse({ query: 'Renamed' })).rows[0];
  assert.equal(renamed.documents[0].documentId, doc.id);
  assert.equal(renamed.documents[0].sourceState, undefined);
  assert.equal((await read()).content, 'Edited local text to preserve.');
  files = [item(attachment, { ...files[0].data, md5: 'two' }, ++version)];
  await sync();
  assert.equal((await browse({ query: 'Renamed' })).rows[0].documents[0].sourceState, 'check');
  app.store.put('zotero-references', 'verified', {
    ...link,
    attachmentKey: attachment,
    sourceMd5: 'one',
    sourceName: 'paper.pdf',
  });
  assert.equal((await browse({ query: 'Renamed' })).rows[0].documents[0].sourceState, 'changed');
  partial = true;
  parents = [];
  await assert.rejects(sync());
  assert.equal((await browse()).total, 2);
  partial = false;
  inconsistent = true;
  await assert.rejects(sync());
  assert.equal((await browse()).total, 2);
  inconsistent = false;
  await sync();
  assert.equal((await browse()).total, 0);
  const archived = await browse({ group: 'zotero-archived' });
  assert.equal(archived.rows[0].documents[0].sourceState, 'removed');
  assert.equal((await read()).version, doc.version);
  parents = [item(paper, { title: 'Recovered paper', collections: [group] })];
  files = [item(attachment, { ...files[0].data, md5: 'one' })];
  await sync();
  offline = true;
  await app.plugins.disable('zotero');
  await app.plugins.enable('zotero');
  const restored = await browse({ refresh: true });
  assert.ok(restored.sync.issue);
  assert.equal(restored.rows.length, 1);
  assert.equal(restored.rows[0].documents[0].documentId, doc.id);
  assert.equal(restored.rows[0].documents[0].sourceState, undefined);
  assert.equal((await browse({ group: 'zotero-archived' })).total, 0);
  const caller = { kind: 'mcp' as const, permissions: new Set(['zotero.read']) };
  assert.equal(
    (await app.registry.call('zotero.search', { query: 'Recovered' }, caller))[0].knowledge
      .documentId,
    doc.id,
  );
  assert.equal((await app.registry.call('zotero.item', { key: paper }, caller)).cached, true);
  await assert.rejects(
    app.registry.call('zotero.setCollections', { key: paper, version, collections: [] }, caller),
  );
  assert.deepEqual(restored.knowledgeScopes, [
    { vaultId: 'local', title: 'Personal Knowledge', collectionId: 'zotero-library' },
  ]);
  const before = await read();
  await app.knowledge.maintain({
    vaultId: 'local',
    items: [{ id: doc.id, revision: before.revision }],
    action: 'archive',
  });
  await app.knowledge.maintain({
    vaultId: 'local',
    items: [{ id: doc.id, revision: (await read()).revision }],
    action: 'delete',
  });
  const locallyRemoved = (await browse()).rows[0];
  assert.equal(locallyRemoved.documents.length, 0);
  assert.equal(locallyRemoved.cells.imported, '知识条目不可用');
  assert.equal(app.store.documents('knowledge-jobs').length, 0);
});

test('legacy files retain their pages while new siblings use the connector vault and a single scoped hybrid search', async (t) => {
  const app = await setup(t);
  assert.equal(
    (await app.frontend.pages()).some((p) => p.id === 'zotero.library'),
    false,
  );
  await app.plugins.enable('zotero');
  await app.plugins.enable('documents');
  app.store.set('zotero.config', { serverId: 'fixture', secretRef: 'fixture' });
  t.mock.method(app.secrets, 'get', async () => 'fixture');
  const main = 'main PDF fixture',
    extra = 'additional PDF fixture';
  const md5 = (text: string) => createHash('md5').update(text).digest('hex');
  const source = join(app.runtime, 'main.pdf'),
    supplement = join(app.runtime, 'supplement.pdf');
  await writeFile(source, main);
  await writeFile(supplement, extra);
  const original = await app.files.import('local', source);
  const legacy = await app.knowledge.save('local', 'Original', 'Sentinel existing page.', {
    sourceHash: original.hash,
    sourceFileId: original.id,
  });
  const unrelated = await app.knowledge.save('local', 'Outside selection', 'Sentinel outside.');
  app.store.put('zotero-references', 'pre-migration', {
    serverId: 'fixture',
    itemKey: paper,
    vaultId: 'local',
    documentId: legacy.id,
    sha256: original.hash,
  });
  const files = [
    item(attachment, {
      itemType: 'attachment',
      parentItem: paper,
      linkMode: 'imported_file',
      filename: 'main.pdf',
      contentType: 'application/pdf',
      md5: md5(main),
    }),
    item('FILEBBBB', {
      itemType: 'attachment',
      parentItem: paper,
      linkMode: 'imported_file',
      filename: 'supplement.pdf',
      contentType: 'application/pdf',
      md5: md5(extra),
    }),
    item('WEBAAAAA', {
      itemType: 'attachment',
      parentItem: 'ARTICLEB',
      linkMode: 'linked_url',
      title: 'Website',
    }),
  ];
  const fetcher = t.mock.method(globalThis, 'fetch', async (input: any) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/collections'))
      return Response.json([item(group, { name: 'Fixture group' })]);
    if (url.pathname.endsWith('/file/view/url'))
      return new Response(pathToFileURL(supplement).href);
    if (url.pathname.endsWith('/FILEBBBB')) return Response.json(files[1]);
    if (url.searchParams.get('itemType') === 'attachment') return Response.json(files);
    return Response.json([
      item(paper, { title: 'In group', collections: [group] }),
      item('ARTICLEB', { title: 'Links' }),
      item('ARTICLEC', { title: 'Empty' }),
    ]);
  });
  const browse = (params: object = {}) =>
    app.frontend.invoke('zotero.library', 'zotero.browse', params);
  const first = await browse();
  const parent = first.rows.find((r: any) => r.id === paper);
  assert.deepEqual(
    parent.files.map((f: any) => f.status),
    ['已入库', 'PDF 待入库'],
  );
  assert.equal(first.rows.find((r: any) => r.id === 'ARTICLEB').cells.imported, '仅网页链接');
  assert.equal(first.rows.find((r: any) => r.id === 'ARTICLEC').cells.imported, '无附件');
  assert.equal(app.store.documents('knowledge-jobs').length, 0);
  const parser = t.mock.method(app.files.parsers, 'execute', async () => ({
    text: 'Sentinel supplement page.',
  }));
  const importFile = () =>
    app.frontend.invoke('zotero.library', 'zotero.importAttachment', { attachment: 'FILEBBBB' });
  const job = await importFile();
  assert.equal(job.vaultId, 'managed-zotero');
  await app.knowledge.waitImport(job.jobId, AbortSignal.timeout(6000));
  const receipt = app.store.document<any>('knowledge-jobs', job.jobId);
  assert.equal(receipt.state, 'completed', receipt.error);
  assert.equal((await importFile()).reused, true);
  assert.equal(parser.mock.callCount(), 1);
  const groupView = await browse({ group });
  assert.deepEqual(
    groupView.rows[0].files.map((f: any) => f.status),
    ['已入库', '已入库'],
  );
  const search = (strategy: string) =>
    app.registry.call(
      'knowledge.searchAdvanced',
      { collectionScopes: groupView.knowledgeScopes, query: 'Sentinel', strategy },
      internal,
    );
  const keyword = await search('keyword');
  assert.deepEqual(
    new Set(keyword.map((r: any) => r.documentId)),
    new Set([legacy.id, job.documentId]),
  );
  const rank = t.mock.method(
    app.knowledge.retrieval,
    'rank',
    async (_scope: string, _query: string, records: any[]) => {
      assert.ok(!records.some((r) => r.documentId === unrelated.id));
      return records.map((r) => ({ id: r.id, version: r.version, score: 1, method: 'semantic' }));
    },
  );
  const hits = await search('hybrid');
  assert.equal(rank.mock.callCount(), 1);
  assert.deepEqual(new Set(hits.map((r: any) => r.vaultId)), new Set(['local', 'managed-zotero']));
  assert.ok(hits.every((r: any) => r.method === 'hybrid'));
  assert.equal((await app.knowledge.read(legacy.id, 0, 12000, 'local')).version, legacy.version);
  await assert.rejects(app.knowledge.queueImport('managed-zotero', supplement, 'unauthorized'));
  assert.ok(fetcher.mock.callCount() > 0);
});
