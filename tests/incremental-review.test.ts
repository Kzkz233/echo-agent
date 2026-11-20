import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';

test('maintenance search is bounded, uses registered retrieval, reads complete versions and never widens a role', async t => {
  const app = await setup(t);
  const chat = conversation(app);
  // Large synthetic corpus without filesystem or real embedding/model work.
  app.store.transaction(() => { for (let i = 0; i < 10000; i++) app.store.put('memories', 'm' + String(i).padStart(5, '0'), {
    id: 'm' + String(i).padStart(5, '0'), personaId: 'companion', title: 'orchid ' + i,
    text: 'orchid '.repeat(100), tags: ['garden'], core: false, sources: [], version: 'v1', updatedAt: new Date().toISOString(),
  }); });
  app.store.put('memories', 'foreign', { id: 'foreign', personaId: 'other', title: 'orchid', text: 'FOREIGN', version: 'v1', tags: [], core: false });
  app.store.set('memory.config', { retrievalMethod: 'knowledge.keyword' });
  const caller = { kind: 'mcp' as const, conversationId: chat.id, personaId: chat.personaId,
    permissions: new Set(['memory.read', 'memory.write']) };
  const list = await app.registry.call('memory.list', {}, caller) as any[];
  assert.equal(list.length, 20); assert(!('text' in list[0]));
  const result = await app.registry.call('memory.search', { query: 'orchid', limit: 7 }, caller) as any;
  assert.equal(result.items.length, 7); assert(result.hasMore); assert(!JSON.stringify(result).includes('FOREIGN'));
  assert(JSON.stringify(result).length < 10000);
  app.store.append(chat.id, 'system', 'import', 'already seen', undefined, { memoryVersion: 'm00000:v1' });
  assert((await app.registry.call('memory.search', { query: 'orchid' }, caller) as any).items.some((row: any) => row.id === 'm00000'));
  app.store.put('work-authorities', chat.id, { active: true, owner: 'review', memoryReadRequired: true,
    memoryOperations: ['update'], allowedSources: ['source'], permissions: ['memory.read', 'memory.write'] });
  const change = { requestId: 'change', change: { operation: 'update', subjectId: 'm00000', expectedVersion: 'v1',
    title: 'orchid', text: 'Updated', tags: ['garden', 'confirmed'], occurredAt: '2026-11-01', sources: ['source'] } };
  await assert.rejects(app.registry.call('memory.change', change, caller), /完整阅读/);
  const first = await app.registry.call('memory.read', { id: 'm00000', maxChars: 100 }, caller) as any;
  assert(first.hasMore);
  await assert.rejects(app.registry.call('memory.change', change, caller), /完整阅读/);
  await app.registry.call('memory.read', { id: 'm00000', version: first.version, offset: first.nextOffset, maxChars: 12000 }, caller);
  await app.registry.call('memory.change', change, caller);
  assert.deepEqual(app.store.document<any>('memories', 'm00000')!.tags, ['garden', 'confirmed']);
  assert.equal(app.store.document<any>('memories', 'm00000')!.occurredAt, '2026-11-01');
  await assert.rejects(app.registry.call('memory.read', { id: 'm00000', version: 'v1', offset: 100 }, caller), /版本/);
  await assert.rejects(app.registry.call('memory.read', { id: 'foreign' }, caller), /不属于/);
});

