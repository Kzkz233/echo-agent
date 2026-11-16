import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, workerTemplate, executionRequest } from '../plugins/delegation/config.ts';
import { authorizeExecution } from '../plugins/delegation/authorization.ts';
import { setup, conversation, FakeBackend } from './helpers.ts';

test('new work has no total deadline and explicit role duration limits remain binding', async t => {
  const app = await setup(t, []);
  const policy = settings.parse({});
  assert.equal(policy.timeoutMinutes, 0);
  assert.equal(workerTemplate.parse({ id: 'fixture', name: 'Fixture' }).timeoutMinutes, 0);
  const authorize = (request: unknown, limit = 0) => authorizeExecution(app.store, 'fixture', 'test',
    { ...policy, timeoutMinutes: limit }, executionRequest.parse(request));
  assert.equal((await authorize({})).timeoutMinutes, 0);
  assert.equal((await authorize({ timeoutMinutes: 0 })).timeoutMinutes, 0);
  assert.equal((await authorize({ timeoutMinutes: 90 * 24 * 60 })).timeoutMinutes, 90 * 24 * 60);
  assert.equal((await authorize({}, 240)).timeoutMinutes, 240);
  assert.equal((await authorize({ timeoutMinutes: 180 }, 240)).timeoutMinutes, 180);
  await assert.rejects(authorize({ timeoutMinutes: 0 }, 240), /时限超过/);
  await assert.rejects(authorize({ timeoutMinutes: 241 }, 240), /时限超过/);
  assert.equal(settings.parse({ authorizationVersion: 3, timeoutMinutes: 20 }).timeoutMinutes, 20);
  assert.equal(settings.parse({ templates: [{ id: 'legacy', name: 'Legacy', timeoutMinutes: 30 }] }).timeoutMinutes, 30);
  assert.equal(settings.parse({ templates: [{ id: 'legacy', name: 'Legacy' }] }).timeoutMinutes, 20);
});

for (const timeoutMs of [undefined, 0, 90 * 86400000])
  test(`shared work lifecycle supports long execution with duration ${timeoutMs ?? 'inherited'}`, async t => {
    const app = await setup(t, []), parent = conversation(app), backend = new FakeBackend();
    app.router.backends.set('api', backend);
    const work = app.router.workSessions.register({ id: 'long', personaId: parent.personaId,
      parentConversationId: parent.id, title: 'Synthetic long task',
      origin: { owner: 'core', type: 'fixture', id: 'long', name: 'Fixture' } });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    backend.responder = async request => {
      // Cross the native timer's 24.8-day limit as well as the old task defaults.
      for (let i = 0; i < 3; i++) {
        t.mock.timers.tick(20 * 86400000);
        await Promise.resolve();
        assert.equal(request.signal.aborted, false);
      }
      return { text: 'Finished the long task' };
    };
    const run = await app.router.workSessions.run({ id: work.id, profileId: 'test', requestId: 'long',
      text: 'Synthetic work', timeoutMs }, new AbortController().signal);
    assert.equal(run.state, 'succeeded', run.error ?? 'Long task failed');
    assert.equal(app.router.workSessions.list()[0].state, 'idle');
    t.mock.timers.reset();
  });

for (const cancel of ['deadline', 'caller', 'work'] as const)
  test(`work still stops on explicit ${cancel} cancellation and revokes temporary authority`, async t => {
    const app = await setup(t, []), parent = conversation(app), backend = new FakeBackend();
    app.router.backends.set('api', backend);
    const work = app.router.workSessions.register({ id: 'cancel', personaId: parent.personaId,
      parentConversationId: parent.id, title: 'Synthetic task',
      origin: { owner: 'core', type: 'fixture', id: 'cancel', name: 'Fixture' } });
    const controller = new AbortController();
    backend.responder = async request => {
      if (cancel === 'caller') controller.abort();
      if (cancel === 'work') app.router.workSessions.cancel(work.id);
      request.signal.throwIfAborted();
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    };
    // Keep the isolated test alive while the production deadline timer is unref'ed.
    const keepAlive = setTimeout(() => {}, 1000);
    t.after(() => clearTimeout(keepAlive));
    const run = await app.router.workSessions.run({ id: work.id, profileId: 'test', requestId: 'cancel',
      text: 'Synthetic work', timeoutMs: cancel === 'deadline' ? 100 : 0,
      authority: { owner: 'core', taskType: 'fixture', taskId: 'cancel', permissions: [] } }, controller.signal);
    assert.equal(run.state, 'cancelled', run.error ?? 'Cancellation failed');
    assert.equal(app.router.workSessions.list()[0].state, 'cancelled');
    assert.equal(app.store.document<any>('work-authorities', work.conversationId)?.active, false);
  });

test('Review has no default deadline and preserves a saved duration', async t => {
  const app = await setup(t);
  app.store.put('personas', 'fixture', { id: 'fixture', name: 'Fixture', prompt: 'Synthetic' });
  app.reviews.saveTask('fixture', { personaId: 'fixture', enabled: false });
  const first = app.reviews.tasks()[0];
  assert.equal(first.timeoutMinutes, 0);
  app.reviews.saveTask('fixture', { ...first, timeoutMinutes: 360 });
  assert.equal(app.reviews.tasks()[0].timeoutMinutes, 360);
});
