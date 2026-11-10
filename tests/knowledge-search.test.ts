import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FakeBackend, until } from './helpers.ts';
import { prepareKeywordIndex, keywordCandidates } from '../plugins/files/keyword-index.ts';
const ui = { kind: 'ui' as const, permissions: new Set(['*']) };

test('changing an embedding route releases unreferenced idle local models without disabling semantic search', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  await app.plugins.enable('embeddings');
  await app.plugins.enable('local-models');
  let terminated = 0;
  (app.localModels as any).sessions.set('fixture', {
    worker: {
      terminate: async () => {
        terminated++;
      },
    },
    busy: false,
    lastUsed: Date.now(),
    model: 'Synthetic',
    profiles: new Set(['old-local']),
  });
  app.events.emit('routes.changed', {});
  assert.equal(terminated, 1);
  assert.equal((await app.registry.call('local-models.status', {}, ui)).loaded, 0);
  assert(app.registry.list(ui).some((op) => op.name === 'semantic.index'));
});

test('full-text candidates respect scope and stay synchronized after Chinese title edits and deletion', async (t) => {
  const app = await setup(t),
    db = await app.files.database('local');
  const a = await app.knowledge.save('local', '显微成像', '合成记录', { path: 'Work/a.md' }),
    b = await app.knowledge.save('local', '显微成像', '另一份记录', { path: 'Other/b.md' });
  prepareKeywordIndex(db);
  assert.deepEqual(keywordCandidates(db, ['显微成像'], [a.id]), [a.id]);
  db.db.prepare('UPDATE entries SET title=? WHERE id=?').run('天文观测', a.id);
  assert.deepEqual(keywordCandidates(db, ['显微成像'], [a.id]), []);
  assert.deepEqual(keywordCandidates(db, ['天文观测'], [a.id]), [a.id]);
  db.db.prepare('DELETE FROM entries WHERE id=?').run(b.id);
  assert.deepEqual(keywordCandidates(db, ['显微成像'], [a.id, b.id]), []);
});

test('malformed embedding batches do not mark any chunks as indexed', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  await app.plugins.enable('embeddings');
  await app.knowledge.save('local', 'Synthetic', 'invalid embedding');
  (app.semantic as any).embeddings = async () => [[NaN]];
  const job = await app.registry.call(
    'semantic.index',
    { filter: { vaultId: 'local' }, requestId: 'invalid' },
    ui,
  );
  await until(() => app.store.document<any>('semantic-jobs', job.id)?.state === 'failed');
  assert.equal((await app.semantic.indexStatus({ vaultId: 'local' })).indexed, 0);
});

test('weighted multi-query search respects the selected library and exact folder before ranking', async (t) => {
  const app = await setup(t);
  const first = await app.knowledge.save('local', 'Falcon', 'red falcon', {
      path: 'Work/first.md',
    }),
    second = await app.knowledge.save('local', 'Otter', 'blue otter', { path: 'Work/second.md' });
  await app.knowledge.save('local', 'Nested', 'red falcon blue otter', {
    path: 'Work/Nested/item.md',
  });
  const hits = await app.registry.call(
    'knowledge.searchAdvanced',
    {
      query: 'animals',
      vaultId: 'local',
      folder: 'Work',
      folderExact: true,
      strategy: 'keyword',
      queries: [
        { text: 'falcon', weight: 1 },
        { text: 'otter', weight: 4 },
      ],
    },
    ui,
  );
  assert.deepEqual(new Set(hits.map((h: any) => h.documentId)), new Set([first.id, second.id]));
  assert.equal(hits[0].documentId, second.id);
  assert.deepEqual(hits[0].matchedQueries, ['otter']);
});

test('Harness knowledge search uses application policy and does not expose ranking controls', async (t) => {
  const app = await setup(t),
    caller = { kind: 'mcp' as const, permissions: new Set(['knowledge.read']) },
    search = app.registry.list(caller, true).find((operation) => operation.name === 'knowledge.search'),
    advanced = app.registry.list(caller, true).find((operation) => operation.name === 'knowledge.searchAdvanced');
  assert(search);
  assert(!advanced);
  const fields = Object.keys((search.input as any).shape);
  for (const field of ['strategy', 'queries', 'semanticWeight', 'directoryBoost', 'rerank'])
    assert(!fields.includes(field), `MCP knowledge.search should not expose ${field}`);
});