test('memory maintenance advances only after success, covers batches, and leaves existing task settings untouched', async t => {
  const app = await setup(t), fake = new FakeBackend(); app.router.backends.set('api', fake);
  const parent = conversation(app, { kind: 'main' });
  app.store.saveConversation({ ...parent, review: false });
  for (let i = 0; i < 3; i++) await app.memories.save({ id: 'batch-' + i, personaId: parent.personaId,
    title: 'Fixture ' + i, text: 'Original narrative ' + i, core: false, tags: ['original'], sources: ['original-source'] });
  await app.registry.call('automation.save', { type: 'review.policies', id: 'maintenance', settings: {
    personaId: parent.personaId, scope: 'maintenance', maintenanceBatchSize: 2, enabled: false,
    report: false, autoApply: false, memoryOperations: [], sourceIds: [], targetIds: [],
  } }, internal);
  const tasks = app.store.get('review.tasks', []);
  const original = app.store.documents('memories');
  let fail = true;
  fake.responder = async request => {
    if (fail) throw Error('上下文压缩失败：ECONNRESET');
    const job = app.reviews.jobs().find(row => row.state === 'running')!;
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: new Set(['review.read', 'review.write']) };
    for (let i = 0; i < job.packets.length; i++) {
      await app.registry.call('review.readMaterial', { jobId: job.id }, caller);
      await app.registry.call('review.checkpoint', { jobId: job.id, packetIndex: i, candidates: [] }, caller);
    }
    await app.registry.call('review.finish', { jobId: job.id, report: 'Checked without changes.' }, caller);
    return { text: 'Done' };
  };
  const first = await app.reviews.start(parent.personaId, 'first');
  await until(() => app.reviews.jobs().find(row => row.id === first.id)?.state === 'paused');
  assert.equal(app.store.get('review.maintenanceCursor.maintenance', ''), '');
  const type = (await app.automation.catalog(new AbortController().signal,'definition','review.policies')).types[0]!;
  assert.equal(type.failuresOperation, 'review.failures');
  const failures = () => app.registry.call(type.failuresOperation!, {taskId:'maintenance',personaId:parent.personaId},internal) as Promise<any[]>;
  const [record] = await failures();
  assert.equal(record.id,first.id);
  assert.equal(record.failure.stage,'compaction');
  assert.equal(record.failure.category,'network');
  assert.equal(record.checkpoint.completed,0);
  assert.deepEqual(await app.registry.call(type.failuresOperation!,{taskId:'other'},internal),[]);
  assert.deepEqual(await app.registry.call(type.failuresOperation!,{taskId:'maintenance',personaId:'other'},internal),[]);
  const resume = (expectedProfileId:string) => app.registry.call(record.checkpoint.resumeOperation,
    {id:record.id,confirmed:true,expectedProfileId},internal);
  await assert.rejects(resume('changed-model'),/续跑模型已改变/);
  fail = false;
  await resume(record.checkpoint.expectedProfileId);
  await until(() => app.reviews.jobs().find(row => row.id === first.id)?.state === 'completed');
  assert.deepEqual(await failures(),[]);
  assert.equal(app.store.get('review.maintenanceCursor.maintenance', ''), 'batch-1');
  const next = await app.reviews.start(parent.personaId, 'second');
  await until(() => app.reviews.jobs().find(row => row.id === next.id)?.state === 'completed');
  assert.equal(next.materials.length, 1); assert(next.materials[0].id.startsWith('memory:batch-2:'));
  assert.deepEqual(app.store.get('review.tasks', []), tasks);
  assert.deepEqual(app.store.documents('memories'), original);
});

