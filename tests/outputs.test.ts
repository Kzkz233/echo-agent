import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until, temporary, project } from './helpers.ts';
import { Application } from '../apps/server/application.ts';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { deliveryPoint } from '../packages/contracts/delivery.ts';
import { EchoError } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';

test('startup output migration preserves canonical Care and Review settings, not UI projections', async (t) => {
  const runtime=await temporary(t,false);
  let app=await Application.create({runtime,project});
  t.after(async()=>{await app.close();const {rm}=await import('node:fs/promises');assert(resolve(runtime).startsWith(resolve(join(tmpdir(),'EchoTests'))+sep));await rm(runtime,{recursive:true,force:true});});
  app.store.put('personas','companion',{id:'companion',name:'Fixture',prompt:'Synthetic persona'});
  const chat=conversation(app);
  await app.plugins.enable('care');
  const care={id:'legacy-care',name:'Legacy care',enabled:false,conversationId:chat.id,mode:'probability',probability:17};
  app.care.saveRule(care.id,care);
  app.reviews.saveTask('legacy-review',{personaId:'companion',name:'Legacy review',enabled:false,reportConversationId:chat.id});
  const beforeCare=app.store.get<any[]>('care.rules',[]),beforeReview=app.store.get<any[]>('review.tasks',[]);
  const type=(await app.automation.catalog(new AbortController().signal)).types.find(t=>t.id==='care.rules')!;
  assert.equal(type.items[0].settings?.mode,'opportunities');
  assert.equal(type.items[0].persistedSettings?.mode,'probability');
  app.store.set('outputs.taskMigration.v1',false);
  app.store.set('plugins.intent',Object.fromEntries(app.plugins.intent));
  await app.close();
  app=await Application.create({runtime,project});
  for(const [key,previous] of [['care.rules',beforeCare],['review.tasks',beforeReview]] as const){
    const next=app.store.get<any[]>(key,[]);
    for(const prior of previous){
      const migrated=next.find(item=>item.id===prior.id);
      if(!prior.conversationId&&!prior.reportConversationId){assert.deepEqual(migrated,prior);continue;}
      assert(Array.isArray(migrated.outputTargets),key+': '+prior.id);
      const {outputTargets,...rest}=migrated;
      assert.deepEqual(rest,prior);
    }
  }
  assert.equal(app.care.rules()[0].blockerIds,undefined);
});

async function fixture(t: any) {
  const app = await setup(t),
    chat = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.plugins.enable('care');
  let calls = 0,
    revision = '1',
    state = 'delivered';
  app.plugins.add({
    manifest: {
      id: 'fixture',
      name: 'Fixture',
      description: 'Synthetic output extension',
      version: '1',
      dependencies: [],
      permissions: ['outputs.provide'],
      settings: [],
    },
    activate: (ctx) => {
      ctx.capabilities.provide(deliveryPoint, 'fixture.outputs', 'Fixture', (input) => {
        if (input.action === 'list')
          return {
            targets: [{ id: 'fixture.destination', label: 'Fixture destination', revision }],
          };
        if (input.action === 'deliver') {
          calls++;
          if (state === 'throw') throw new EchoError('fixture_unknown', 'Synthetic unknown', true);
        }
        return { result: { state: state === 'throw' ? 'unknown' : state } };
      });
    },
  });
  await app.plugins.enable('fixture');
  return {
    app,
    chat,
    backend,
    calls: () => calls,
    setState: (value: string) => {
      state = value;
    },
    revise: () => {
      revision = '2';
    },
  };
}

