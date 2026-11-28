import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FakeBackend, until, submitFixtureReplies } from './helpers.ts';
import { echoToolPermissions } from '../packages/kernel/tool-access.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';

test('Review hands registered target acknowledgements to the parent separately from unverified model claims', async t => {
  const app = await setup(t), fake = new FakeBackend();
  await app.plugins.enable('notifications');
  app.router.backends.set('api', fake);
  const role = await app.registry.call('persona.character.commit', { requestId: 'role', draft: characterDraft.parse({
    persona: { id: 'fixture', name: 'Fixture', prompt: 'Synthetic persona' }, profileId: 'test', features: ['memory', 'review'],
  }) }, internal);
  let applied = 0;
  app.plugins.add({ manifest: { id: 'fixture-target', name: 'Fixture target', description: 'Synthetic', version: '1',
    dependencies: ['review'], permissions: ['review.contribute'], settings: [] }, activate(ctx) {
    ctx.capabilities.provide('review.targets@1', 'fixture-target.state', 'Fixture', (input: any) => {
      if (input.action === 'describe') return { context: 'No existing records', instructions: 'Can add a record.' };
      assert.deepEqual(input.proposals.map((p: any) => p.operation), ['add']);
      applied++;
      return { applied: 1 };
    });
  } });
  await app.plugins.enable('fixture-target');
  app.store.append(role.mainConversationId, 'user', 'human', 'Synthetic material');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'review', settings: {
    personaId: 'fixture', enabled: false, report: true, autoApply: true, memoryOperations: [],
    conversationScope: 'selected', conversationIds: [role.mainConversationId], sourceIds: [],
    targetIds: ['fixture-target.state'], outputTargets: ['core.chat', 'notifications.inbox'],
  } }, internal);
  fake.responder = async request => {
    if (request.principal?.conversationId === role.mainConversationId) return submitFixtureReplies(request, 'Report');
    const job = app.reviews.jobs()[0];
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: new Set(['review.read', 'review.write']) };
    const call = (name: string, value: unknown) => app.registry.call(name, value, caller);
    while (app.reviews.jobs()[0].nextPacket < job.packets.length) {
      const packet = await call('review.readMaterial', { jobId: job.id }) as any;
      await call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] });
    }
    await assert.rejects(call('review.stageAction', { jobId: job.id, action: {
      target: 'fixture-target.state', operation: 'forget', text: 'Invalid deletion', sources: job.packets[0].sources,
    } }));
    await call('review.stageAction', { jobId: job.id, action: {
      target: 'fixture-target.state', operation: 'add', title: 'Record', text: 'Added', sources: job.packets[0].sources,
    } });
    await call('review.finish', { jobId: job.id, report: 'UNVERIFIED_CLAIM: also deleted an old record.' });
    return { text: 'Done' };
  };
  const job = await app.reviews.start('fixture', 'evidence');
  await until(() => app.reviews.jobs()[0].state === 'completed');
  await until(() => fake.calls.some(call => call.principal?.conversationId === role.mainConversationId));
  const report = app.store.document<any>('review-reports', 'review-report.' + job.id + '.completed');
  assert(report.text.includes('执行结果以以下程序回执为准'));
  assert(report.text.includes('通过校验并交付的操作类型 add'));
  assert(report.text.includes('插件确认生效 1 次'));
  assert(report.text.indexOf('不是执行凭证') < report.text.indexOf('UNVERIFIED_CLAIM'));
  assert(!report.text.includes('操作类型 forget'));
  assert.equal(applied, 1);
  await app.reviews.execute(job.id);
  assert.equal(applied, 1);
  assert.equal(app.store.documents('review-target-results.' + job.id).length, 1);
  await app.registry.call('review.verifyReport', { id: job.id, confirmed: true }, internal);
  await app.registry.call('review.verifyReport', { id: job.id, confirmed: true }, internal);
  await until(() => fake.calls.filter(call => call.principal?.conversationId === role.mainConversationId).length === 2);
  const verification = app.store.document<any>('review-reports', 'review-report.' + job.id + '.verified');
  assert(!verification.text.includes('UNVERIFIED_CLAIM'));
  assert(verification.text.includes('不是再次整理'));
  assert(verification.text.includes('fixture-target.state: add'));
  assert(!verification.text.includes('fixture-target.state: forget'));
  assert.equal(applied, 1);
  assert.equal(fake.calls.filter(call => call.principal?.conversationId !== role.mainConversationId).length, 1);
  await assert.rejects(app.registry.call('review.verifyReport', { id: job.id, confirmed: true, targetIds: ['unconfigured'] }, internal), /原已授权/);
  await assert.rejects(app.registry.call('review.verifyReport', { id: job.id, confirmed: true, targetIds: [] }, internal), /原已授权/);
  await app.registry.call('review.verifyReport', { id: job.id, confirmed: true, targetIds: ['notifications.inbox'] }, internal);
  await app.registry.call('review.verifyReport', { id: job.id, confirmed: true, targetIds: ['notifications.inbox'] }, internal);
  await until(() => fake.calls.filter(call => call.principal?.conversationId === role.mainConversationId).length === 3);
  assert.deepEqual(fake.calls.filter(call => call.principal?.conversationId === role.mainConversationId).at(-1)?.replyTargets, ['notifications.inbox']);
  assert.equal(applied, 1);
  assert.equal(fake.calls.filter(call => call.principal?.conversationId !== role.mainConversationId).length, 1);
});