test('Review checkpoints survive a failed attempt, preserve candidate evidence and require confirmed writes before resolution', async t => {
  const app = await setup(t), fake = new FakeBackend(); app.router.backends.set('api', fake);
  seedProfile(app, profileSchema.parse({ id: 'next-model', name: 'Next model', kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1', model: 'synthetic-next' }));
  const role = await app.registry.call('persona.character.commit', { requestId: 'role', draft: characterDraft.parse({
    persona: { id: 'fixture-role', name: 'Fixture', prompt: 'ROLE' }, profileId: 'test', reasoning: 'off', features: ['memory', 'review'],
  }) }, internal);
  app.store.append(role.mainConversationId, 'user', 'human', 'ORIGINAL_SOURCE '.repeat(800));
  await app.registry.call('automation.save', { type: 'review.policies', id: 'review-fixture', settings: {
    personaId: 'fixture-role', enabled: false, report: false, autoApply: true, memoryOperations: ['add'],
    conversationScope: 'selected', conversationIds: [role.mainConversationId], sourceIds: [], targetIds: [],
  } }, internal);
  let attempt = 0, candidateId = '';
  fake.responder = async request => {
    const job = app.reviews.jobs().find(job => job.state === 'running')!;
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: new Set(['review.read', 'review.write', 'memory.read', 'memory.write']) };
    const call = (name: string, args: any) => app.registry.call(name, args, caller) as Promise<any>;
    const firstAttempt = attempt++ === 0;
    assert.equal(request.profile.id, firstAttempt ? 'test' : 'next-model');
    assert.equal(request.reasoning, 'inherit');
    if (firstAttempt) {
      const packet = await call('review.readMaterial', { jobId: job.id });
      await assert.rejects(call('review.readMaterial', { jobId: job.id }), /检查点/);
      const saved = await call('review.checkpoint', { jobId: job.id, packetIndex: packet.index,
        candidates: [{ title: 'Durable candidate', text: 'KEEP_NARRATIVE', sources: packet.sources }] });
      candidateId = saved.candidateIds[0];
      await assert.rejects(call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] }), /检查点已保存/);
      throw Error('Synthetic provider failure');
    }
    while (app.reviews.jobs().find(row => row.id === job.id)!.nextPacket < job.packets.length) {
      const packet = await call('review.readMaterial', { jobId: job.id });
      await call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] });
    }
    const candidates = await call('review.candidates', { jobId: job.id });
    assert.equal(candidates.total, 1); assert.equal(candidates.items[0].id, candidateId);
    const full = await call('review.readCandidate', { jobId: job.id, id: candidateId });
    assert.equal(full.text, 'KEEP_NARRATIVE');
    await assert.rejects(call('review.finish', { jobId: job.id, report: 'Done' }), /未处理候选/);
    await assert.rejects(call('review.resolveCandidate', { jobId: job.id, id: candidateId, state: 'changed', reason: 'Saved', receipts: ['nonexistent'] }), /回执/);
    assert.equal(candidates.mode,'apply');
    assert(!app.registry.list(caller,true).some(op=>op.name==='review.stageChange'));
    await assert.rejects(call('review.stageChange',{jobId:job.id,change:{operation:'add',title:full.title,text:full.text,sources:full.sources}}),/memory_change/);
    await call('memory.change', { requestId: 'candidate-save', change: { operation: 'add', title: full.title, text: full.text, sources: full.sources } });
    await call('review.resolveCandidate', { jobId: job.id, id: candidateId, state: 'changed', reason: 'Saved', receipts: ['candidate-save'] });
    await call('review.finish', { jobId: job.id, report: 'Saved one memory', notes: 'Complete' });
    return { text: 'Done' };
  };
  const job = await app.reviews.start('fixture-role', 'checkpoint-fixture');
  await until(() => app.reviews.jobs().find(row => row.id === job.id)?.state === 'paused');
  assert.equal(app.store.documents('review-candidates.' + job.id).length, 1);
  assert(!app.store.allMessages(app.reviews.jobs().find(row => row.id === job.id)!.workerConversationId!).some(row => row.meta.reviewPacket !== undefined));
  await app.router.bind(role.mainConversationId, 'next-model', new AbortController().signal);
  const listing = await app.registry.call('review.list', {}, internal) as any[];
  assert.deepEqual(listing.find(row => row.id === job.id).resumeModel, {
    profileId: 'next-model', model: 'synthetic-next', source: 'main',
  });
  await assert.rejects(app.registry.call('review.resume', { id: job.id, confirmed: true, expectedProfileId: 'test' }, internal), /续跑模型已改变/);
  await app.registry.call('review.resume', { id: job.id, confirmed: true, expectedProfileId: 'next-model' }, internal);
  await until(() => ['paused', 'completed'].includes(app.reviews.jobs().find(row => row.id === job.id)!.state));
  const done = app.reviews.jobs().find(row => row.id === job.id)!;
  assert.equal(done.state, 'completed', done.error ?? 'Review failed');
  const attempts = app.store.runs().filter(run => run.conversationId === done.workerConversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  assert.deepEqual(attempts.map(run => run.meta.taskModel), [
    { profileId: 'test', model: 'synthetic', source: 'main' },
    { profileId: 'next-model', model: 'synthetic-next', source: 'main' },
  ]);
  assert.equal(app.store.documents<any>('memories').filter(row => row.text === 'KEEP_NARRATIVE').length, 1);
});

