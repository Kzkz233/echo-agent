import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { calendar, opportunity, type Decision } from '../plugins/care/policy.ts';
import { observationSilence } from '../packages/contracts/index.ts';

test('manual Care checks share the canonical trigger path, preserve the plan and never fan out to external channels', async (t) => {
  const app = await setup(t, []),
    chat = conversation(app, { injection: true }),
    backend = new FakeBackend();
  await app.plugins.enable('care');
  await app.plugins.enable('avatar');
  app.router.backends.set('api', backend);
  await app.registry.call(
    'channels.bind',
    {
      adapter: 'fixture.external',
      peer: 'invented-peer',
      conversationId: chat.id,
      automaticSources: ['care'],
    },
    internal,
  );
  app.care.saveRule('test-rule', {
    enabled: true,
    conversationId: chat.id,
    hourStart: 0,
    hourEnd: 24,
    dailyMax: 1,
    minMinutes: 5,
  });
  const now = Date.now(),
    rule = app.care.rules()[0];
  const decision: Decision = { day: calendar(rule, now).day, attempts: 0, eligibleChecks: 0 };
  opportunity(rule, decision, now, () => 0.75);
  app.store.set('care.decision.test-rule', decision);
  const planned = structuredClone(decision);
  const result: any = await app.registry.call(
    'care.check',
    { ruleId: rule.id, requestId: 'manual-one' },
    internal,
  );
  assert.equal(result.state, 'succeeded', result.error);
  assert.equal(result.source, 'care');
  assert.equal(result.conversationId, chat.id);
  assert.equal(result.meta.triggerKind, 'care.opportunity');
  assert(result.meta.localOnly);
  assert.equal(backend.calls.length, 1);
  assert.match(backend.calls[0].messages.at(-1)!.text, /不是使用者的新发言/);
  await until(()=>app.store.pendingDeliveries().length===1);
  assert.equal(app.store.pendingDeliveries().length, 1);
  assert.equal(app.store.documents('channel-outbound').length, 0);
  assert.equal(
    app.store.allMessages(chat.id).filter((message) => message.source === 'human').length,
    0,
  );
  const after = app.store.get<Decision>('care.decision.test-rule', {} as Decision);
  assert.equal(after.attempts, 1);
  assert.deepEqual(after.opportunities, planned.opportunities);
  assert.equal(after.checkedOpportunity, planned.checkedOpportunity);
  assert.equal(after.plan, planned.plan);
  const repeated: any = await app.registry.call(
    'care.check',
    { ruleId: rule.id, requestId: 'manual-one' },
    internal,
  );
  assert.equal(repeated.id, result.id);
  assert.equal(backend.calls.length, 1);
  assert.equal(
    ((await app.care.checkOnce(rule.id, 'manual-two', now + 6 * 60000)) as any).skipped,
    'daily_limit',
  );
  await assert.rejects(
    app.router.send({
      requestId: result.requestId,
      conversationId: chat.id,
      text: result.input,
      source: 'care',
      bubble: true,
      triggerKind: 'care.opportunity',
    }),
    /同一请求编号/,
  );
  const replay = await app.router.send({requestId:result.requestId,conversationId:chat.id,text:result.input,source:'care',bubble:true,triggerKind:'care.opportunity',localOnly:true});
  assert.equal(replay.id,result.id);assert.equal(backend.calls.length,1);
  assert(!app.registry.list(internal, true).some((operation) => operation.name === 'care.check'));
});

test('manual Care checks obey human and observation avoidance without consuming attempts', async (t) => {
  const app = await setup(t, []),
    chat = conversation(app),
    backend = new FakeBackend();
  await app.plugins.enable('care');
  app.router.backends.set('api', backend);
  app.care.saveRule('avoid', {
    enabled: true,
    conversationId: chat.id,
    hourStart: 0,
    hourEnd: 24,
    humanQuietMinutes: 1,
  });
  const human = app.store.append(chat.id, 'user', 'human', 'Synthetic user input');
  assert.equal(((await app.care.checkOnce('avoid', 'human')) as any).skipped, 'human_active');
  const off = app.capabilities.provide(
    { id: 'fixture', permissions: new Set(['care.block']), signal: new AbortController().signal },
    'care.blockers@1',
    'fixture.watching',
    'Watching',
    () => ({ blocked: true }),
  );
  const future = Date.parse(human.createdAt) + 2 * 60000;
  assert.equal(
    ((await app.care.checkOnce('avoid', 'watching', future)) as any).skipped,
    'fixture.watching',
  );
  assert.equal(backend.calls.length, 0);
  assert.equal(app.store.get('care.decision.avoid', null), null);
  off();
  backend.responder = async () => ({ text: observationSilence });
  const result: any = await app.care.checkOnce('avoid', 'quiet', future);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.meta.careOutcome, 'skip');
  assert.equal(app.store.pendingDeliveries().length, 0);
  await app.plugins.disable('care');
  await assert.rejects(
    app.registry.call('care.check', { ruleId: 'avoid', requestId: 'unloaded' }, internal),
  );
});
