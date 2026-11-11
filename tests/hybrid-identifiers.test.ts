import test from 'node:test';
import assert from 'node:assert/strict';
import { Retrieval } from '../packages/kernel/retrieval.ts';
import { Capabilities } from '../packages/kernel/capabilities.ts';
import { setup } from './helpers.ts';

test('hybrid retrieval preserves exact title codes under partial vector coverage without changing pure semantic ranking', async () => {
  const capabilities = new Capabilities();
  const retrieval = new Retrieval(capabilities);
  const owner = capabilities.forOwner(
    {
      id: 'fixture',
      permissions: new Set(['knowledge.enhance']),
      signal: new AbortController().signal,
    },
    () => {},
  );
  retrieval.define(
    capabilities.forOwner(
      { id: 'core', permissions: new Set(['*']), signal: new AbortController().signal },
      () => {},
    ),
  );
  retrieval.register(
    {
      id: 'fixture.provider',
      rank: async (_scope, _query, records) =>
        records
          .filter((r) => r.id !== 'new')
          .map((r) => ({ ...r, score: 0.95, method: 'semantic' })),
    },
    owner,
  );
  const records = [
    {
      id: 'new',
      version: '1',
      title: 'X0712 collagen instruction.pdf',
      text: 'X0712 ' + 'collagen '.repeat(200),
    },
    ...Array.from({ length: 40 }, (_, i) => ({
      id: 'old' + i,
      version: '1',
      title: 'Older collagen reference',
      text: 'collagen experiment',
    })),
  ];
  const search = (query: string, strategy: 'hybrid' | 'semantic' | 'keyword' = 'hybrid') =>
    retrieval.search(
      'knowledge',
      [{ text: query, weight: 1 }],
      records,
      new AbortController().signal,
      strategy,
    );
  const hybrid = await search('X0712');
  assert.equal(hybrid[0].id, 'new');
  assert(hybrid[0].score > hybrid[1].score);
  assert(hybrid.every((h) => h.score <= 1));
  assert(!(await search('X0712', 'semantic')).some((h) => h.id === 'new'));
  assert.equal((await search('X0712', 'keyword'))[0].id, 'new');
  assert.notEqual((await search('X07120'))[0].id, 'new');
  assert.equal((await search('collagen instruction.pdf'))[0].id, 'new');
});

test('knowledge default hybrid policy returns a newly imported exact-title match in its authorized folder', async (t) => {
  const app = await setup(t);
  const target = await app.knowledge.save(
    'local',
    'X0712 collagen instruction.pdf',
    'X0712 ' + 'synthetic collagen '.repeat(200),
    { path: 'Manual/Example/new.md' },
  );
  for (let n = 0; n < 16; n++)
    await app.knowledge.save('local', 'Older reference ' + n, 'collagen background experiment', {
      path: 'Research/' + n + '.md',
    });
  app.retrieval.register(
    {
      id: 'fixture.partial',
      rank: async (_scope, _query, records) =>
        records
          .filter((r) => r.documentId !== target.id)
          .map((r) => ({ ...r, score: 0.98, method: 'semantic' })),
    },
    app.capabilities.forOwner(
      {
        id: 'fixture',
        permissions: new Set(['knowledge.enhance']),
        signal: new AbortController().signal,
      },
      () => {},
    ),
  );
  app.store.set('knowledge.config', { strategy: 'hybrid' });
  const caller = { kind: 'mcp' as const, permissions: new Set(['knowledge.read']) };
  const hits = await app.registry.call(
    'knowledge.search',
    { query: 'X0712', vaultId: 'local', limit: 5 },
    caller,
  );
  assert.equal(hits[0].documentId, target.id);
  const other = await app.registry.call(
    'knowledge.search',
    { query: 'X0712', vaultId: 'local', folder: 'Research', limit: 5 },
    caller,
  );
  assert(!other.some((h: any) => h.documentId === target.id));
});
