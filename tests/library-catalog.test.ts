import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { browseLibrary } from '../packages/contracts/library-catalog.ts';
import { buildCatalog, browseCatalog } from '../plugins/zotero/catalog.ts';
import { navigationSections } from '../apps/workbench/src/navigation.ts';
const item = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data });

test('library browsing includes unlinked records, descendant groups, multiple attachments and distinct index states', async () => {
  const data = buildCatalog(
    [
      item('PARENT23', { name: 'Group' }),
      item('CHILD234', { name: 'Subgroup', parentCollection: 'PARENT23' }),
    ],
    [
      item('ARTICLE2', {
        title: 'Example',
        extra: 'Legacy Catalog Caption: Good fit\nLegacy Catalog Rating: 4',
        collections: ['CHILD234', 'PARENT23'],
      }),
      item('ARTICLE3', { title: 'Unlinked', collections: [] }),
    ],
    [
      item('FILE2222', {
        filename: 'sample.pdf',
        parentItem: 'ARTICLE2',
        contentType: 'application/pdf',
        linkMode: 'imported_file',
      }),
      item('FILE3333', { filename: 'support.txt', parentItem: 'ARTICLE2' }),
    ],
  );
  const links = ['one', 'two'].map((documentId) => ({
    itemKey: 'ARTICLE2',
    vaultId: 'local',
    documentId,
    sha256: 'a'.repeat(64),
    state: 'completed',
  }));
  const coverage = async (_vault: string, ids: string[]) => {
    assert.deepEqual(ids, ['one', 'two']);
    return { one: 'ready' as const, two: 'missing' as const };
  };
  const group = await browseCatalog(
    data,
    browseLibrary.parse({ group: 'PARENT23', query: 'sample.pdf' }),
    links,
    coverage,
  );
  assert.equal(group.total, 1);
  const row = group.rows[0];
  assert.equal(row.cells.index, '部分索引');
  assert.equal(row.cells.rating, '4');
  assert.equal(row.cells.caption, 'Good fit');
  assert.equal(row.documents?.length, 2);
  assert.equal(row.files?.length, 2);
  assert.deepEqual(row.files?.[0].action?.input, { attachment: 'FILE2222' });
  assert.equal(row.files?.[1].action, undefined);
  const plain = await browseCatalog(
    data,
    browseLibrary.parse({ offset: 1, limit: 1 }),
    links,
    coverage,
  );
  assert.equal(plain.total, 2);
  assert.equal(plain.rows[0].cells.imported, '未入库');
});

test('registered knowledge tabs use plugin scopes, live pagination and read-only index coverage', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('zotero');
  await app.plugins.enable('memory');
  app.store.set('zotero.config', { serverId: 'fixture', secretRef: 'fixture' });
  t.mock.method(app.secrets, 'get', async () => 'fixture');
  const seen: string[] = [];
  const items = Array.from({ length: 104 }, (_, i) =>
    item(String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)) + 'ABCDEF', {
      title: 'Sample ' + i,
      collections: ['COLLECTA'],
    }),
  );
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const u = new URL(String(input));
    assert.equal(u.origin, 'http://127.0.0.1:23119');
    assert.equal(init.headers['Zotero-Server-ID'], 'fixture');
    assert.equal(init.method ?? 'GET', 'GET');
    seen.push(u.pathname + u.search);
    if (u.pathname.endsWith('/collections'))
      return Response.json([item('COLLECTA', { name: 'Collection' })]);
    if (u.searchParams.get('itemType') === 'attachment') return Response.json([]);
    const start = Number(u.searchParams.get('start'));
    return Response.json(items.slice(start, start + 100));
  });
  const tabs = navigationSections(await app.frontend.pages())
    .find((s) => s.id === 'knowledge')!
    .views.map((p) => p.id);
  assert.deepEqual(tabs, ['knowledge', 'zotero.library', 'memory.library']);
  const rows = await app.frontend.invoke('zotero.library', 'zotero.browse', {
    offset: 100,
    group: 'COLLECTA',
  });
  assert.equal(rows.total, 104);
  assert.equal(rows.rows.length, 4);
  const requests = seen.length;
  assert.equal(
    (await app.frontend.invoke('zotero.library', 'zotero.browse', { query: 'Sample 103' })).rows
      .length,
    1,
  );
  assert.equal(seen.length, requests);
  await assert.rejects(app.frontend.invoke('zotero.library', 'zotero.setCollections', {}));
  app.store.put('personas', 'reader-a', { id: 'reader-a', name: 'Reader A' });
  app.store.put('personas', 'reader-b', { id: 'reader-b', name: 'Reader B' });
  for (const id of ['reader-a', 'reader-b'])
    app.store.put('memories', id, {
      id,
      personaId: id,
      title: id,
      text: 'sample',
      tags: [],
      core: true,
      updatedAt: '2026-01-01',
    });
  const memories = await app.frontend.invoke('memory.library', 'memory.browse', {
    scope: 'reader-a',
    group: 'core',
  });
  assert.deepEqual(
    memories.rows.map((r: { id: string }) => r.id),
    ['reader-a'],
  );
  await assert.rejects(app.frontend.invoke('memory.library', 'memory.browse', { scope: 'absent' }));
  await app.plugins.disable('zotero');
  assert.ok(!(await app.frontend.pages()).some((p) => p.id === 'zotero.library'));
  await assert.rejects(app.frontend.invoke('zotero.library', 'zotero.browse', {}));
});
