import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { setup, conversation, FakeBackend, until, submitFixtureReplies } from './helpers.ts';
import { observationConfigSchema, type Frame } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { inferenceTasks } from '../packages/contracts/inference.ts';

async function fixture(t: Parameters<typeof setup>[0]) {
  const app = await setup(t), main = conversation(app, { kind: 'main', review: true }), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  t.mock.method(app.observations, 'sample', async () => {});
  app.observations.configure(observationConfigSchema.parse({ id: 'screen', name: 'Synthetic screen task',
    enabled: true, conversationId: main.id, personaId: main.personaId,
    frameCount: 1, outputTargets: ['core.chat'], allowlist: [{ id: 'allowed', type: 'process', value: 'fixture.exe' }] }));
  const task = (app.observations as any).task('screen');
  task.start(); task.stats.allowed = true; task.lastSample = { at: Date.now() };
  const jpeg = await sharp({ create: { width: 32, height: 20, channels: 3, background: 'green' } }).jpeg().toBuffer();
  const frame = (): Frame => ({ timestamp: new Date().toISOString(), source: 'fixture.exe', title: 'Fixture window',
    ruleId: 'allowed', jpeg, signature: new Uint8Array(), generation: task.status().generation });
  return { app, main, fake, task, frame };
}

test('Observe uses a real API work session, records quiet results in main history and Review reads those same rows', async t => {
  const { app, main, fake, frame } = await fixture(t);
  fake.responder = async () => ({ text: '{"summary":"Watching a synthetic tutorial.","attention":""}',
    usage: { prompt_tokens: 1250, completion_tokens: 35, cached_tokens: 1000 } });
  await app.observations.process([frame()], undefined, 'screen');
  await until(() => app.store.allMessages(main.id).some(m => !!m.meta.taskResult));
  const work = app.router.workSessions.list(main.personaId).find(w => w.origin.id === 'screen')!;
  assert(work); assert.equal(work.execution, 'inference'); assert.equal(work.state, 'idle');
  assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].toolPolicy, 'none');
  assert(!Object.hasOwn(app.store.conversation(work.conversationId)!, 'review'));
  const run = app.store.run(work.runId!)!;
  assert.equal((run.meta.generationMetrics as any).inputTokens, 1250);
  assert.deepEqual((run.meta.generationMetrics as any).totalUsage, { input: 1250, output: 35, cacheRead: 1000, cacheWrite: 0 });
  assert.equal((run.meta.generationMetrics as any).cacheHitPercent, 80);
  const childHistory = JSON.stringify(app.store.allMessages(work.conversationId));
  assert.match(childHistory, /Watching a synthetic tutorial/);
  assert(!childHistory.includes(jpegPrefix(frame().jpeg)));
  assert(!childHistory.includes('base64'));
  assert(!app.store.allMessages(work.conversationId).some(message => message.role === 'user'));
  const results = app.store.allMessages(main.id).filter(m => !!m.meta.taskResult);
  assert.equal(results.length, 1); assert.equal(results[0].meta.report, false);
  assert(!results[0].text.includes('latestFrame')); assert(!results[0].text.includes('visiblePercent'));
  const materials = await app.reviews.collect(main.personaId);
  assert(materials.some(m => m.id === results[0].id && m.text.includes('Watching a synthetic tutorial')));
  assert(!materials.some(m => m.conversationId === work.conversationId));
  assert(!materials.some(m => m.text.includes('无需主动回复')));
  await assert.rejects(app.router.send({ conversationId: work.conversationId, requestId: 'manual', text: 'Run arbitrary work' }), /来源自动化任务/);
});
const jpegPrefix = (bytes: Buffer) => bytes.toString('base64').slice(0, 50);

test('Observe hands off concise results once; channel failure does not replay old samples or consume new result identity', async t => {
  const { app, main, fake, task, frame } = await fixture(t);
  let summary = 'Synthetic game checkpoint A.';
  fake.responder = async request => request.messages.some(m => m.images?.length)
    ? { text: JSON.stringify({ summary, attention: 'A visible change.' }) }
    : { text: 'Not delivered through the required tool.' };
  await app.observations.process([frame()], undefined, 'screen');
  await until(() => app.store.allMessages(main.id).some(m => !!m.meta.taskResult));
  await until(() => !task.pendingInteraction);
  const first = app.observations.recent(main.personaId).at(-1)!;
  assert.equal(app.store.run('observe-' + first.id)?.state, 'failed');
  assert.equal(app.store.get('observation.task.screen.reportWatermark', ''), first.timestamp);
  assert.equal(fake.calls.length, 2);
  assert(!app.store.run('observe-' + first.id)!.input.includes('latestFrame'));
  app.store.set('observation.task.screen.lastReportAt', 0);
  await new Promise(resolve => setTimeout(resolve, 2));
  await app.observations.process([frame()], undefined, 'screen');
  await until(() => !task.pendingInteraction);
  assert.equal(fake.calls.length, 3); // Just another vision request; unchanged activity is not reported twice.
  assert.equal(app.store.allMessages(main.id).filter(m => !!m.meta.taskResult).length, 1);
  summary = 'Synthetic game checkpoint B.';
  app.store.set('observation.task.screen.lastReportAt', 0);
  app.store.set('observation.roleCooldown.' + main.personaId, 0);
  fake.responder = async request => request.messages.some(m => m.images?.length)
    ? { text: JSON.stringify({ summary, attention: 'A visible change.' }) }
    : submitFixtureReplies(request, 'A character reply.');
  await new Promise(resolve => setTimeout(resolve, 2));
  await app.observations.process([frame()], undefined, 'screen');
  await until(() => app.store.allMessages(main.id).filter(m => !!m.meta.taskResult).length === 2);
  await until(() => !task.pendingInteraction);
  const materials = await app.reviews.collect(main.personaId);
  assert(materials.some(m => m.text.includes('同一任务') && m.text.includes('A character reply')));
});