test('one generated result fans out independently; retrying failed delivery never reruns inference', async (t) => {
  const f = await fixture(t);
  f.setState('failed');
  const result = await f.app.triggerActions.dispatch(
    {
      action: 'conversation',
      kind: 'care.opportunity',
      conversationId: f.chat.id,
      requestId: 'task-one',
      text: 'Synthetic task',
      outputTargets: ['core.chat', 'fixture.destination'],
      task: { type: 'care.rules', id: 'example' },
    },
    'care',
    new AbortController().signal,
  );
  assert.equal(result.state, 'executed');
  await until(
    () =>
      f.app.deliveries.rows().filter((r) => ['failed', 'delivered'].includes(r.state)).length === 2,
  );
  assert.equal(f.backend.calls.length, 1);
  assert.equal(f.calls(), 1);
  assert.equal(f.app.store.allMessages(f.chat.id).filter((m) => m.role === 'assistant').length, 1);
  const failed = f.app.deliveries.rows().find((r) => r.state === 'failed')!;
  f.setState('delivered');
  await f.app.deliveries.retry(failed.id, new AbortController().signal);
  assert.equal(f.calls(), 2);
  assert.equal(f.backend.calls.length, 1);
  assert(f.app.deliveries.rows().every((r) => r.state === 'delivered'));
});

test('reports can target external outputs without entering chat; main-chat presentations stay out of inference and Review', async (t) => {
  const f = await fixture(t);
  for (const [requestId, outputTargets] of [
    ['external', ['fixture.destination']],
    ['main', ['core.chat']],
  ] as const)
    await f.app.triggerActions.dispatch(
      {
        action: 'notice',
        kind: 'review.completed',
        requestId,
        conversationId: f.chat.id,
        title: 'Review',
        text: 'PRESENTATION_ONLY_REPORT',
        outputTargets: [...outputTargets],
        task: { type: 'review.policies', id: 'review-one' },
      },
      'review',
      new AbortController().signal,
    );
  assert.equal(f.calls(), 1);
  const messages = f.app.store.allMessages(f.chat.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].meta.presentationOnly, true);
  assert.equal(f.app.store.documents<any>('outputs').length, 2);
  assert(f.app.store.documents<any>('outputs').every((output) => output.plan.source === 'review'));
  await f.app.router.send({
    conversationId: f.chat.id,
    text: 'Next human turn',
    requestId: 'next',
  });
  assert(!JSON.stringify(f.backend.calls[0].messages).includes('PRESENTATION_ONLY_REPORT'));
  assert(
    !(await f.app.reviews.collect('companion')).some((material) =>
      material.text.includes('PRESENTATION_ONLY_REPORT'),
    ),
  );
});

test('unknown delivery is never retried and changed or missing targets do not redirect an old result', async (t) => {
  const f = await fixture(t);
  f.setState('throw');
  const plan = await f.app.deliveries.plan(f.chat.id, 'review', ['fixture.destination']);
  await f.app.deliveries.publish({
    id: 'unknown',
    personaId: 'companion',
    conversationId: f.chat.id,
    text: 'Synthetic',
    plan,
  });
  const receipt = f.app.deliveries.rows()[0];
  assert.equal(receipt.state, 'unknown');
  await assert.rejects(
    f.app.deliveries.retry(receipt.id, new AbortController().signal),
    /只能重试/,
  );
  await f.app.deliveries.refreshQueued();
  assert.equal(f.calls(), 1);
  f.revise();
  f.setState('delivered');
  await f.app.deliveries.publish({
    id: 'changed',
    personaId: 'companion',
    conversationId: f.chat.id,
    text: 'Synthetic',
    plan,
  });
  assert.equal(f.app.deliveries.rows('changed')[0].state, 'skipped');
  assert.equal(f.calls(), 1);
  await f.app.plugins.disable('fixture');
  await f.app.deliveries.publish({
    id: 'unloaded',
    personaId: 'companion',
    conversationId: f.chat.id,
    text: 'Synthetic',
    plan,
  });
  assert.equal(f.app.deliveries.rows('unloaded')[0].state, 'skipped');
  await f.app.plugins.enable('fixture');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls(), 1);
});

