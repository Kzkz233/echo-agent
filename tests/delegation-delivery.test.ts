import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FakeBackend, until, submitFixtureReplies } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';

for (const accepted of [true, false]) test(`worker results wait for the active parent and ${accepted ? 'stay acknowledged after review' : 'handoff only once'}`, async t => {
  const app = await setup(t), backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const call = (name: string, input: any) => app.registry.call(name, input, internal);
  const role = await call('persona.character.commit', { requestId: 'return-role', draft: characterDraft.parse({
    persona: { id: 'return-role', name: 'Fixture', prompt: 'Synthetic' }, profileId: 'test', features: ['delegation'],
    configurations: { delegation: { authorizationVersion: 3, reportOnCompletion: true } },
  }) });
  let release!: () => void; const finishParent = new Promise<void>(done => release = done);
  let task: any, parentDone = false, handoffs = 0;
  backend.responder = async request => {
    if (request.principal?.conversationId.startsWith('worker-')) return { text: 'Synthetic result' };
    if (request.messages.at(-1)?.text.includes('以下是任务执行结果')) {
      assert(parentDone); handoffs++; return submitFixtureReplies(request);
    }
    task = await call('delegation.request', { requestId: 'active-task', conversationId: role.mainConversationId, goal: 'Synthetic', acceptance: 'Evidence' });
    const stored = app.store.document<any>('delegated-tasks', task.id);
    app.store.put('delegated-tasks', task.id, { ...stored, originRunId: app.store.unresolved(role.mainConversationId)[0].id });
    await finishParent;
    if (accepted) await call('delegation.review', { taskId: task.id, conversationId: role.mainConversationId, attempt: 1, decision: 'accepted', text: 'Evidence checked' });
    parentDone = true; return submitFixtureReplies(request);
  };
  const parent = app.router.send({ requestId: 'parent-request', conversationId: role.mainConversationId, text: 'Synthetic delegation' });
  await until(() => !!task && app.store.document<any>('delegated-tasks', task.id)?.state === 'completed');
  await new Promise(done => setImmediate(done));
  assert.equal(handoffs, 0);
  assert.equal(app.router.inputs(role.mainConversationId).length, 0);
  release(); await parent;
  if (accepted) {
    await new Promise(done => setTimeout(done, 50));
    assert.equal(handoffs, 0);
    assert.equal(app.store.receipt('delegation-return-' + task.id + '.1')?.state, 'reviewed');
  } else await until(() => handoffs === 1);
});

test('a corrected retry in the same parent turn replaces the failed attempt without a stale failure report', async t => {
  const app = await setup(t), backend = new FakeBackend(); app.router.backends.set('api', backend);
  const call = (name: string, input: any) => app.registry.call(name, input, internal);
  const role = await call('persona.character.commit', { requestId: 'retry-role', draft: characterDraft.parse({
    persona: { id: 'retry-role', name: 'Fixture', prompt: 'Synthetic' }, profileId: 'test', features: ['delegation'],
  }) });
  let attempt = 0, returned = '', handoffs = 0;
  backend.responder = async request => {
    if (request.principal?.conversationId.startsWith('worker-')) {
      if (++attempt === 1) throw Error('Synthetic rejected execution');
      return { text: 'Successful retry' };
    }
    if (request.messages.at(-1)?.text.includes('以下是任务执行结果')) {
      handoffs++; returned = request.messages.at(-1)!.text; return submitFixtureReplies(request);
    }
    // Use the same MCP identity that real main-agent tool calls carry.
    const caller = { kind: 'mcp' as const, personaId: 'retry-role', conversationId: role.mainConversationId, permissions: new Set(['*']) };
    const guide = request.messages.map(m => m.text).join('\n');
    const authority = guide.match(/本轮委派接口 authority=([^\s]+)/)?.[1];
    for (let i = 0; i < 2; i++) {
      const task = await app.registry.call('delegation.request', { requestId: 'retry-' + i, authority,
        goal: 'Same goal', acceptance: 'Same evidence', context: 'Same scope' }, caller);
      await until(() => ['completed', 'failed'].includes(app.store.document<any>('delegated-tasks', task.id)?.state));
    }
    return submitFixtureReplies(request);
  };
  await app.router.send({ requestId: 'parent-retry', conversationId: role.mainConversationId, text: 'Synthetic retry' });
  await until(() => handoffs === 1);
  assert(returned.includes('Successful retry'));
  assert(!returned.includes('Synthetic rejected execution'));
  const failed = app.store.documents<any>('delegated-tasks').find(task => task.state === 'failed');
  assert(failed?.supersededBy);
  assert.equal(app.store.receipt('delegation-return-' + failed.id + '.1')?.state, 'superseded');
});

test('worker handoffs retain originating channel grants and keep different destinations in separate turns', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  let release!: () => void;
  const work = new Promise<void>((done) => (release = done));
  backend.responder = async (request) => {
    if (request.principal?.conversationId.startsWith('worker-')) {
      await work;
      return { text: 'Synthetic worker result' };
    }
    return submitFixtureReplies(request);
  };
  const call = (name: string, input: any) => app.registry.call(name, input, internal);
  const role = await call('persona.character.commit', {
    requestId: 'handoff-role',
    draft: characterDraft.parse({
      persona: { id: 'handoff-role', name: 'Fixture', prompt: 'Synthetic' },
      profileId: 'test',
      features: ['delegation'],
      configurations: {
        delegation: { authorizationVersion: 3, concurrency: 2, reportOnCompletion: true },
      },
    }),
  });
  const destinations = ['core.chat', 'notifications.inbox'];
  for (const [index, target] of destinations.entries()) {
    const originId = 'origin-' + index;
    const delivery = await app.deliveries.plan(role.mainConversationId, 'human', [target]);
    assert.equal(delivery.targets[0].ready, true);
    app.store.createRun({
      id: originId,
      requestId: originId,
      conversationId: role.mainConversationId,
      profileId: 'test',
      epoch: 0,
      source: 'human',
      state: 'succeeded',
      input: 'Synthetic request ' + index,
      createdAt: new Date().toISOString(),
      meta: { delivery },
    });
    const task = await call('delegation.request', {
      requestId: 'handoff-task-' + index,
      conversationId: role.mainConversationId,
      goal: 'Synthetic goal ' + index,
      acceptance: 'Return synthetic result',
    });
    app.store.put('delegated-tasks', task.id, {
      ...app.store.document<any>('delegated-tasks', task.id),
      originRunId: originId,
    });
  }
  release();
  await until(
    () =>
      backend.calls.filter((request) =>
        request.messages.at(-1)?.text.includes('以下是任务执行结果'),
      ).length === 2,
    8000,
  );
  const returns = backend.calls.filter((request) =>
    request.messages.at(-1)?.text.includes('以下是任务执行结果'),
  );
  assert.deepEqual(
    returns.map((request) => request.replyTargets?.join(',')).sort(),
    [...destinations].sort(),
  );
  for (const request of returns) {
    assert.equal(request.replyTargets?.length, 1);
    const text = request.messages.at(-1)!.text;
    assert(text.includes('Synthetic goal ' + destinations.indexOf(request.replyTargets![0])));
    assert(
      !text.includes('Synthetic goal ' + (1 - destinations.indexOf(request.replyTargets![0]))),
    );
  }
});
