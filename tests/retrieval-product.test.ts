import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildLocalQuery, naturalHistory, bm25 } from '../packages/kernel/search-query.ts';
import { setup, FakeBackend } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { inferenceTasks } from '../packages/contracts/inference.ts';

test('local conversation queries are bounded, recency weighted and exclude injected/tool material', () => {
  const history = [
    { role: 'user', text: '上次讨论的是显微镜和神经元成像' },
    { role: 'system', text: '机密旧记忆绝不能成为查询' },
    { role: 'assistant', text: '污染条目', meta: { memoryVersion: 'm:1' } },
    { role: 'tool', text: '污染工具日志'.repeat(400) },
    { role: 'user', text: '昨天去了杭州' },
  ];
  const query = buildLocalQuery('不想去北京，2026-11-08 还是杭州。查 C:/Research/paper.md', history, { maxChars: 100 });
  assert(query.length <= 100); assert(query.includes('杭州')); assert(query.includes('不'));
  assert(query.includes('2026-11-08')); assert(query.includes('c:/research/paper.md'));
  assert(!query.includes('污染')); assert(!query.includes('机密'));
  assert.equal(naturalHistory(history, 4).length, 2);
  assert.equal(buildLocalQuery('嗯'), '');
});
test('BM25 uses term frequency and corpus rarity rather than matching only token overlap', () => {
  const hits = bm25('falcon', [
    { id: 'good', version: '1', title: 'Falcon', text: 'falcon nesting' },
    { id: 'long', version: '1', text: 'falcon ' + 'generic '.repeat(100) },
    { id: 'wrong', version: '1', text: 'otter nesting' },
  ]);
  assert.equal(hits[0].id, 'good'); assert.equal(hits.at(-1)?.score, 0);
});
test('memory query policy belongs to each role and requires neither parser nor vectors', async (t) => {
  const app = await setup(t, ['memory']);
  const backend = new FakeBackend(); app.router.backends.set('api', backend);
  const create = (id: string, planner: boolean) => app.registry.call('persona.character.commit', {
    requestId: id, draft: characterDraft.parse({ persona: { id, name: id, prompt: 'Original character' }, features: ['memory'],
      profileId: 'test', configurations: { memory: { planner, useSemantic: false, queryChars: 80 } } }),
  }, internal);
  await create('local-role', false); await create('model-role', true);
  for (const personaId of ['local-role', 'model-role']) await app.memories.save({ personaId, title: '杭州', text: '喜欢杭州的西湖', tags: [], sources: [], core: false });
  const local = await app.memories.recall('local-role', '杭州', [], new AbortController().signal);
  assert.equal(local.length, 1); assert.equal(backend.calls.length, 0);
  backend.responder = async () => ({ text: '{"queries":["杭州 西湖"]}' });
  assert.equal((await app.memories.recall('model-role', '那个湖', [], new AbortController().signal)).length, 1);
  assert.equal(backend.calls.length, 1);
  assert(app.plugins.isBuiltin('knowledge')); assert.equal(app.localModels.status().loaded,0); assert(!app.plugins.active.has('semantic'));
  assert.equal(app.router.inference.task(inferenceTasks.query)?.scope, 'character');
});
test('retrieval enhancement exposes rerank models without loading an encoder and rejects foreign indexes', async (t) => {
  const app = await setup(t, ['semantic', 'knowledge']);
  assert.equal(app.localModels.status().loaded,0);
  const kinds = await app.router.inference.kinds();
  assert(kinds.some((kind) => kind.capability === 'reranking')); assert(kinds.some((kind) => kind.capability === 'embedding'));
  let invalid = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); assert.equal(payload.documents.length, 2); assert.equal(req.url, '/v1/rerank');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ results: [{ index: invalid ? 99 : 1, relevance_score: .98 }, { index: 0, relevance_score: .1 }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  await app.router.inference.saveConnection({ id: 'rerank-api', name: 'Reranker', adapterId: 'core.api', config: { endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` } });
  const model = await app.router.inference.saveModel({ id: 'reranker', name: 'Fixture reranker', connectionId: 'rerank-api', model: 'synthetic-rerank', generation: { enabled: false, inputs: ['text'] }, reranking: { enabled: true, inputs: ['text'] } });
  assert(app.router.inference.compatible(model, app.router.inference.task(inferenceTasks.rerank)!));
  app.store.set('routes', { ...app.store.get('routes', {}), [inferenceTasks.rerank]: model.id });
  app.store.set('semantic.config', { rerankMethod: 'model' });
  const rank = () => app.capabilities.invoke(app.router.inference.owner, 'knowledge.rerank@1', 'semantic.rerank', { query: 'query', candidates: [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }] });
  assert.deepEqual(await rank(), ['b', 'a']); invalid = true; await assert.rejects(rank, /无效编号/);
  await app.plugins.disable('semantic'); assert(!(await app.router.inference.kinds()).some((kind) => kind.capability === 'reranking'));
});
