import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { conversation, FakeBackend, setup } from './helpers.ts';
import { echoToolPermissions } from '../packages/kernel/tool-access.ts';
import { observationConfigSchema } from '../packages/contracts/index.ts';

test('shared modules remain grantable while every generic library read respects the character', async (t) => {
  const app = await setup(t);
  for (const id of ['agenda', 'mail', 'reflections']) await app.plugins.enable(id);
  const grants = ['persona.read', 'memory.read', 'knowledge.read', 'agenda.read', 'mail.read',
    'delegation.read', 'delegation.write', 'review.read', 'reflections.read'];
  const chat = conversation(app);
  app.store.set('mcp.permissions', grants);
  app.store.put('characters', 'companion', { id: 'companion', toolPermissions: grants, features: [] });
  const caller = { kind: 'mcp' as const, personaId: 'companion', conversationId: chat.id,
    permissions: echoToolPermissions(app.store, false, { personaId: 'companion', conversationId: chat.id }, app.plugins.characterPermissions()) };
  assert.deepEqual([...caller.permissions], grants);
  const tools = new Set(app.registry.list(caller, true).map((tool) => tool.name));
  for (const tool of ['agenda.list', 'mail.read', 'delegation.request', 'review.list', 'reflections.list']) assert(tools.has(tool), tool);
  await app.memories.save({ id: 'other', personaId: 'other', title: 'Other private',
    text: 'PRIVATE_OTHER_MARKER', core: false, tags: [], sources: [] });
  await app.memories.save({ id: 'mine', personaId: 'companion', title: 'Mine',
    text: 'PRIVATE_MINE_MARKER', core: false, tags: [], sources: [] });
  const listed = await app.registry.call('knowledge.list', {}, caller);
  assert(listed.some((row: any) => row.id === 'memory-mine'));
  assert(!listed.some((row: any) => row.id === 'memory-other'));
  await assert.rejects(app.registry.call('knowledge.read', { id: 'memory-other' }, caller), /memory-other/);
  await assert.rejects(app.registry.call('knowledge.revisions', { id: 'memory-other', vaultId: 'managed-memory' }, caller));
  const hits = await app.registry.call('knowledge.search', { query: 'PRIVATE_OTHER_MARKER', kind: 'all' }, caller);
  assert(hits.every((hit: any) => hit.documentId !== 'memory-other' && !hit.text?.includes('PRIVATE_OTHER_MARKER')));
  assert((await app.registry.call('knowledge.read', { id: 'memory-mine' }, caller)).content.includes('PRIVATE_MINE_MARKER'));
  const recall = await app.registry.call('memory.recall', { personaId: 'companion', text: 'Mine' }, caller);
  assert(Array.isArray(recall));
});

test('long stable context cannot suppress a recalled fact that is absent from the final input', async (t) => {
  const app = await setup(t), backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const profile: any = app.store.document('profiles', 'test');
  app.store.put('profiles', 'test', { ...profile, contextChars: 10000 });
  app.store.put('personas', 'companion', { id: 'companion', name: 'Synthetic', prompt: 'P'.repeat(7000) });
  app.store.set('memory.config', { planner: false, useSemantic: false, threshold: 0 });
  const memory = await app.memories.save({ personaId: 'companion', title: '小猫团子',
    text: 'AUDIT_MEMORY_MARKER 小猫名字叫团子。', core: false, tags: [], sources: [] });
  const chat = conversation(app, { injection: true });
  app.store.append(chat.id, 'system', 'import', 'AUDIT_MEMORY_MARKER ' + 'M'.repeat(1450), undefined,
    { kind: 'memory', memoryVersion: memory.id + ':' + memory.version });
  app.store.append(chat.id, 'user', 'human', 'H'.repeat(900));
  app.store.append(chat.id, 'assistant', 'chat', 'A'.repeat(900));
  const run = await app.router.send({ conversationId: chat.id, text: '小猫团子的名字是什么', requestId: 'long-prefix' });
  assert.equal(run.state, 'succeeded', run.error ?? '');
  assert(backend.calls[0].messages.some((message) => message.text.includes('AUDIT_MEMORY_MARKER')));
  assert(backend.calls[0].messages.reduce((n, m) => n + m.text.length, 0) <= 10000);
});

test('zero observation history sends no prior summaries', async (t) => {
  const app = await setup(t), backend = new FakeBackend();
  app.router.backends.set('api', backend);
  backend.responder = async () => ({ text: '{"summary":"Synthetic","attention":""}' });
  app.observations.configure(observationConfigSchema.parse({ id: 'zero', historyRounds: 0 }));
  await app.observations.record({ id: 'prior', taskId: 'zero', personaId: 'companion', conversationId: '',
    timestamp: new Date(Date.now() + 1000).toISOString(), frameTimes: [], sources: ['fixture'],
    summary: 'PRIOR_SHOULD_NOT_BE_SENT', interesting: false });
  const jpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: 'green' } }).jpeg().toBuffer();
  await app.observations.process(Array.from({ length: 4 }, (_, i) => ({
    timestamp: new Date(Date.now() + 2000 + i).toISOString(), source: 'fixture', title: 'Synthetic',
    ruleId: 'fixture', jpeg, signature: new Uint8Array(), generation: 0,
  })), undefined, 'zero');
  assert.deepEqual(JSON.parse(backend.calls[0].messages[1].text).previous, []);
});

test('manual reconciliation retains the original failure for diagnosis', async (t) => {
  const app = await setup(t), chat = conversation(app);
  app.store.createRun({ id: 'unknown', requestId: 'unknown', conversationId: chat.id, profileId: 'test',
    epoch: 0, state: 'unknown', input: 'Synthetic', source: 'human', error: 'Original wait timeout',
    createdAt: new Date().toISOString(), meta: {} });
  const run = app.router.resolveUnknown('unknown');
  assert.equal(run.error, 'Original wait timeout');
  assert.equal((run.meta.reconciliation as any).originalState, 'unknown');
});
