import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until, temporary } from './helpers.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativePiTools } from '../packages/backends/pi-tools.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { taskPresentation } from '../packages/contracts/tasks.ts';
import { config, opportunity, type Decision } from '../plugins/care/policy.ts';
import { localTime } from '../packages/kernel/time.ts';
import { memoryChange } from '../plugins/memory/changes.ts';

test('one-off outcomes enter history only after acceptance; continuous goals remain waiting', () => {
  assert.deepEqual(taskPresentation({ state: 'completed', acceptanceStatus: 'pending' }), {
    ended: false,
    label: '待验收',
  });
  assert.equal(taskPresentation({ state: 'failed' }).ended, false);
  assert.equal(taskPresentation({ state: 'completed', acceptanceStatus: 'accepted' }).ended, true);
  assert.deepEqual(
    taskPresentation({ lifetime: 'continuous', state: 'completed', acceptanceStatus: 'accepted' }),
    { ended: false, label: '等待触发' },
  );
  assert.equal(
    taskPresentation({ lifetime: 'continuous', lifecycle: 'ended', state: 'completed' }).ended,
    true,
  );
});
test('Pi additional workspace grants distinguish read-only and writable directories',async(t)=>{
  const root=await temporary(t);
  const [data,project,read,write,other]=['data','project','read','write','other'].map((name)=>join(root,name));
  await Promise.all([data,project,read,write,other].map((path)=>mkdir(path)));
  await writeFile(join(read,'facts.txt'),'Synthetic reference');
  const native=await nativePiTools({profile:profileSchema.parse({id:'p',name:'p',kind:'pi'}),messages:[],requestId:'roots',signal:new AbortController().signal,
    onInteraction:async()=>({decision:'allow'}), permissions:{projectDirectory:project,readRoots:[read],writeRoots:[write],pi:{tools:'ask',projectWrite:true},codex:{sandbox:'read-only',approvals:'deny'},dsh:{approvals:'deny'}}},data);
  await native.validate('read',{path:join(read,'facts.txt')});
  await native.validate('write',{path:join(write,'new.txt')});
  await assert.rejects(native.validate('write',{path:join(read,'facts.txt')}),/超出/);
  await assert.rejects(native.validate('read',{path:join(other,'anything')}),/超出/);
});

test('Review tasks have independent cursors and continuation notes without creating extra policies', async (t) => {
  const app = await setup(t),
    chat = conversation(app, { review: true });
  const backend = new FakeBackend();
  backend.responder = async () => ({
    text: JSON.stringify({ notes: 'A verified task note', memories: [] }),
  });
  app.router.backends.set('api', backend);
  const source = app.store.append(chat.id, 'user', 'human', 'A useful new fact');
  const base = app.reviews.policy(chat.personaId);
  app.store.set('review.tasks', []);
  app.reviews.saveTask('daily', { ...base, name: 'Daily' });
  app.reviews.saveTask('weekly', { ...base, name: 'Weekly' });
  const tasks = app.reviews.tasks();
  assert.equal(tasks.length, 2);
  const daily = tasks.find((t) => t.id === 'daily')!,
    weekly = tasks.find((t) => t.id === 'weekly')!;
  const first = await app.reviews.start(chat.personaId, 'same-key', undefined, daily);
  const second = await app.reviews.start(chat.personaId, 'same-key', undefined, weekly);
  assert.notEqual(first.id, second.id);
  await until(() => app.reviews.jobs().filter((j) => j.state === 'completed').length === 2);
  assert.equal((await app.reviews.collect(chat.personaId, undefined, daily)).length, 0);
  assert.equal(app.store.get('review.taskNotes.daily', ''), 'A verified task note');
  app.reviews.saveTask('later', { ...base, name: 'Later' });
  assert(
    (
      await app.reviews.collect(
        chat.personaId,
        undefined,
        app.reviews.tasks().find((t) => t.id === 'later')!,
      )
    ).some((m) => m.id === source.id),
  );
});