for (const mode of ['correct','withdraw'] as const) test('Review repairs only an invalid legacy target proposal: ' + mode, async t => {
  const app = await setup(t), fake = new FakeBackend();
  app.router.backends.set('api',fake);
  await app.plugins.enable('reflections');
  await app.plugins.enable('channels');
  const role = await app.registry.call('persona.character.commit',{requestId:'fixture-role',draft:characterDraft.parse({
    persona:{id:'fixture',name:'Fixture',prompt:'Fixture'}, profileId:'test',features:['review','memory','reflections'],
  })},internal);
  let external = 0;
  app.capabilities.provide({id:'fixture',permissions:new Set(['channels.adapter']),signal:new AbortController().signal},
    'channels.send@1','fixture.mobile','Synthetic QQ',() => { external++; return {state:'delivered'}; });
  const binding = await app.registry.call('channels.bind',{adapter:'fixture.mobile',peer:'fixture-peer',conversationId:role.mainConversationId},internal);
  const mobile = 'channels.binding.' + binding.id;
  const original = await app.registry.call('reflections.save',{personaId:'fixture',title:'Fixture concern',text:'Original'},internal);
  await app.registry.call('automation.save',{type:'review.policies',id:'fixture-review',settings:{
    personaId:'fixture', enabled:false, autoApply:true, report:true, memoryOperations:['add'],packetChars:2000,
    targetIds:['reflections.state'],'targetPrompt.reflections.state':'ROLE_PREFERENCE',outputTargets:['core.chat',mobile],
  }},internal);
  const jobNow = () => app.reviews.jobs()[0];
  let reads = 0, workerTurns = 0;
  fake.responder = async request => {
    if (request.principal?.conversationId === role.mainConversationId) return submitFixtureReplies(request,'Fixture report');
    workerTurns++;
    const job = jobNow();
    const caller = {kind:'mcp' as const,...request.principal!,permissions:echoToolPermissions(app.store,false,
      request.principal,app.plugins.characterPermissions())};
    const call = (name:string, args:Record<string,unknown>) => app.registry.call(name,{jobId:job.id,...args},caller);
    const sources = job.packets[0].sources;
    const action = {target:'reflections.state',operation:'update',text:'Revised',title:'Fixture concern',
      expectedVersion:original.version,sources,attributes:{focus:'next',mood:'unsupported'}};
    const repaired = {...action, subjectId:original.id, attributes:{focus:'next'}};
    if (workerTurns === 1) {
      assert.equal(job.packets.length,5);
      assert.match(JSON.stringify(request.messages),/ROLE_PREFERENCE/);
      assert.match(JSON.stringify(request.messages),/subjectId/);
      while (jobNow().nextPacket < job.packets.length) {
        const packet = await call('review.readMaterial',{});
        await call('review.checkpoint',{packetIndex:packet.index,candidates:[]}); reads++;
      }
      for (let i=0; i<6; i++) await app.registry.call('memory.change',{requestId:'change-'+i,
        change:{operation:'add',title:'Fixture '+i,text:'Evidence '+i,sources}},caller);
      await assert.rejects(call('review.stageAction',{action}), error =>
        error instanceof Error && ['subjectId','mood','focus'].every(field => error.message.includes(field)));
      assert.equal(jobNow().actions?.length ?? 0,0);
      await call('review.stageAction',{action:repaired});
      await call('review.finish',{report:'Fixture complete'});
      // Simulate a persisted pre-upgrade record whose staging call accepted bad fields.
      const legacy=jobNow();
      app.store.put('review-jobs',job.id,{...legacy,actions:[action],targets:legacy.targets!.map(({actionSchemas,...rest})=>rest)});
    } else {
      assert(!caller.permissions.has('memory.write'));
      const repairId=job.actionRepairs![0].id;
      await assert.rejects(call('review.finish',{report:'Premature'}),/待修正|撤回/);
      await assert.rejects(call('review.stageAction',{action:repaired}),/待修正提案/);
      await assert.rejects(call('review.stageAction',{repairId,action:{...repaired,operation:'forget'}}),/保留原操作/);
      await assert.rejects(call('review.checkpoint',{packetIndex:0,candidates:[]}),/断点/);
      await call('review.stageAction',mode==='withdraw'?{repairId,withdrawReason:'Insufficient evidence'}:{repairId,action:repaired});
      await call('review.finish',{report:'Reconciled'});
    }
    return {text:'Done'};
  };
  const job = await app.reviews.start('fixture','fixture-key',undefined,undefined,
    [{id:'fixture-source',personaId:'fixture',text:'x'.repeat(8200),timestamp:new Date().toISOString()}]);
  await until(()=>jobNow().state === 'paused' && external===1);
  const stored = jobNow();
  assert.equal(stored.agentFinished,true);
  assert.equal(stored.failureCode,'review_invalid_action');
  const memories=app.store.documents('memories');
  assert.equal(memories.length,6);
  const legacyError=JSON.stringify([{code:'unrecognized_keys',keys:['mood'],path:[],message:'Unknown key'}]);
  app.store.put('review-jobs',job.id,{...stored,failureCode:undefined,error:legacyError});
  await app.registry.call('review.resume',{id:job.id,confirmed:true,expectedProfileId:'test'},internal);
  await until(()=>jobNow().state==='completed' && external===2);
  assert.equal(workerTurns,2);
  assert.equal(reads,5);
  assert.deepEqual(app.store.documents('memories'),memories);
  assert.equal(app.store.document<any>('reflections',original.id).version,original.version+(mode==='correct'?1:0));
  const history = await app.registry.call('automation.history',{type:'review.policies',id:'fixture-review',personaId:'fixture'},internal);
  const completed=history.results.find((result:any)=>result.executionState==='succeeded');
  assert.deepEqual(completed.outputs.flatMap((o:any)=>o.deliveries.filter((r:any)=>r.state==='delivered').map((r:any)=>r.targetId)).sort(),
    ['core.chat',mobile].sort());
});
