import test from 'node:test';
import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import {
  conversation,
  FakeBackend,
  project,
  setup,
  submitFixtureReplies,
  until,
} from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';

test('an installed reading reminder declares its own checkpoint and leaves accessible result and delivery history after uninstall', async (t) => {
  const app = await setup(t, []),
    backend = new FakeBackend();
  const call = (name: string, value: object) => app.registry.call(name, value, internal);
  const personaId = 'reader';
  const chat = conversation(app, { personaId, kind: 'main' });
  app.router.backends.set('api', backend);
  await app.router.bind(chat.id, 'test', new AbortController().signal);
  const directory = join(app.runtime, 'reading-fixture');
  await cp(join(project, 'tests/fixtures/reading-reminder'), directory, { recursive: true });
  await app.extensions.install(directory, true);
  await app.plugins.enable('reading');
  const type = 'reading.reminders',
    id = 'book-of-the-week';
  const catalog = await call('automation.types', { type });
  assert.equal(catalog.types[0].owner, 'reading');
  assert(
    app.triggerActions
      .sources()
      .some((p) => p.id === 'reading.due' && p.point === 'core.automation.signals@3'),
  );
  await call('automation.save', {
    type,
    id,
    settings: {
      name: 'Read chapter five',
      enabled: true,
      personaId,
      conversationId: chat.id,
      outputTargets: ['core.chat'],
    },
  });
  const original = process.env.ECHO_DESKTOP_PID;
  process.env.ECHO_DESKTOP_PID = String(process.pid);
  t.after(() => {
    if (original === undefined) delete process.env.ECHO_DESKTOP_PID;
    else process.env.ECHO_DESKTOP_PID = original;
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.responder = async (r) => {
    await hold;
    return submitFixtureReplies(r, 'Read chapter five this evening.');
  };
  const running = call('automation.run', { type, id, requestId: 'reading-slot' });
  try {
    await until(() => backend.calls.length === 1);
    const restart = app.lifecycle.request('restart');
    await until(() => restart.blockers.includes('阅读提醒正在提交'));
    assert.equal(restart.state, 'waiting');
    await assert.rejects(app.lifecycle.freeze(), { code: 'update_busy' });
    await call('system.lifecycle.cancel', {});
  } finally {
    release();
    await running;
  }
  const history = () => call('automation.history', { type, id, personaId });
  await until(() =>
    app.deliveries.rows().some((r) => r.targetId === 'core.chat' && r.state === 'delivered'),
  );
  const before = await history();
  assert.equal(before.results.length, 1);
  const result = before.results[0];
  assert.equal(result.handoff, 'succeeded');
  assert.equal(result.text, 'Read chapter five');
  assert.equal(result.outputs[0].text, 'Read chapter five this evening.');
  assert.equal(result.outputs[0].deliveries[0].state, 'delivered');
  // A cancelled restart reopens the participant gate. Replaying the original
  // event must use the existing parent run and channel receipt.
  await call('automation.run', { type, id, requestId: 'reading-slot' });
  assert.equal(backend.calls.length, 1);
  const next = app.lifecycle.request('restart');
  await until(() => next.state === 'ready');
  await app.lifecycle.handoff(next.id);
  await app.lifecycle.restore();
  await app.extensions.uninstall('reading');
  assert.equal((await call('automation.types', { type })).types.length, 0);
  assert(!app.triggerActions.sources().some((p) => p.owner === 'reading'));
  assert(
    !app.capabilities.list('core.lifecycle.participants@1').some((p) => p.owner === 'reading'),
  );
  assert(
    (await call('automation.recordedTasks', { personaId })).some(
      (r: any) => r.type === type && r.id === id,
    ),
  );
  assert.deepEqual(await history(), before);
  assert.deepEqual(await call('automation.recordedTasks', { personaId: 'other' }), []);
});

test('only the coordinator may acquire checkpoint gates; unavailable participants prevent handoff', async t => {
  const app=await setup(t,[]);
  const point='core.lifecycle.participants@1';
  let resumes=0;
  app.plugins.add({manifest:{id:'checkpointtest',name:'Checkpoint',description:'Fixture',version:'1',
    dependencies:[],settings:[],permissions:['lifecycle.contribute','system.write']},activate(ctx){
      ctx.capabilities.provide(point,'checkpointtest.storage','Storage',input=>{
        if(input.action==='resume'){resumes++;return {blockers:[]};}
        throw Error('Temporarily unavailable');
      });
    }});
  await app.plugins.enable('checkpointtest');
  const foreign=app.capabilities.forOwner({id:'foreign',permissions:new Set(['*']),signal:new AbortController().signal},()=>{});
  await assert.rejects(foreign.invoke(point,'core.execution',{action:'prepare',requestId:crypto.randomUUID()}),{code:'capability_consume_denied'});
  await assert.rejects(app.lifecycle.freeze(),{code:'update_busy'});
  await app.lifecycle.restore();assert.equal(resumes,1);
  await app.plugins.disable('checkpointtest');
  await app.lifecycle.freeze();await app.lifecycle.restore();
});