test('API work shares cancellation and ownership; aborted results never enter history and new attempts remain possible', async t => {
  const { app, main, fake } = await fixture(t);
  const work = app.router.workSessions.list(main.personaId)[0];
  let finish!: (result: { text: string }) => void;
  fake.responder = () => new Promise(resolve => { finish = resolve; });
  const input = { id: work.id, task: inferenceTasks.vision, requestId: 'cancel-api',
    messages: [{ role: 'user' as const, text: 'Transient request' }] };
  const pending = app.router.workSessions.infer(input, new AbortController().signal);
  await until(() => !!finish);
  app.router.workSessions.cancel(work.id); finish({ text: 'STALE_RESULT' });
  await assert.rejects(pending);
  assert.equal(app.store.run(input.requestId)?.state, 'cancelled');
  assert(!JSON.stringify(app.store.allMessages(work.conversationId)).includes('STALE_RESULT'));
  assert.equal(app.router.workSessions.list(main.personaId)[0].state, 'cancelled');
  fake.responder = async () => ({ text: 'New result' });
  await app.router.workSessions.infer({ ...input, requestId: 'new-api' }, new AbortController().signal);
  assert.equal(app.router.workSessions.list(main.personaId)[0].state, 'idle');
  await assert.rejects(app.router.workSessions.infer(input, new AbortController().signal), /原运行记录/);
});

test('visual requests maintain a bounded period overview without another inference call and reset it after reporting', async t => {
  const { app, main, fake, frame } = await fixture(t);
  const expected = ['', '', 'PHASE_TWO'];
  let index = 0;
  fake.responder = async request => {
    const context = JSON.parse(request.messages.at(-1)!.text);
    assert.equal(context.period.summary, expected[index]);
    index++;
    return { text: JSON.stringify({ summary: 'Frame ' + index, attention: '',
      periodSummary: index === 2 ? 'PHASE_TWO' : 'PHASE_' + index }) };
  };
  await app.observations.process([frame()], undefined, 'screen');
  await until(() => app.store.allMessages(main.id).some(m => !!m.meta.taskResult));
  await new Promise(resolve => setTimeout(resolve, 2));
  await app.observations.process([frame()], undefined, 'screen');
  await new Promise(resolve => setTimeout(resolve, 2));
  await app.observations.process([frame()], undefined, 'screen');
  assert.equal(index, 3); assert.equal(fake.calls.length, 3);
  const results = app.store.allMessages(main.id).filter(m => !!m.meta.taskResult);
  assert.equal(results.length, 1); assert.match(results[0].text, /阶段概况：PHASE_1/);
});

test('new Review defaults to main work history, keeps registered optional sources and does not relearn maintenance reports', async t => {
  const app = await setup(t), main = conversation(app, { kind: 'main', review: true });
  const extra = conversation(app, { review: true });
  app.store.append(main.id, 'user', 'human', 'MAIN_FACT'); app.store.append(extra.id, 'user', 'human', 'EXTRA_FACT');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'default-review', settings: { personaId: main.personaId, enabled: false } }, internal);
  const policy = app.reviews.tasks().find(t => t.id === 'default-review')!;
  assert.equal(policy.conversationScope, 'main'); assert.deepEqual(policy.sourceIds, []);
  const result = { id: 'maintenance', conversationId: main.id, text: 'MEMORY_MAINTENANCE_STATUS',
    source: 'review' as const, task: 'Synthetic maintenance', report: false, context: { reviewable: false } };
  await app.router.taskResults.submit(result);
  const materials = await app.reviews.collect(main.personaId, undefined, policy);
  assert(materials.some(m => m.text.includes('MAIN_FACT')));
  assert(!materials.some(m => /EXTRA_FACT|MEMORY_MAINTENANCE_STATUS/.test(m.text)));
  // Explicit existing settings are preserved rather than silently narrowed.
  app.reviews.saveTask(policy.id, { ...policy, conversationScope: 'selected', conversationIds: [extra.id] });
  assert((await app.reviews.collect(main.personaId)).some(m => m.text.includes('EXTRA_FACT')));
  assert.deepEqual(app.reviews.tasks()[0].conversationIds, [extra.id]);
});