test('legacy notification and Review bindings migrate to Review targets without double delivery', async (t) => {
  const app = await setup(t),
    chat = conversation(app);
  let sent = 0;
  app.plugins.add({
    manifest: {
      id: 'fixture',
      name: 'Fixture',
      description: 'Synthetic',
      version: '1',
      permissions: ['channels.adapter'],
      dependencies: ['channels'],
      settings: [],
    },
    activate: (ctx) => {
      ctx.capabilities.provide('channels.send@1', 'fixture.channel', 'Fixture', () => {
        sent++;
        return { state: 'delivered' };
      });
    },
  });
  await app.plugins.enable('fixture');
  for (const source of ['notification', 'review']) {
    await app.registry.call(
      'channels.bind',
      {
        id: 'binding',
        adapter: 'fixture.channel',
        peer: 'fictional',
        conversationId: chat.id,
        automaticSources: [source],
      },
      internal,
    );
    const plan = await app.deliveries.plan(chat.id, 'review', undefined, { bubble: true });
    assert(plan.targets.some((t) => t.id === 'channels.binding.binding'));
    await app.deliveries.publish({
      id: 'report-' + source,
      personaId: 'companion',
      conversationId: chat.id,
      title: 'Synthetic Review',
      text: 'Done',
      plan,
    });
  }
  assert.equal(sent, 2);
  assert.equal(app.store.documents('channel-outbound').length, 0);
});

test('empty output selection keeps the result and task attribution without presentation', async (t) => {
  const f = await fixture(t);
  const result = await f.app.triggerActions.dispatch(
    {
      action: 'conversation',
      kind: 'care.opportunity',
      conversationId: f.chat.id,
      requestId: 'silent-targets',
      text: 'Synthetic task',
      outputTargets: [],
      task: { type: 'care.rules', id: 'quiet' },
    },
    'care',
    new AbortController().signal,
  );
  assert.equal(result.state, 'executed');
  assert.equal(f.backend.calls.length, 1);
  assert.equal(f.calls(), 0);
  const output = f.app.store.documents<any>('outputs')[0];
  assert.deepEqual(output.plan.targets, []);
  assert.equal(output.plan.task.id, 'quiet');
  assert.equal(f.app.store.pendingDeliveries().length, 0);
  assert.equal(f.app.deliveries.rows().length, 0);
});

test('Review freezes destinations before reading and never sends to a replacement binding', async (t) => {
  const f = await fixture(t);
  await f.app.registry.call(
    'automation.save',
    {
      type: 'review.policies',
      id: 'review-frozen',
      settings: {
        personaId: 'companion',
        name: 'Synthetic review',
        enabled: false,
        reportConversationId: f.chat.id,
        outputTargets: ['fixture.destination'],
        autoApply: false,
      },
    },
    internal,
  );
  f.app.store.append(f.chat.id, 'user', 'human', 'Synthetic material for review');
  let finish!: (value: any) => void;
  f.backend.responder = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const task = f.app.reviews.tasks().find((task) => task.id === 'review-frozen')!;
  const job = await f.app.reviews.start('companion', 'frozen', undefined, task);
  await until(() => f.backend.calls.length === 1);
  f.revise();
  finish({ text: JSON.stringify({ notes: 'Synthetic complete', memories: [], actions: [] }) });
  await until(() => f.app.deliveries.rows().some((row) => row.state === 'skipped'));
  assert.equal(f.app.reviews.jobs().find((row) => row.id === job.id)?.state, 'completed');
  assert.equal(f.calls(), 0);
});

test('unresolved delivery protects its conversation until explicit closure, without sending again', async (t) => {
  const f = await fixture(t);
  f.setState('throw');
  const plan = await f.app.deliveries.plan(f.chat.id, 'review', ['fixture.destination']);
  await f.app.deliveries.publish({
    id: 'protected-output',
    personaId: 'companion',
    conversationId: f.chat.id,
    text: 'Synthetic',
    plan,
  });
  const row = f.app.deliveries.rows()[0];
  const refs = await f.app.registry.call('conversations.references', { id: f.chat.id }, internal);
  assert(refs.some((ref: any) => ref.label === '待核对的任务投递' && ref.blocksDeletion));
  await f.app.registry.call('outputs.resolve', { id: row.id, confirmed: true }, internal);
  assert.equal(f.app.deliveries.rows()[0].state, 'closed');
  await assert.rejects(f.app.deliveries.retry(row.id, new AbortController().signal), /只能重试/);
  assert.equal(f.calls(), 1);
  assert(
    !(await f.app.registry.call('conversations.references', { id: f.chat.id }, internal)).some(
      (ref: any) => ref.label === '待核对的任务投递',
    ),
  );
});
