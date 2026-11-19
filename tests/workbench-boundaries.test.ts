import assert from 'node:assert/strict';
import test from 'node:test';
import { contributeAutomation } from '../packages/kernel/automation.ts';
import { deliveryPoint } from '../packages/contracts/delivery.ts';
import { internal } from '../packages/kernel/registry.ts';
import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { atomicJson } from '../packages/kernel/update-files.ts';
import { waitForUpdateHelper } from '../packages/kernel/updates.ts';
import { conversation, setup, temporary, until } from './helpers.ts';

test('update handoff waits for this helper even when a previous launch left a ready receipt', async t => {
  const dir = await temporary(t);
  const helper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { helper.kill(); });
  const receipt = join(dir, 'helper-ready.json');
  const base = { id: basename(dir), pid: helper.pid };
  await atomicJson(receipt, { ...base, launchId: 'previous' });
  let ready = false;
  const waiting = waitForUpdateHelper(dir, helper, 'current').then(() => { ready = true; });
  await new Promise(done => setTimeout(done, 150));
  assert.equal(ready, false);
  await atomicJson(receipt, { ...base, pid: -1, launchId: 'current' });
  await new Promise(done => setTimeout(done, 5100));
  assert.equal(ready, false);
  await atomicJson(receipt, { ...base, launchId: 'current' });
  await waiting;
  assert.equal(ready, true);
});

test('restart waits for provider acknowledgement and freezes outbound dispatch at handoff', async t => {
  const app = await setup(t, []);
  const chat = conversation(app);
  const original = process.env.ECHO_DESKTOP_PID;
  process.env.ECHO_DESKTOP_PID = String(process.pid);
  t.after(() => {
    if (original === undefined) delete process.env.ECHO_DESKTOP_PID;
    else process.env.ECHO_DESKTOP_PID = original;
  });
  let release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  app.plugins.add({
    manifest: { id: 'testout', name: 'Test output', description: 'Fixture', version: '1',
      dependencies: [], permissions: ['outputs.provide'], settings: [] },
    activate(ctx) {
      ctx.capabilities.provide(deliveryPoint, 'testout.provider', 'Test', async input => {
        if (input.action === 'list') return { targets: [{ id: 'testout.chat', label: 'Test', revision: '1' }] };
        sent++;
        await hold;
        return { result: { state: 'delivered' } };
      });
    },
  });
  await app.plugins.enable('testout');
  const plan = await app.deliveries.plan(chat.id, 'human', ['testout.chat']);
  const output = { id: 'first', conversationId: chat.id, personaId: chat.personaId, text: 'Fixture', plan };
  const first = app.deliveries.publish(output);
  try {
    await until(() => sent === 1);
    const request = app.lifecycle.request('restart');
    await until(() => request.blockers.includes('消息仍在投递'));
    assert.equal(request.state, 'waiting');
    await assert.rejects(app.lifecycle.freeze(), { code: 'update_busy' });
    release();
    assert.equal((await first)[0].state, 'delivered');
    await until(() => request.state === 'ready');
    await app.lifecycle.handoff(request.id);
    const second = await app.deliveries.publish({ ...output, id: 'second' });
    assert.equal(second[0].state, 'pending');
    assert.equal(sent, 1);
    await app.lifecycle.restore();
    await until(() => app.deliveries.rows('second')[0].state === 'delivered');
    assert.equal(sent, 2);
  } finally { release(); await first; }
});

test('only one editor can commit a knowledge policy at the same revision', async t => {
  const app = await setup(t);
  const current: any = await app.registry.call('knowledge.pipeline.status', {}, internal);
  const values = [1500, 1800].map(chunkChars => ({
    policy: { ...current.policy, documentParser: '', mediaParser: '', imageParser: '', chunkChars },
    expected: current.fingerprint,
  }));
  const results = await Promise.allSettled(values.map(v => app.registry.call('knowledge.pipeline.save', v, internal)));
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'revision_conflict').length, 1);
  const saved = results.findIndex(r => r.status === 'fulfilled');
  assert.equal(app.knowledge.pipeline.policy().chunkChars, values[saved].policy.chunkChars);
});

test('disabled feature settings cannot prevent opening the workbench', async t => {
  const app = await setup(t, []);
  const bad = { threshold: 2 };
  app.store.set('semantic.config', bad);
  assert.throws(() => app.semantic.config());
  const shell: any = await app.registry.call('system.bootstrap', {}, internal);
  assert(Array.isArray(shell.conversations));
  assert.equal(shell.ragConfig, undefined);
  assert.deepEqual(app.store.get('semantic.config', null), bad);
});

