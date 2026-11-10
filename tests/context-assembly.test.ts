import assert from 'node:assert/strict';
import test from 'node:test';
import { orderContext, type ContextBlock } from '../packages/kernel/context.ts';
import { conversation, FakeBackend, setup } from './helpers.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';
import { contextCompaction } from '../packages/contracts/compaction.ts';

test('context retention defaults to a percentage and converts saved token budgets', () => {
  assert.deepEqual(contextCompaction.parse({}), { triggerTokens: 256000, keepRecentPercent: 8 });
  assert.deepEqual(contextCompaction.parse({ triggerTokens: 1024, keepRecentTokens: 512 }), {
    triggerTokens: 1024, keepRecentPercent: 50,
  });
  assert(!contextCompaction.safeParse({ keepRecentPercent: 100 }).success);
});

test('main Pi compacts by default and keeps canonical history across turns', async (t) => {
  const app = await setup(t, []);
  const fake = new FakeBackend();
  app.router.useConversationRuntime(app.api, { kind: 'pi', generate: (request) => fake.generate(request) });
  const profile = seedProfile(app, {
    ...app.router.profile('test'), id: 'small-window', contextChars: 6000,
  });
  const c = conversation(app, { kind: 'main' });
  await app.router.bind(c.id, profile.id, AbortSignal.timeout(5000));
  const early = 'EARLY ' + 'x'.repeat(1500);
  const recent = 'RECENT ' + 'y'.repeat(1200);
  app.store.append(c.id, 'user', 'human', early, 'early');
  app.store.append(c.id, 'assistant', 'human', 'a'.repeat(1500), 'early');
  app.store.append(c.id, 'user', 'human', recent, 'recent');
  app.store.append(c.id, 'assistant', 'human', 'b'.repeat(1200), 'recent');
  fake.responder = async (request) => ({
    text: request.toolPolicy === 'none' ? 'SYNTHETIC SUMMARY' : 'Synthetic reply',
  });
  const first = await app.router.send({ conversationId: c.id, requestId: 'compact', text: 'Current question' });
  assert.equal(first.state, 'succeeded', first.error ?? 'Compacted turn failed');
  assert.equal(fake.calls.length, 2);
  const [summary, turn] = fake.calls;
  assert.equal(summary.reasoning, 'off');
  assert(summary.messages.some((message) => message.text.includes('EARLY')));
  assert(turn.messages.some((message) => message.role === 'user' && message.text.includes('SYNTHETIC SUMMARY')));
  assert(turn.messages.some((message) => message.text === recent));
  assert(!turn.messages.some((message) => message.text === early));
  assert(app.store.allMessages(c.id).some((message) => message.text === early));
  assert(typeof first.meta.contextInputTokens === 'number' && first.meta.contextInputTokens > 0);
  app.store.append(c.id, 'system', 'observation', 'SYNTHETIC_OBSERVATION');
  const second = await app.router.send({ conversationId: c.id, requestId: 'reuse-compact', text: 'Another question' });
  assert.equal(second.state, 'succeeded', second.error ?? 'Uncompacted turn failed');
  assert.equal(fake.calls.length, 3);
  assert(fake.calls[2].messages.some((message) => message.text.includes('SYNTHETIC SUMMARY')));
  assert(!fake.calls[2].messages.some((message) => message.text === early));
  assert(fake.calls[2].contextDetails?.some((item) => item.group === 'history' && item.source === 'observation'));
  assert(fake.calls[2].contextDetails?.some((item) => item.group === 'history' && item.source === 'summary'));
});

test('main Pi honors a configured token threshold below the model character budget', async (t) => {
  const app = await setup(t, []);
  const fake = new FakeBackend();
  app.router.useConversationRuntime(app.api, { kind: 'pi', generate: (request) => fake.generate(request) });
  const c = conversation(app, { kind: 'main', compaction: { triggerTokens: 1024, keepRecentPercent: 50 } });
  for (let turn = 0; turn < 3; turn++) {
    app.store.append(c.id, 'user', 'human', 'question '.repeat(80), `turn-${turn}`);
    app.store.append(c.id, 'assistant', 'human', 'answer '.repeat(80), `turn-${turn}`);
  }
  const run = await app.router.send({ conversationId: c.id, requestId: 'configured-cap', text: 'Current question' });
  assert.equal(run.state, 'succeeded', run.error ?? 'Configured turn failed');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].toolPolicy, 'none');
  assert(Number(run.meta.contextInputTokens) <= 1024);
  assert.equal(app.store.allMessages(c.id).length, 8);
});

