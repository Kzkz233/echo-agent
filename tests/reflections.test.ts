import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend } from './helpers.ts';
const caller = { kind: 'ui' as const, permissions: new Set(['*']) };

test('concern migration preserves content and keeps retired records in local history', async (t) => {
  const app = await setup(t);
  const base = {
    personaId: 'companion',
    title: 'A current concern',
    text: 'I want to hear about the next attempt.',
    kind: 'wonder',
    realm: 'personal',
    priority: 1,
    focus: '',
    evidence: '',
    sources: [],
    version: 2,
    updatedAt: new Date().toISOString(),
  };
  app.store.put('reflections', 'current', { ...base, id: 'current', status: 'active' });
  app.store.put('reflections', 'retired', { ...base, id: 'retired', status: 'resolved' });
  await app.plugins.enable('reflections');
  const current: any = app.store.document('reflections', 'current');
  assert.equal(current.text, base.text);
  assert.equal(current.status, undefined);
  assert.equal(current.kind, undefined);
  assert.equal(app.store.document('reflections', 'retired'), undefined);
  assert.equal(app.store.documents('reflections-history').length, 2);
  await app.plugins.disable('reflections');
  await app.plugins.enable('reflections');
  assert.equal(app.store.documents('reflections-history').length, 2);
  const context: any = await app.registry.call(
    'reflections.preview',
    { personaId: 'companion' },
    caller,
  );
  assert.match(context.text, /不是待办/);
});
test('subjective state is role scoped, reaches normal injected conversation, and disappears on unload', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('reflections');
  const c = conversation(app, { injection: true });
  await app.registry.call(
    'reflections.save',
    {
      personaId: 'companion',
      title: '期待进展',
      text: '我对这次练习的结果很好奇。',
      focus: '想知道使用者有什么新发现。',
    },
    caller,
  );
  app.store.put('personas', 'other', { id: 'other', name: 'Other', prompt: 'Other' });
  await app.registry.call(
    'reflections.save',
    { personaId: 'other', title: '另一位角色', text: '不属于当前角色的想法。' },
    caller,
  );
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.router.send({ conversationId: c.id, requestId: 'state-injected', text: '聊聊今天' });
  const concern = backend.calls[0].messages.find((message) => message.context === 'turn')!;
  assert.match(concern.text, /这次练习/);
  assert.doesNotMatch(concern.text, /不属于当前/);
  await app.plugins.disable('reflections');
  await app.router.send({ conversationId: c.id, requestId: 'state-unloaded', text: '继续聊' });
  assert(!backend.calls[1].messages.some((message) => message.text.includes('这次练习')));
});
test('Review can add, revise and fade current concerns with frozen versions and idempotent receipts', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('reflections');
  const target = (jobId: string, proposals: any[]) =>
    app.capabilities.invoke(
      { id: 'test', permissions: new Set(['*']), signal: new AbortController().signal },
      'review.targets@1',
      'reflections.state',
      { action: 'apply', personaId: 'companion', jobId, proposals },
    );
  const add = {
    title: '练习进展',
    text: '我很期待接下来的尝试。',
    sources: ['message-one'],
    attributes: { focus: '之后想听听新的发现' },
  };
  await target('job-one', [add]);
  await target('job-one', [add]);
  const note = app.store.documents<any>('reflections')[0];
  assert.equal(app.store.documents('reflections').length, 1);
  const change = {
    ...add,
    operation: 'update',
    subjectId: note.id,
    expectedVersion: note.version,
    text: '结果比我预想的更有趣。',
  };
  await target('job-two', [change]);
  await target('job-two', [change]);
  assert.equal(app.store.documents<any>('reflections')[0].version, 2);
  await assert.rejects(() => target('job-stale', [change]), /未覆盖/);
  await target('job-three', [{ ...change, operation: 'forget', expectedVersion: 2 }]);
  const preview = await app.registry.call(
    'reflections.preview',
    { personaId: 'companion' },
    caller,
  );
  assert.equal(preview.notes.length, 0);
  assert(app.store.documents('reflections-history').length >= 2);
});
test('Review applies consecutive frozen concern updates atomically and rejects external edits or resurrection', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('reflections');
  const original: any = await app.registry.call(
    'reflections.save',
    { personaId: 'companion', title: 'Interest', text: 'Initial thought' },
    caller,
  );
  const target = (jobId: string, proposals: any[]) =>
    app.capabilities.invoke(
      { id: 'test', permissions: new Set(['*']), signal: new AbortController().signal },
      'review.targets@1',
      'reflections.state',
      { action: 'apply', personaId: 'companion', jobId, proposals },
    );
  const change = {
    title: 'Interest',
    text: 'First update',
    operation: 'update',
    subjectId: original.id,
    expectedVersion: 1,
    sources: ['first'],
  };
  const changes = [change, { ...change, text: 'Second update', sources: ['second'] }];
  await target('batch', changes);
  const latest: any = app.store.document('reflections', original.id);
  assert.equal(latest.version, 3);
  assert.equal(latest.text, 'Second update');
  assert.deepEqual(latest.sources, ['first', 'second']);
  await target('batch', changes);
  assert.deepEqual(app.store.document('reflections', original.id), latest);
  await assert.rejects(target('external-conflict', changes), /未覆盖/);
  await assert.rejects(
    target('invalid-resurrection', [
      { ...change, operation: 'forget', expectedVersion: 3 },
      { ...change, expectedVersion: 3 },
    ]),
    /未覆盖/,
  );
  assert.deepEqual(app.store.document('reflections', original.id), latest);
});

test('proactive conversation uses the optional subjective-state provider without owning a second copy', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('care');
  await app.plugins.enable('reflections');
  const c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.registry.call(
    'reflections.save',
    { personaId: 'companion', title: '好奇', text: '想知道那盆花有没有开。' },
    caller,
  );
  app.store.set('care.config', {
    enabled: true,
    conversationId: c.id,
    hourStart: 0,
    hourEnd: 24,
    minMinutes: 5,
    humanQuietMinutes: 1,
    mode: 'probability',
    probability: 100,
  });
  await app.care.tick();
  assert.match(backend.calls[0].messages.at(-1)!.text, /那盆花/);
  await app.plugins.disable('reflections');
  assert.ok(app.plugins.active.has('care'));
});
