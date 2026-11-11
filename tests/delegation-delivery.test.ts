import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FakeBackend, until, submitFixtureReplies } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';

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
