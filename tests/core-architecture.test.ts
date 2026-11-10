import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { EchoError, observationSilence, type Backend } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { contributeSignal } from '../packages/kernel/trigger-actions.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';

test('two simultaneous binding requests cannot claim the same conversation epoch', async (t) => {
  const app = await setup(t, []), chat = conversation(app), backend = new FakeBackend();
  app.router.backends.set('api', backend);
  seedProfile(app, { ...app.router.profile('test'), id: 'alternate', name: 'Alternate' });
  const signal = new AbortController().signal;
  const first = app.router.bind(chat.id, 'test', signal);
  await assert.rejects(app.router.bind(chat.id, 'alternate', signal), /会话正在执行或切换/);
  assert.equal((await first).epoch, 1);
  assert.equal(backend.seeds.length, 1);
});

test('reconciling an observation normalizes silence and unblocks the waiting human input', async (t) => {
  const app = await setup(t, []), chat = conversation(app);
  const backend = new FakeBackend() as FakeBackend & Pick<Backend, 'inspect'>;
  backend.inspect = async () => ({ state: 'succeeded', text: observationSilence });
  backend.responder = async () => { throw new EchoError('fixture', 'Unknown outcome', true); };
  app.router.backends.set('api', backend);
  const unknown = await app.router.send({
    requestId: 'observation-unknown', conversationId: chat.id,
    text: 'Observation', source: 'observation', bubble: true,
  });
  assert.equal(unknown.state, 'unknown');
  app.router.enqueue({ requestId: 'human-waiting', conversationId: chat.id, text: 'Human input' });
  backend.responder = async () => ({ text: 'Human reply' });
  const result = await app.router.reconcile(unknown.id, new AbortController().signal);
  assert.equal(result.meta.observationOutcome, 'skip');
  assert.equal(app.store.assistantForRun(result.id), undefined);
  assert.equal(app.store.pendingDeliveries().length, 0);
  await until(() => app.store.run('human-waiting')?.state === 'succeeded');
  backend.responder = async () => { throw new EchoError('fixture', 'Unknown outcome', true); };
  app.router.enqueue({ requestId: 'human-unknown', conversationId: chat.id, text: 'Check my result' });
  await until(() => app.store.receipt('input-human-unknown')?.state === 'unknown');
  backend.inspect = async () => ({ state: 'succeeded', text: 'Reconciled reply' });
  await app.router.reconcile(app.store.run('human-unknown')!.id, new AbortController().signal);
  assert.equal(app.store.receipt('input-human-unknown')?.state, 'succeeded');
});

test('a contributed trigger observes expiration and cannot reuse the mail relay opt-in', async (t) => {
  const app = await setup(t, []), chat = conversation(app), backend = new FakeBackend();
  app.router.backends.set('api', backend);
  let sends = 0;
  app.plugins.add({
    manifest: { id: 'fixture', name: 'Fixture', version: '1', description: '', dependencies: [],
      permissions: ['automation.contribute', 'automation.dispatch', 'channels.adapter'], settings: [] },
    activate: (ctx) => {
      contributeSignal(ctx, 'fixture.changed', 'Fixture changed', 'conversation');
      ctx.capabilities.provide('channels.send@1', 'fixture.channel', 'Fixture channel', () => {
        sends++;
        return { state: 'delivered' };
      });
    },
  });
  await app.plugins.enable('fixture');
  const binding = await app.registry.call('channels.bind', {
    adapter: 'fixture.channel', peer: 'fixture', conversationId: chat.id, automaticSources: ['trigger'],
  }, internal);
  const caller = { kind: 'extension' as const, pluginId: 'fixture', permissions: new Set(['automation.dispatch']) };
  const input = {
    action: 'conversation', kind: 'fixture.changed', requestId: 'fixture-turn',
    conversationId: chat.id, text: 'Approved test signal',
  };
  await assert.rejects(app.registry.call('automation.dispatch', input, { ...caller, pluginId: 'other' }), /触发来源/);
  assert.equal((await app.registry.call('automation.dispatch', { ...input, expiresAt: 0 }, caller)).state, 'expired');
  assert.equal(backend.calls.length, 0);
  assert.equal((await app.registry.call('automation.dispatch', input, caller)).run.state, 'succeeded');
  await until(()=>app.deliveries.rows().every(row=>row.state!=='pending'&&row.state!=='sending'));
  assert.equal(sends, 0);
  assert.equal(app.store.documents('channel-outbound').length, 0);
  await app.registry.call('channels.bind', { ...binding, automaticTriggerKinds: ['fixture.changed'] }, internal);
  await app.registry.call('automation.dispatch', { ...input, requestId: 'fixture-relay' }, caller);
  await until(() => sends === 1);
});

test('external reference ownership survives plugin unload and protects the saved target', async (t) => {
  const app = await setup(t, []), chat = conversation(app);
  app.plugins.add({
    manifest: { id: 'fixture', name: 'Fixture', version: '1', description: '', dependencies: [],
      permissions: ['conversation.reference'], settings: [] },
    activate: () => {},
  });
  await app.plugins.enable('fixture');
  const caller = { kind: 'extension' as const, pluginId: 'fixture', permissions: new Set(['conversation.reference']) };
  await app.registry.call('conversations.setReference', {
    id: 'fixture-ref', reference: { conversationId: chat.id, label: 'Fixture', role: 'trigger' },
  }, caller);
  await app.plugins.disable('fixture');
  const rows = await app.registry.call('conversations.references', { id: chat.id }, internal);
  assert(rows.some((row: any) => row.label === 'Fixture' && !row.enabled && row.blocksDeletion));
  await assert.rejects(app.registry.call('conversations.delete', { id: chat.id, confirmed: true }, internal), /解除.*绑定/);
});

test('a committed outbound action waits for its adapter and an unknown send is never repeated', async (t) => {
  const app = await setup(t, []), chat = conversation(app), backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.registry.call('channels.bind', {
    adapter: 'fixture.channel', peer: 'fixture', conversationId: chat.id, automaticSources: ['care'],
  }, internal);
  await app.router.send({
    requestId: 'persist-delivery', conversationId: chat.id, text: 'Proactive turn', source: 'care',
  });
  const pending = app.store.documents<{ id: string; state: string }>('channel-outbound');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'pending');
  let sends = 0;
  app.plugins.add({
    manifest: { id: 'fixture', name: 'Fixture', version: '1', description: '', dependencies: [],
      permissions: ['channels.adapter'], settings: [] },
    activate: (ctx) => {
      ctx.capabilities.provide('channels.send@1', 'fixture.channel', 'Fixture channel', () => {
        sends++;
        return { state: 'unknown' };
      });
    },
  });
  await app.plugins.enable('fixture');
  await until(() => app.store.document<any>('channel-outbound', pending[0].id)?.state === 'unknown');
  await app.plugins.disable('fixture');
  await app.plugins.enable('fixture');
  assert.equal(sends, 1);
});