test('memory changes check versions and scope, preserve revisions and enforce core approval', async (t) => {
  const app = await setup(t);
  const old = await app.memories.save({
    personaId: 'companion',
    title: 'Name',
    text: 'Old name',
    core: false,
    tags: [],
    sources: [],
  });
  const change = memoryChange.parse({
    operation: 'update',
    subjectId: old.id,
    expectedVersion: old.version,
    title: 'Name',
    text: 'New name',
    sources: ['source'],
  });
  const result = await app.memories.change('companion', change, 'update-one');
  assert.equal(result.before[0].text, 'Old name');
  assert.equal(
    (await app.memories.change('companion', change, 'update-one')).after.text,
    'New name',
  );
  await assert.rejects(app.memories.change('companion', change, 'stale'), /已变化/);
  await assert.rejects(app.memories.change('other', change, 'cross-role'), /当前角色/);
  const proposal = memoryChange.parse({
    operation: 'propose-core',
    coreOperation: 'add',
    title: 'Core proposal',
    text: 'Proposed only',
    sources: ['source'],
  });
  await assert.rejects(app.memories.change('companion', proposal, 'unapproved'), /审批/);
  await app.memories.change('companion', proposal, 'approved', true);
  assert(app.store.documents<any>('memories').some((m) => m.title === 'Core proposal' && m.core));
});

test('Review submits a frozen core proposal and approval checks the current task grant', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('approvals');
  const chat = conversation(app, { review: true });
  const source = app.store.append(chat.id, 'user', 'human', 'A stable preference');
  app.store.set('review.tasks', []);
  app.reviews.saveTask('review-core', {
    ...app.reviews.policy(chat.personaId),
    conversationScope: 'selected',
    conversationIds: [chat.id],
    memoryOperations: ['propose-core'],
    autoApply: false,
  });
  const backend = new FakeBackend();
  backend.responder = async () => ({
    text: JSON.stringify({
      notes: 'Complete',
      memories: [
        {
          operation: 'propose-core',
          coreOperation: 'add',
          title: 'Preference',
          text: 'A stable preference',
          sources: [source.id],
        },
      ],
    }),
  });
  app.router.backends.set('api', backend);
  const job = await app.reviews.start(
    chat.personaId,
    'propose-core',
    undefined,
    app.reviews.tasks()[0],
  );
  await until(() =>
    ['completed', 'paused'].includes(app.reviews.jobs().find((j) => j.id === job.id)!.state),
  );
  assert.equal(app.reviews.jobs()[0].state, 'completed', app.reviews.jobs()[0].error ?? '');
  const approval = app.store.documents<any>('approvals')[0];
  assert.equal(approval.state, 'pending');
  assert(!app.store.documents<any>('memories').some((m) => m.title === 'Preference'));
  app.reviews.saveTask('review-core', { ...app.reviews.tasks()[0], memoryOperations: [] });
  const decided = await app.registry.call(
    'approvals.decide',
    { id: approval.id, revision: approval.revision, decision: 'approve', confirmed: true },
    { kind: 'ui', permissions: new Set(['*']) },
  );
  assert.equal(decided.state, 'failed');
  assert(!app.store.documents<any>('memories').some((m) => m.title === 'Preference'));
});

test('avatar state catalog supports concurrent task instances and plugin unload', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('avatar');
  const life = new AbortController();
  const off = app.capabilities.provide(
    { id: 'fixture', permissions: new Set(['avatar.state']), signal: life.signal },
    'avatar.states@1',
    'fixture.busy',
    'Fixture activity',
    () => ({
      priority: 80,
      clip: 'walk',
      instances: [
        { id: 'one', expiresAt: Date.now() + 10000 },
        { id: 'two', expiresAt: Date.now() + 10000 },
        { id: 'expired', expiresAt: 0 },
      ],
    }),
  );
  const states = await app.registry.call('avatar.states', { personaId: 'companion' }, internal);
  assert.equal(states.find((s: any) => s.id === 'fixture.busy').instances.length, 2);
  off();
  assert(
    !(await app.registry.call('avatar.states', {}, internal)).some(
      (s: any) => s.id === 'fixture.busy',
    ),
  );
});

test('care opportunities are spaced, bounded, persisted and never catch up missed opportunities', () => {
  const rule = config.parse({ dailyMax: 3, minMinutes: 60, hourStart: 8, hourEnd: 20 });
  const begin = localTime('2026-11-09', 8, 0, rule.timezone);
  const state: Decision = { day: '2026-11-09', attempts: 0, eligibleChecks: 0 };
  assert.equal(
    opportunity(rule, state, begin, () => 0.5),
    'waiting_opportunity',
  );
  const slots = [...state.opportunities!];
  assert.equal(slots.length, 3);
  assert(slots.every((slot, i) => !i || slot - slots[i - 1] >= 60 * 60000));
  assert.equal(
    opportunity(rule, state, slots[0] + 600000, () => {
      throw Error('must reuse persisted plan');
    }),
    'waiting_opportunity',
  );
  assert.equal(
    opportunity(rule, state, slots[1], () => 0),
    'selected',
  );
  state.attempts++;
  assert.equal(
    opportunity(rule, state, slots[1] + 1000, () => 0),
    'waiting_opportunity',
  );
});
