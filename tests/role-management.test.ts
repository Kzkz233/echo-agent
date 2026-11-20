import test from 'node:test';
import assert from 'node:assert/strict';
import { Application } from '../apps/server/application.ts';
import { project, temporary, setup, FakeBackend } from './helpers.ts';
import { internal, type Caller } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { echoToolPermissions } from '../packages/kernel/tool-access.ts';

test('fresh setup provisions one text index; restarting respects a deliberate opt-out', async t => {
  const runtime = await temporary(t);
  const app = await Application.create({ runtime, project });
  try {
    assert.equal(app.store.get<any>('routes', {})['embeddings.encode'], 'echo-bge-small-zh');
    assert.equal(app.router.inference.models().filter(model=>model.embedding.enabled).length,1);
    assert(app.plugins.active.has('semantic'));
    await app.registry.call('plugins.enable',{id:'semantic',enabled:false},internal);
    app.store.set('routes', {});
  } finally { await app.close(); }
  const reopened = await Application.create({runtime,project});
  try {
    assert.deepEqual(reopened.store.get('routes',{}),{});
    assert(!reopened.plugins.active.has('semantic'));
  } finally { await reopened.close(); }
});

test('text-only starter preserves disabled plugins and application tool grants', async t => {
  const app=await setup(t,['persona','delegation','knowledge','memory']);
  app.router.backends.set('api',new FakeBackend());
  const model=app.router.inference.models().find(model=>model.id==='test')!;
  await app.router.inference.saveModel({...model,generation:{...model.generation,inputs:['text']}});
  const intent=[...app.plugins.active.keys()].sort();
  const grants=app.store.get('mcp.permissions',[]);
  const result=await app.registry.call('characters.examples.create',{profileId:'test',requestId:'text-only'},internal);
  assert.equal(result.roles.length,2);
  assert.deepEqual([...app.plugins.active.keys()].sort(),intent);
  assert.deepEqual(app.store.get('mcp.permissions',[]),grants);
  assert(!app.store.documents('groups').length);
  for(const role of result.roles) assert.equal(app.store.binding('main-'+role)?.profileId,'test');
});

test('role tools retain task fields, narrow grants, and freeze long-term identity proposals',async t=>{
  const app=await setup(t,['persona','delegation','memory','approvals','observation','browser-use']);
  app.router.backends.set('api',new FakeBackend());
  const personaId='reader',conversationId='main-reader',grants=['persona.read','persona.expression.write','persona.identity.propose','delegation.write','observation.task-edit'];
  await app.registry.call('persona.character.commit',{requestId:'reader-setup',draft:characterDraft.parse({
    persona:{id:personaId,name:'Reader',prompt:'Initial identity'},profileId:'test',
    features:['delegation','observation'],toolPermissions:grants,independentToolGrants:true,
    configurations:{delegation:{autonomous:true}}
  })},internal);
  const caller=():Caller=>({kind:'mcp',personaId,conversationId,permissions:echoToolPermissions(app.store,false,{personaId,conversationId},app.plugins.characterPermissions())});
  const call=(name:string,value:unknown)=>app.registry.call(name,value,caller());
  const manage=(settings:Record<string,unknown>,extra={})=>call('automation.manage',{
    action:'save',type:'delegation.automations',id:'reading',settings,...extra});
  await manage({name:'Reading',prompt:'Original',enabled:false,mode:'daily',hour:20,minute:17,outputTargets:[],report:false});
  const partial=await manage({prompt:'Two pages'});
  assert.equal(partial.saved.prompt,'Two pages');assert.equal(partial.saved.minute,17);assert.equal(partial.saved.hour,20);
  assert.equal(partial.saved.report,false);assert.deepEqual(partial.saved.outputTargets,[]);
  const legacy=await call('delegation.schedule',{id:'reading',prompt:'Another edit'});
  assert.equal(legacy.minute,17);assert.equal(legacy.report,false);
  await Promise.all([manage({hour:21}),manage({name:'Reading now'})]);
  await assert.rejects(manage({hour:19},{expected:{hour:20}}),/字段已变化/);
  const row=app.store.document<any>('agent-automations','reading');
  assert.equal(row.hour,21);assert.equal(row.name,'Reading now');
  const capability=await call('role.capabilities',{search:'browser-use'});
  assert.equal(capability.plugins.length,1);
  assert(capability.plugins[0].missing.length);assert(capability.plugins[0].tools.every((x:any)=>!x.granted));
  await app.automation.mutate('observation.tasks',{action:'save',id:'screen',settings:{personaId,conversationId,
    enabled:false,name:'Screen',allowlist:[]}},new AbortController().signal);
  const observe=(settings:Record<string,unknown>)=>call('automation.manage',{action:'save',type:'observation.tasks',id:'screen',settings});
  assert.equal((await observe({minBubbleSeconds:400})).saved.minBubbleSeconds,400);
  await assert.rejects(observe({allowlist:[]}),/任务页面/);
  await call('persona.expression',{channel:'external',text:'Keep it brief.'});
  assert.equal(app.store.document<any>('personas',personaId).expression.external,'Keep it brief.');
  const propose=async (after:string)=>call('persona.proposeIdentity',{text:after});
  const decide=(id:string,decision:string)=>app.registry.call('approvals.decide',{id,revision:1,decision,confirmed:true},{kind:'ui',permissions:new Set(['approvals.decide'])});
  const first=await propose('Revised identity');
  assert.equal(app.store.document<any>('personas',personaId).prompt,'Initial identity');
  await decide(first.id,'reject');
  const second=await propose('Accepted identity');assert.equal((await decide(second.id,'approve')).state,'succeeded');
  assert.equal(app.store.document<any>('personas',personaId).prompt,'Accepted identity');
  const third=await propose('Revoked identity');
  const role=app.store.document<any>('characters',personaId);
  app.store.put('characters',personaId,{...role,toolPermissions:['persona.read']});
  assert.equal((await decide(third.id,'approve')).state,'failed');
  await assert.rejects(call('persona.expression',{channel:'external',text:'Denied'}),/权限/);
  assert.equal(app.store.document<any>('personas',personaId).prompt,'Accepted identity');
});
