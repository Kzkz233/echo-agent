import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend } from './helpers.ts';
const caller = { kind: 'internal' as const, permissions: new Set(['*']) };
test('deleting an idle conversation archives its native session and removes only its records', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    other = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.router.send({
    conversationId: c.id,
    text: 'Synthetic removable message',
    requestId: 'delete-chat-turn',
    bubble: true,
  });
  app.store.append(other.id, 'user', 'human', 'Keep this separate conversation');
  app.store.saveReceipt('delete-queued', {
    kind: 'input',
    state: 'queued',
    input: { conversationId: c.id },
  });
  const result = await app.registry.call(
    'conversations.delete',
    { id: c.id, confirmed: true },
    caller,
  );
  assert.equal(result.deleted, true);
  assert.deepEqual(backend.archived, ['session-1']);
  assert.equal(app.store.conversation(c.id), undefined);
  assert.equal(app.store.allMessages(c.id).length, 0);
  assert.equal(app.store.run('delete-chat-turn'), undefined);
  assert.equal(app.store.receipt('delete-queued'), undefined);
  assert.equal(app.store.pendingDeliveries().length, 0);
  assert.equal(app.store.allMessages(other.id).length, 1);
  assert.ok(app.store.document('personas', 'companion'));
});
test('saved plugin bindings block deletion even when the plugin is disabled', async (t) => {
  const app = await setup(t),
    c = conversation(app);
  app.store.set('observation.config', { enabled: false, conversationId: c.id });
  await app.plugins.disable('observation');
  const refs = await app.registry.call('conversations.references', { id: c.id }, caller);
  assert.ok(refs.some((r: any) => r.taskId === 'default' && r.role === 'trigger' && r.blocksDeletion && !r.enabled));
  await assert.rejects(
    () => app.registry.call('conversations.delete', { id: c.id, confirmed: true }, caller),
    /解除.*绑定/,
  );
  assert.ok(app.store.conversation(c.id));
});
test('an archive failure preserves local history and fences the archived-or-unknown binding', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.router.send({
    conversationId: c.id,
    text: 'Preserve on failure',
    requestId: 'delete-failure',
  });
  backend.archiveSession = async () => {
    throw Error('Synthetic archive connection failure');
  };
  await assert.rejects(
    () => app.registry.call('conversations.delete', { id: c.id, confirmed: true }, caller),
    /archive connection/,
  );
  assert.ok(app.store.conversation(c.id));
  assert.ok(app.store.allMessages(c.id).length);
  assert.equal(app.store.binding(c.id)?.state, 'unknown');
});
test('new queued input cannot enter a conversation while deletion awaits native archival', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.router.send({
    conversationId: c.id,
    text: 'Before deletion',
    requestId: 'delete-race-turn',
  });
  let release!: () => void;
  backend.archiveSession = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const deleting = app.registry.call('conversations.delete', { id: c.id, confirmed: true }, caller);
  await new Promise((r) => setTimeout(r, 0));
  assert.throws(
    () =>
      app.router.enqueue({
        conversationId: c.id,
        text: 'Do not enqueue',
        requestId: 'delete-race-queued',
      }),
    /正在删除/,
  );
  release();
  await deleting;
  assert.equal(app.store.receipt('input-delete-race-queued'), undefined);
});
test('unknown executions cannot be hidden by deleting the conversation', async (t) => {
  const app = await setup(t),
    c = conversation(app);
  app.store.createRun({
    id: 'unknown-delete',
    requestId: 'unknown-delete',
    conversationId: c.id,
    profileId: 'test',
    epoch: 1,
    state: 'unknown',
    input: 'Synthetic',
    source: 'human',
    createdAt: new Date().toISOString(),
    meta: {},
  });
  await assert.rejects(
    () => app.registry.call('conversations.delete', { id: c.id, confirmed: true }, caller),
    /未知/,
  );
  assert.ok(app.store.conversation(c.id));
});