test('dialogue pagination selects local presentations before applying page limits', async t => {
  const app = await setup(t, []);
  const chat = conversation(app);
  const append = (role: 'system' | 'user' | 'assistant', meta = {}) =>
    app.store.append(chat.id, role, role === 'user' ? 'human' : 'chat', 'fixture', undefined, meta);
  append('system');
  const expected = Array.from({ length: 102 }, () => append('user').id);
  expected.push(append('system', { presentationOnly: true }).id);
  for (let n = 0; n < 110; n++) append('system');
  append('assistant', { workSession: true });
  append('assistant', { delivery: { targets: [{ id: 'fixture.qq' }] } });
  const page = async (v: object) => await app.registry.call('conversations.messages',
    { id: chat.id, limit: 100, view: 'dialogue', ...v }, internal) as any;
  const last = await page({});
  assert.equal(last.hasOlder, true);
  assert.deepEqual(last.messages.map((m: any) => m.id), expected.slice(-100));
  const first = await page({ before: last.messages[0].seq });
  assert.equal(first.hasOlder, false);
  assert.deepEqual(first.messages.map((m: any) => m.id), expected.slice(0, -100));
  const forward = await page({ after: first.messages.at(-1).seq });
  assert.deepEqual(forward.messages, last.messages);
  const full = await page({ view: 'session' });
  assert.equal(full.messages.at(-1).meta.delivery.targets[0].id, 'fixture.qq');
});

test('history orders by event time with stable ties across the page boundary', async t => {
  const app = await setup(t);
  await app.plugins.enable('scheduler');
  const put = (id: string, n: number) => app.store.put('scheduler-runs', id,
    { id, startedAt: new Date(n).toISOString() });
  for (let n = 0; n < 505; n++) put('job-' + String(505 - n).padStart(3, '0'), n);
  put('new-b', 600);
  put('new-a', 600);
  const list = async (v: object) => (await app.registry.call('scheduler.list', v, internal) as any).runs;
  const latest = await list({});
  assert.equal(latest.length, 500);
  assert.deepEqual(latest.slice(0, 3).map((r: any) => r.id), ['new-b', 'new-a', 'job-001']);
  assert.equal((await list({ limit: 1, before: 'new-b' }))[0].id, 'new-a');
  const earlier = await list({ before: latest.at(-1).id });
  assert.equal(new Set([...latest, ...earlier].map(r => r.id)).size, 507);

  await app.plugins.enable('agenda');
  for (const [id, time] of [['z', 1], ['a', 2]] as const)
    app.store.put('agenda-reminders', id, { id, createdAt: new Date(time).toISOString() });
  const reminders = await app.registry.call('agenda.reminders', { limit: 1 }, internal);
  assert.equal(reminders[0].id, 'a');

  const chat = conversation(app);
  const message = app.store.append(chat.id, 'assistant', 'chat', 'Fixture');
  app.store.put('channel-outbound', 'legacy', { id: 'legacy', messageId: message.id, state: 'delivered' });
  app.store.put('channel-outbound', 'z', { id: 'z', createdAt: new Date(0).toISOString(), state: 'delivered' });
  const channels = await app.registry.call('channels.list', { limit: 1 }, internal);
  assert.equal(channels.deliveries[0].id, 'legacy');
  const previous = await app.registry.call('channels.list', { before: 'legacy', limit: 1 }, internal);
  assert.equal(previous.deliveries[0].id, 'z');
});

test('a slow task descriptor is isolated and can reappear when healthy', async t => {
  const app = await setup(t, []);
  let aborted = false, slow = true;
  app.plugins.add({
    manifest: { id: 'metadatafixture', name: 'Metadata', version: '1', description: 'Fixture',
      dependencies: [], permissions: ['automation.contribute'], settings: [] },
    activate(ctx) {
      contributeAutomation(ctx, 'metadatafixture.fast', 'Fast fixture', { describe: () => ({ items: [] }) });
      contributeAutomation(ctx, 'metadatafixture.slow', 'Slow fixture', { async describe(signal) {
        if (slow) await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
        });
        return { items: [] };
      } });
    },
  });
  await app.plugins.enable('metadatafixture');
  const list = () => app.automation.catalog(new AbortController().signal);
  const partial = await list();
  assert(aborted && partial.unavailable.includes('Slow fixture'));
  assert(partial.types.some(type => type.id === 'metadatafixture.fast'));
  slow = false;
  assert((await list()).types.some(type => type.id === 'metadatafixture.slow'));
});
