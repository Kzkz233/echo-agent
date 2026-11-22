import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryPoint } from '../packages/contracts/delivery.ts';
import { internal } from '../packages/kernel/registry.ts';
import { decideOccurrence, latestDaily, occurrenceHistory } from '../packages/kernel/schedule-policy.ts';
import { conversation, FakeBackend, setup, until } from './helpers.ts';
import { localDay } from '../packages/kernel/time.ts';

test('missed schedules use the most recent local deadline, grace and business expiry', () => {
  const now = Date.parse('2026-11-22T06:50:00+08:00');
  const slot = latestDaily(now, 7, 0, 'Asia/Shanghai');
  assert.equal(slot, Date.parse('2026-11-21T07:00:00+08:00'));
  assert.equal(decideOccurrence(slot, slot, now, 'once', slot).outcome, 'catchup');
  assert.equal(decideOccurrence(slot, slot, now, 'skip', now).outcome, 'skipped');
  assert.equal(decideOccurrence(slot, slot, slot + 100, 'skip', now).outcome, 'due');
  assert.equal(decideOccurrence(slot, slot, now, 'valid', now).outcome, 'catchup');
  assert.equal(decideOccurrence(slot, slot, now, 'valid', now - 1).outcome, 'skipped');
});

test('daily Review reopened before the next deadline consumes outstanding material only once', async t => {
  const app = await setup(t), chat = conversation(app, {review:true}), backend = new FakeBackend();
  app.clock.pause();
  app.router.backends.set('api',backend);
  backend.responder = async () => ({text:'{"notes":"Read the material","report":"Fixture","memories":[]}'});
  app.store.set('review.config',{enabled:true,mode:'daily',hour:7,minute:0,timezone:'Asia/Shanghai',reportConversationId:chat.id});
  app.store.append(chat.id,'user','human','A new fixture document.');
  const day = localDay(new Date(Date.now()+3*86400000),'Asia/Shanghai');
  const now = new Date(day+'T06:00:00+08:00'), slot = latestDaily(+now,7,0,'Asia/Shanghai');
  const policy = app.reviews.tasks()[0];
  app.store.set('review.nextSlot.'+policy.id,slot-2*86400000);
  await Promise.all([app.reviews.tick(now),app.reviews.tick(now)]);
  await until(() => app.reviews.jobs().some(job => ['completed','paused','failed'].includes(job.state)));
  assert.equal(app.reviews.jobs()[0].state,'completed',app.reviews.jobs()[0].error ?? 'Expected completed review');
  await app.reviews.tick(now);
  const history = occurrenceHistory(app.store,'review.policies',policy.id,chat.personaId);
  assert.equal(history.length,1);
  assert.equal(history[0].scheduled,slot);
  assert.equal(history[0].outcome,'catchup');
  assert.equal(app.reviews.jobs().length,1);
  assert.equal(backend.calls.length,1);
});

test('restoring persisted application schedules coalesces old slots, preserves edits, and never fires twice', async t => {
  const app = await setup(t);
  await app.plugins.enable('scheduler');
  app.clock.pause();
  const delivered: string[] = [];
  const dispose = app.capabilities.provide({
    id: 'fixture', permissions: new Set(['scheduler.contribute']), signal: new AbortController().signal,
  }, 'scheduler.handlers@1', 'fixture.sync', 'Fixture', request => { delivered.push(request.scheduledAt); return {}; });
  const minute = 60000, first = Date.now() - 32 * minute;
  const job = app.scheduler.save({ id:'fixture', name:'Fixture', provider:'fixture.sync', enabled:true, mode:'interval', minutes:10 });
  app.store.put('scheduler-jobs', job.id, { ...job, nextAt:first });
  assert.equal(app.scheduler.save({ ...job, name:'Renamed' }).nextAt, first);
  app.clock.resume();
  await until(() => delivered.length === 1);
  assert.deepEqual(delivered, [new Date(first + 30 * minute).toISOString()]);
  const history = occurrenceHistory(app.store, 'scheduler.timed', job.id);
  assert.equal(history[0].first, first);
  assert.equal(history[0].outcome, 'catchup');
  assert.equal(app.scheduler.jobs()[0].nextAt, first + 40 * minute);
  app.scheduler.refresh();
  assert.equal(app.store.documents('scheduler-runs').length, 1);
  dispose();
});

test('calendar reminders inherit role targets, support record-only overrides and show deferred receipts without inference', async t => {
  const app = await setup(t);
  await app.plugins.enable('agenda');
  app.clock.pause();
  const c = conversation(app);
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.put('characters', c.personaId, { id:c.personaId, features:['agenda'], state:'ready', mainConversationId:c.id });
  let calls = 0;
  const destination = 'fixture.mobile';
  const dispose = app.capabilities.provide({
    id:'fixture', permissions:new Set(['outputs.provide']), signal:new AbortController().signal,
  }, deliveryPoint, 'fixture.reminders', 'Fixture', (request) => {
    if (request.action === 'list') return { targets:[{ id:destination, label:'Mobile', revision:'1' }] };
    if (request.action === 'deliver') calls++;
    return { result:{state:'queued'} };
  });
  const signal = new AbortController().signal;
  await app.automation.mutate('agenda.reminders', {action:'save',id:c.personaId,settings:{personaId:c.personaId,outputTargets:[destination]}}, signal);
  const defaults = await app.registry.call('agenda.reminderDefaults',{personaId:c.personaId},internal);
  assert.deepEqual(defaults, { personaId:c.personaId,conversationId:c.id,outputTargets:[destination] });
  const now = Date.now(), start = new Date(now - 120000).toISOString();
  const entry = { title:'Synthetic event', start, reminder:{enabled:true, minutesBefore:0} };
  const sent = app.agenda.save(entry);
  app.agenda.save({ ...entry, title:'Record only', reminder:{...entry.reminder, outputTargets:[]} });
  app.agenda.save({ ...entry, title:'Expired', start:new Date(now - 7200000).toISOString() });
  app.agenda.save({ ...entry, title:'Cancelled', state:'cancelled' });
  const old = app.agenda.save({ ...entry, title:'Pre-upgrade receipt' });
  app.store.put('agenda-reminders','legacy',{ id:'legacy', itemId:old.id, scheduledAt:start, createdAt:start, state:'delivered' });
  await app.agenda.tick(now);
  app.agenda.save({ ...sent, reminder:{ ...sent.reminder, outputTargets:[] } });
  await app.agenda.tick(now + 20);
  assert.equal(calls,1);
  assert.equal(backend.calls.length,0);
  assert.equal(app.store.allMessages(c.id).filter(m => m.meta.taskResultId).length,2);
  const history = await app.registry.call('automation.history',{type:'agenda.reminders',id:c.personaId,personaId:c.personaId},internal);
  assert.equal(history.occurrences.length,3);
  assert.equal(history.results.length,2);
  const notices = await app.registry.call('agenda.reminders',{},internal);
  assert.deepEqual(notices.find((row:any) => row.itemId === sent.id).deliveries, [{targetId:destination,label:'Mobile',state:'queued'}]);
  assert.equal(notices.find((row:any) => row.title === 'Expired').state,'missed');
  const receipt = app.deliveries.rows()[0];
  app.store.put('output-deliveries',receipt.id,{ ...receipt, state:'delivered' });
  const current = await app.registry.call('agenda.reminders',{},internal);
  assert.equal(current.find((row:any) => row.itemId === sent.id).state,'delivered');
  assert.equal(calls,1);
  dispose();
});