test('Review resumes a saved finish receipt without submitting another worker request', async t => {
  const app = await setup(t);
  const fake = new FakeBackend();
  app.router.backends.set('api', fake);
  const parent = conversation(app, { kind: 'main' });
  app.store.append(parent.id, 'user', 'human', 'Synthetic material.');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'saved-finish', settings: {
    personaId: parent.personaId, enabled: false, report: false, autoApply: false, memoryOperations: [],
    conversationScope: 'selected', conversationIds: [parent.id], sourceIds: [], targetIds: [],
  } }, internal);
  let requests = 0;
  fake.responder = async () => { requests++; throw Error('Unexpected model request'); };
  const started = await app.reviews.start(parent.personaId, 'saved-finish-run');
  await until(() => app.reviews.jobs().find(job => job.id === started.id)?.state === 'paused');
  const paused = app.reviews.jobs().find(job => job.id === started.id)!;
  for (const index of paused.packets.keys())
    app.store.put('review-checkpoints', JSON.stringify([paused.id, index]), { fingerprint: 'fixture', ids: [] });
  app.store.put('review-jobs', paused.id, { ...paused, agentFinished: true, nextPacket: paused.packets.length,
    report: 'No changes.', notes: 'Preserved finish receipt.' });
  await app.registry.call('review.resume', { id: paused.id, confirmed: true }, internal);
  await until(() => app.reviews.jobs().find(job => job.id === paused.id)?.state === 'completed');
  assert.equal(requests, 1);
  assert.equal(app.reviews.jobs().find(job => job.id === paused.id)?.notes, 'Preserved finish receipt.');
});

test('proposal-only review can finish with verified drafts before the user applies them', async t => {
  const app = await setup(t), fake = new FakeBackend();
  app.router.backends.set('api',fake);
  const parent=conversation(app,{kind:'main'});
  app.store.append(parent.id,'user','human','Fixture material.');
  await app.registry.call('automation.save',{type:'review.policies',id:'propose-test',settings:{
    personaId:parent.personaId,enabled:false,report:false,autoApply:false,memoryOperations:['add'],
    conversationScope:'selected',conversationIds:[parent.id],sourceIds:[],targetIds:[],
  }},internal);
  let proposalId='';
  fake.responder=async request=>{
    const job=app.reviews.jobs().find(j=>j.state==='running')!;
    const caller={kind:'mcp' as const,...request.principal!,permissions:new Set(['memory.read','review.read','review.write'])};
    const call=(name:string,args:any)=>app.registry.call(name,{jobId:job.id,...args},caller);
    assert(app.registry.list(caller,true).some(op=>op.name==='review.stageChange'));
    const p=await call('review.readMaterial',{});
    const draft={operation:'add',title:'Draft',text:'Draft content',sources:p.sources};
    const {candidateIds:[cid]}=await call('review.checkpoint',{packetIndex:p.index,candidates:[draft]});
    assert.equal((await call('review.candidates',{})).mode,'propose');
    const staged=await call('review.stageChange',{change:draft}); proposalId=staged.proposalId;
    assert.deepEqual(await call('review.stageChange',{change:draft}),staged);
    assert.equal((await call('review.readCandidate',{id:cid})).stagedProposals[0].proposalId,proposalId);
    await assert.rejects(call('review.resolveCandidate',{id:cid,state:'staged',reason:'Awaiting user',receipts:['unknown']}),/回执/);
    await assert.rejects(call('review.resolveCandidate',{id:cid,state:'changed',reason:'Saved',receipts:[proposalId]}),/回执/);
    await call('review.resolveCandidate',{id:cid,state:'staged',reason:'Review requested',receipts:[proposalId]});
    await call('review.finish',{report:'One proposal'});
    return {text:'Finished'};
  };
  const job=await app.reviews.start(parent.personaId,'propose-fixture');
  await until(()=>app.reviews.jobs().find(j=>j.id===job.id)?.state==='completed');
  assert(proposalId);
  assert.equal(app.reviews.jobs().find(j=>j.id===job.id)!.drafts.length,1);
  assert.equal(app.reviews.jobs().find(j=>j.id===job.id)!.applied,false);
  assert.equal(app.store.documents('memories').length,0);
});
