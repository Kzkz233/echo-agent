import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FakeBackend, until, conversation } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterActive } from '../packages/kernel/characters.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { displayAvatar } from '../plugins/avatar/profiles.ts';
import { NativeAvatar } from '../plugins/avatar/native.ts';
import { observationConfigSchema } from '../packages/contracts/index.ts';

test('role suspension preserves configuration, hides its avatar and rejects new work without affecting another role', async (t) => {
  t.mock.method(NativeAvatar.prototype as any, 'configure', async () => {});
  const app = await setup(t);
  await app.plugins.enable('avatar');
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const call = (name: string, value: any = {}) => app.registry.call(name, value, internal);
  const role = await call('persona.character.commit', {
    requestId: 'create',
    draft: characterDraft.parse({
      persona: { id: 'fixture', name: 'Fixture', prompt: 'Synthetic' },
      features: ['avatar', 'memory'],
      profileId: 'test',
      configurations: { avatar: { enabled: true } },
    }),
  });
  const before = JSON.stringify(app.store.get('avatar.config', {}));
  app.store.saveReceipt('old-bubble', {
    kind: 'bubble',
    state: 'pending',
    conversationId: role.mainConversationId,
    text: 'Old',
  });
  await call('characters.setActive', { personaId: 'fixture', enabled: false, revision: 0 });
  assert.equal(characterActive(app.store, 'fixture'), false);
  assert.equal(displayAvatar(app.store).enabled, false);
  assert.equal(JSON.stringify(app.store.get('avatar.config', {})), before);
  assert.equal(app.store.receipt('old-bubble')?.state, 'expired');
  assert.throws(
    () =>
      app.router.enqueue({
        conversationId: role.mainConversationId,
        text: 'Hello',
        requestId: 'blocked',
      }),
    /停用/,
  );
  const notice = app.router.notice({
    conversationId: role.mainConversationId,
    requestId: 'notice',
    title: 'Old',
    text: 'Reminder',
    bubble: true,
  });
  assert.equal(notice.state, 'suppressed');
  await call('persona.character.commit', {
    requestId: 'edit',
    draft: { ...role, persona: { ...role.persona, prompt: 'Edited' } },
  });
  assert.equal(
    characterActive(app.store, 'fixture'),
    false,
    'editing is separate from runtime activity',
  );
  const other = conversation(app);
  assert.equal(
    (await app.router.send({ conversationId: other.id, text: 'Hello', requestId: 'other' })).state,
    'succeeded',
  );
  await call('characters.setActive', { personaId: 'fixture', enabled: true, revision: 1 });
  assert.equal(displayAvatar(app.store).enabled, true);
  assert.equal(
    app.router.notice({
      conversationId: role.mainConversationId,
      requestId: 'notice',
      title: 'Old',
      text: 'Reminder',
      bubble: true,
    }).state,
    'suppressed',
  );
  assert.equal(app.store.receipt('old-bubble')?.state, 'expired');
  await assert.rejects(
    call('characters.setActive', { personaId: 'fixture', enabled: false, revision: 0 }),
    /状态已/,
  );
});

test('disable then immediate enable fences a late backend result and cancels queued input', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const chat = conversation(app);
  let finish!: (v: any) => void;
  backend.responder = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const running = app.router.send({
    conversationId: chat.id,
    text: 'First',
    requestId: 'first',
    bubble: true,
  });
  await until(() => backend.calls.length === 1);
  app.router.enqueue({ conversationId: chat.id, text: 'Queued', requestId: 'queued' });
  await app.registry.call(
    'characters.setActive',
    { personaId: 'companion', enabled: false, revision: 0 },
    internal,
  );
  await app.registry.call(
    'characters.setActive',
    { personaId: 'companion', enabled: true, revision: 1 },
    internal,
  );
  finish({ text: 'Late result' });
  const result = await running;
  assert.notEqual(result.state, 'succeeded');
  assert(!app.store.messages(chat.id).some((m) => m.text === 'Late result'));
  assert(!app.store.receipts().some((r) => r.kind === 'input' && r.state === 'queued'));
  assert.equal(backend.calls.length, 1);
});

test('inactive channel input is consumed once and never replayed on enable', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('channels');
  app.plugins.add({
    manifest: {
      id: 'fixture',
      name: 'Fixture',
      description: 'Synthetic',
      version: '1.0.0',
      dependencies: ['channels'],
      permissions: ['channels.adapter'],
      settings: [],
      views: [],
    },
    activate: (ctx) => {
      ctx.capabilities.provide('channels.send@1', 'fixture.channel', 'Fixture', () => ({
        state: 'delivered',
      }));
    },
  });
  await app.plugins.enable('fixture');
  const chat = conversation(app);
  await app.registry.call(
    'channels.bind',
    {
      id: 'binding',
      adapter: 'fixture.channel',
      peer: 'peer',
      conversationId: chat.id,
      enabled: true,
    },
    internal,
  );
  await app.registry.call(
    'characters.setActive',
    { personaId: 'companion', enabled: false, revision: 0 },
    internal,
  );
  const input = {
    adapter: 'fixture.channel',
    peer: 'peer',
    remoteMessageId: 'one',
    text: 'Old incoming message',
  };
  const first = await app.channels.receive(input, 'fixture');
  assert.equal(first.accepted, false);
  await app.registry.call(
    'characters.setActive',
    { personaId: 'companion', enabled: true, revision: 1 },
    internal,
  );
  assert.equal((await app.channels.receive(input, 'fixture')).accepted, false);
  assert.equal(app.store.messages(chat.id).length, 0);
});

test('suspension stops observation sampling and Review, preserves task intent and safely resumes the Review checkpoint', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const chat = conversation(app, { review: true });
  let samples = 0;
  t.mock.method(app.observations, 'sample', async () => {
    samples++;
  });
  app.observations.configure(
    observationConfigSchema.parse({
      enabled: true,
      conversationId: chat.id,
      allowlist: [{ id: 'fixture', type: 'process', value: 'fixture.exe' }],
    }),
  );
  const configuration = JSON.stringify(app.observations.configurations());
  app.store.append(chat.id, 'user', 'human', 'Synthetic material');
  let finish!: (value: any) => void;
  backend.responder = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const job = await app.reviews.start('companion', 'suspend-review');
  await until(() => backend.calls.length === 1);
  await app.registry.call(
    'characters.setActive',
    { personaId: 'companion', enabled: false, revision: 0 },
    internal,
  );
  const stoppedSamples = samples;
  finish({ text: JSON.stringify({ notes: 'late', memories: [] }) });
  await until(() => app.reviews.jobs().find((row) => row.id === job.id)?.state === 'paused');
  const paused = app.reviews.jobs().find((row) => row.id === job.id)!;
  assert.equal(paused.nextPacket, 0);
  assert.equal(paused.pausedByCharacter, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(samples, stoppedSamples);
  assert.equal(JSON.stringify(app.observations.configurations()), configuration);
  assert.equal(app.store.documents('memories').length, 0);
  backend.responder = async () => ({ text: JSON.stringify({ notes: 'resumed', memories: [] }) });
  await app.registry.call(
    'characters.setActive',
    { personaId: 'companion', enabled: true, revision: 1 },
    internal,
  );
  await app.reviews.execute(job.id);
  assert.equal(app.reviews.jobs().find((row) => row.id === job.id)?.state, 'completed');
  assert(samples > stoppedSamples);
});
