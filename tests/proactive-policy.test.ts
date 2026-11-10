import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend } from './helpers.ts';
import { config, decide, type Decision } from '../plugins/care/policy.ts';

test('daily probability produces the configured allowance without exceeding the cap', () => {
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const rule = config.parse({ mode:'daily-budget', hourStart: 8, hourEnd: 23, checkMinutes: 30 });
  let total = 0,
    zero = 0;
  for (let day = 0; day < 10000; day++) {
    const state: Decision = { day: String(day), attempts: 0, eligibleChecks: 0 };
    for (let tick = 0; tick < 30; tick++)
      if (decide(rule, state, random) === 'selected') state.attempts++;
    assert(state.attempts <= 3);
    assert.equal(state.attempts, state.budget);
    total += state.attempts;
    if (!state.attempts) zero++;
  }
  assert(Math.abs(total / 10000 - 1.65) < 0.04);
  assert(Math.abs(zero / 10000 - 0.1) < 0.02);
});

test('Care checks do not repeatedly roll a slot or call the model for a missed probability', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('care');
  const c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.care.saveRule('quiet', {
    conversationId: c.id,
    enabled: true,
    mode: 'probability',
    probability: 0,
    hourStart: 0,
    hourEnd: 24,
  });
  const now = Date.now();
  assert.equal(((await app.care.tick(now)) as any).skipped, 'probability_missed');
  assert.equal(((await app.care.tick(now + 1000)) as any).skipped, 'already_checked');
  assert.equal(backend.calls.length, 0);
});

test('Care limits attempts per day and retains the cap through plugin reload', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('care');
  const c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.care.saveRule('bounded', {
    conversationId: c.id,
    enabled: true,
    mode: 'probability',
    probability: 100,
    dailyMax: 2,
    minMinutes: 5,
    checkMinutes: 5,
    hourStart: 0,
    hourEnd: 24,
  });
  const now = Date.now();
  await app.care.tick(now);
  await app.care.tick(now + 6 * 60000);
  await app.plugins.disable('care');
  await app.plugins.enable('care');
  await app.care.tick(now + 12 * 60000);
  assert.equal(backend.calls.length, 2);
  assert.equal(app.store.get<any>('care.decision.bounded', {}).attempts, 2);
});

test('Care counts prior attempts outside the recent run window after upgrading', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('care');
  const c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const now = Date.now();
  app.store.transaction(() => {
    for (let i = 0; i < 505; i++)
      app.store.createRun({
        id: 'prior-' + i,
        requestId: i < 3 ? 'care-upgraded-' + i : 'noise-' + i,
        conversationId: c.id,
        profileId: 'test',
        epoch: 1,
        state: 'succeeded',
        input: '',
        source: i < 3 ? 'care' : 'chat',
        createdAt: new Date(now).toISOString(),
        meta: {},
      });
  });
  app.care.saveRule('upgraded', {
    conversationId: c.id,
    enabled: true,
    mode: 'probability',
    probability: 100,
    dailyMax: 3,
    hourStart: 0,
    hourEnd: 24,
  });
  assert.equal(((await app.care.tick(now)) as any).skipped, 'daily_limit');
  assert.equal(backend.calls.length, 0);
});

test('Care sees human input beyond fifty program messages and across the configured scope', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('care');
  const c = conversation(app),
    other = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(other.id, 'user', 'human', 'A real message');
  for (let i = 0; i < 80; i++)
    app.store.append(other.id, 'system', 'observation', 'Program context');
  app.care.saveRule('scoped', {
    conversationId: c.id,
    enabled: true,
    mode: 'probability',
    probability: 100,
    busyScope: 'all',
    hourStart: 0,
    hourEnd: 24,
  });
  assert.equal(((await app.care.tick()) as any).skipped, 'human_active');
  assert.equal(backend.calls.length, 0);
  app.care.saveRule('scoped', { ...app.care.rules()[0], busyScope: 'conversation' });
  await app.care.tick();
  assert.equal(backend.calls.length, 1);
});

test('Care passes its observation scope to optional blockers before rolling probability', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('care');
  const c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.care.saveRule('watching', {
    conversationId: c.id,
    enabled: true,
    mode: 'probability',
    probability: 100,
    busyScope: 'all',
    hourStart: 0,
    hourEnd: 24,
  });
  const off = app.capabilities.provide(
    { id: 'fixture', permissions: new Set(['care.block']), signal: new AbortController().signal },
    'care.blockers@1',
    'fixture.watching',
    'Fixture',
    (input) => {
      assert.equal(input.scope, 'all');
      return { blocked: true };
    },
  );
  t.after(off);
  assert.equal(((await app.care.tick()) as any).skipped, 'fixture.watching');
  assert.equal(app.store.get('care.decision.watching', null), null);
  assert.equal(backend.calls.length, 0);
});