test('context layers order optional contributions consistently and reject invalid constraints', () => {
  const blocks: ContextBlock[] = [
    { id: 'third.turn', layer: 'turn', after: ['missing.turn'] },
    { id: 'third.fixed', layer: 'stable', after: ['base.fixed'] },
    { id: 'base.fixed', layer: 'stable' },
  ];
  assert.deepEqual(orderContext(blocks).map((block) => block.id), ['base.fixed', 'third.fixed', 'third.turn']);
  assert.deepEqual(orderContext(blocks.reverse()).map((block) => block.id), ['base.fixed', 'third.fixed', 'third.turn']);
  assert.throws(() => orderContext([
    { id: 'one.fixed', layer: 'stable', after: ['two.fixed'] },
    { id: 'two.fixed', layer: 'stable', after: ['one.fixed'] },
  ]), { code: 'context_order_cycle' });
  assert.throws(() => orderContext([
    { id: 'one.fixed', layer: 'stable', after: ['two.turn'] },
    { id: 'two.turn', layer: 'turn' },
  ]), { code: 'context_layer_order' });
});

test('core memory precedes history, fresh recall follows it, and knowledge remains explicitly searchable', async (t) => {
  const app = await setup(t);
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const c = conversation(app, { injection: true });
  const meta = { personaId: c.personaId, tags: [], sources: [] };
  await app.memories.save({ ...meta, core: true, title: '固定资料', text: 'FIXED_SENTINEL' }, true);
  await app.memories.save({ ...meta, core: false, title: '宠物名字', text: '小猫名字叫团子。' });
  app.store.put('character-settings.knowledge', c.personaId, { vaultIds: ['local'], strategy: 'keyword' });
  await app.knowledge.save('local', '宠物名字', '宠物名字的知识条目 KNOWLEDGE_SENTINEL');
  app.store.append(c.id, 'system', 'import', 'OLD_KNOWLEDGE', undefined, { knowledgeVersion: 'old:1' });
  app.store.append(c.id, 'user', 'human', 'HISTORY_SENTINEL');
  for (const requestId of ['first-recall', 'second-recall']) {
    const run = await app.router.send({ conversationId: c.id, requestId, text: '小猫名字是什么' });
    assert.equal(run.state, 'succeeded', run.error ?? '');
  }
  const [first, second] = backend.calls.map((call) => call.messages);
  assert.match(first[0].text, /FIXED_SENTINEL/);
  assert.equal(first[1].text, 'HISTORY_SENTINEL');
  assert.equal(first[2].context, 'turn');
  assert.match(first[2].text, /小猫名字叫团子/);
  assert.equal(first.at(-1)!.text, '小猫名字是什么');
  assert.equal(second[0].text, first[0].text);
  assert.equal(second.filter((message) => message.text.includes('小猫名字叫团子')).length, 1);
  assert(second.every((message) => !message.context));
  assert(!JSON.stringify(backend.calls).includes('KNOWLEDGE_SENTINEL'));
  assert(!JSON.stringify(backend.calls).includes('OLD_KNOWLEDGE'));
  assert(app.store.allMessages(c.id).some((message) => message.text === 'OLD_KNOWLEDGE'));
  assert((await app.knowledge.search('宠物名字', new AbortController().signal, 4, { strategy: 'keyword' }))
    .some((hit) => hit.text.includes('KNOWLEDGE_SENTINEL')));
});

test('optional context contributions obey relative order and leave no ephemeral history after unload', async (t) => {
  const app = await setup(t);
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const c = conversation(app, { injection: true });
  app.plugins.add({
    manifest: {
      id: 'context-fixture', name: 'Fixture context', version: '1', description: 'Fixture',
      dependencies: [], permissions: ['context.contribute'], settings: [],
    },
    activate(ctx) {
      app.router.context({
        id: 'context-fixture',
        blocks: [
          { id: 'context-fixture.tail', layer: 'turn', after: ['core.presentation'] },
          { id: 'context-fixture.fixed', layer: 'stable', after: ['memory.core'] },
        ],
        prepare: () => ({
          'context-fixture.fixed': [{ text: 'OPTIONAL_STABLE' }],
          'context-fixture.tail': [{ text: 'OPTIONAL_TURN' }],
        }),
      }, ctx.capabilities);
    },
  });
  await app.plugins.enable('context-fixture');
  const first = await app.router.send({ conversationId: c.id, requestId: 'context-active', text: 'Hello', bubble: true });
  assert.equal(first.state, 'succeeded', first.error ?? 'Context contribution failed');
  const messages = backend.calls[0].messages;
  assert.match(messages[0].text, /OPTIONAL_STABLE/);
  assert.match(messages.at(-3)!.text, /本轮显示在桌宠小气泡/);
  assert.equal(messages.at(-2)!.text, 'OPTIONAL_TURN');
  assert.equal(messages.at(-2)!.context, 'turn');
  await app.plugins.disable('context-fixture');
  const second = await app.router.send({ conversationId: c.id, requestId: 'context-inactive', text: 'Again', bubble: true });
  assert.equal(second.state, 'succeeded', second.error ?? 'Context unload failed');
  assert(!JSON.stringify(backend.calls[1].messages).includes('OPTIONAL_'));
  assert(!JSON.stringify(app.store.allMessages(c.id)).includes('OPTIONAL_'));
  assert(!app.capabilities.list('core.context@3').some((item) => item.id === 'context-fixture.context'));
});