test('a search hit can be read directly at its document offset without changing access scope', async (t) => {
  const app = await setup(t);
  const caller = { kind: 'mcp' as const, personaId: 'companion', permissions: new Set(['knowledge.read']) };
  const text = 'filler '.repeat(300) + 'heliopause ' + 'end '.repeat(200);
  const document = await app.knowledge.save('local', 'Fixture', text);
  const hits = await app.registry.call('knowledge.search', { query: 'heliopause' }, caller);
  const hit = hits.find((value: { offset: number }) => value.offset === 2000);
  assert(hit, 'The search should return a chunk from the middle of the document');
  const read = (id: string, options: { vaultId?: string; offset?: number } = {}) =>
    app.registry.call('knowledge.read', { id, limit: 300, ...options }, caller);
  const excerpt = await read(hit.id);
  assert.equal(excerpt.id, document.id);
  assert.equal(excerpt.offset, hit.offset);
  assert.equal(excerpt.content, text.slice(2000, 2300));
  assert.equal((await read(hit.id, { offset: 0 })).offset, 0);
  assert.equal((await read(document.id, { vaultId: 'local' })).offset, 0);
  await assert.rejects(read(hit.id, { vaultId: 'other' }), /另一个知识库/);

  const privateDocument = await app.knowledge.save('local', 'Private fixture', 'synthetic', {
    metadata: { personaId: 'another-role' },
  });
  await assert.rejects(read(`local:${privateDocument.id}.c.0`));
});

test('knowledge searches never implicitly build the whole vector index; explicit jobs checkpoint and reuse vectors', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  await app.plugins.enable('embeddings');
  let batches = 0,
    queries = 0;
  (app.semantic as any).embeddings = async (
    texts: string[],
    _cfg: any,
    _signal: any,
    kind: string,
  ) => {
    if (kind === 'query') queries++;
    else batches++;
    return texts.map(() => [1, 0]);
  };
  for (let n = 0; n < 12; n++)
    await app.knowledge.save('local', 'Vector ' + n, 'synthetic nebula ' + n, {
      path: `Work/${n}.md`,
    });
  await assert.rejects(
    app.registry.call(
      'knowledge.searchAdvanced',
      { query: 'nebula', vaultId: 'local', strategy: 'semantic' },
      ui,
    ),
    /向量索引/,
  );
  assert.equal(batches, 0);
  const filter = { vaultId: 'local', folder: 'Work' };
  const job = await app.registry.call('semantic.index', { filter, requestId: 'first' }, ui);
  await until(() => app.store.document<any>('semantic-jobs', job.id)?.state === 'completed');
  assert.equal(batches, 2);
  const status = await app.registry.call('semantic.status', { filter }, ui);
  assert.equal(status.index.missing, 0);
  assert.equal(status.index.indexed, 12);
  assert(
    (
      await app.registry.call(
        'knowledge.searchAdvanced',
        { query: 'nebula', vaultId: 'local', strategy: 'hybrid' },
        ui,
      )
    ).length,
  );
  assert.equal(batches, 2);
  assert(queries > 0);
  const resumed = await app.registry.call('semantic.index', { filter, requestId: 'next' }, ui);
  await until(() => app.store.document<any>('semantic-jobs', resumed.id)?.state === 'completed');
  assert.equal(batches, 2);
  await app.plugins.disable('semantic');
  assert(
    (
      await app.registry.call(
        'knowledge.searchAdvanced',
        { query: 'nebula', vaultId: 'local', strategy: 'keyword' },
        ui,
      )
    ).length,
  );
});

test('model expansion and reranking run only on explicit requests and cannot add foreign candidates', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  await app.plugins.enable('embeddings');
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.knowledge.save('local', 'Alpha', 'alpha beta');
  await app.knowledge.save('local', 'Beta', 'alpha beta gamma');
  backend.responder = async (r) => {
    assert.equal(r.reasoning, 'off');
    const input = JSON.parse(r.messages.at(-1)!.text);
    return { text: JSON.stringify(input.candidates.map((c: any) => c.id).reverse()) };
  };
  await app.registry.call(
    'knowledge.searchAdvanced',
    { query: 'alpha', vaultId: 'local', strategy: 'keyword' },
    ui,
  );
  assert.equal(backend.calls.length, 0);
  await app.registry.call(
    'knowledge.searchAdvanced',
    { query: 'alpha', vaultId: 'local', strategy: 'keyword', rerank: true },
    ui,
  );
  assert.equal(backend.calls.length, 1);
  backend.responder = async () => ({ text: '["foreign-id"]' });
  await assert.rejects(
    app.registry.call(
      'knowledge.searchAdvanced',
      { query: 'alpha', vaultId: 'local', strategy: 'keyword', rerank: true },
      ui,
    ),
    /无效条目/,
  );
  backend.responder = async () => ({ text: '["alpha", "beta", "alpha"]' });
  assert.deepEqual(
    await app.registry.call('semantic.expand', { query: 'Find related ideas' }, ui),
    ['alpha', 'beta'],
  );
});
