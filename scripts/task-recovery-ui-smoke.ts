import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { seedProfile } from './inference-fixture.ts';
import { profileSchema } from '../packages/contracts/index.ts';

const project = resolve(import.meta.dirname,'..');
const runtime = await mkdtemp(join(tmpdir(),'echo-checkpoint-ui-'));
const app = await Application.create({runtime, project});
seedProfile(app,profileSchema.parse({id:'fixture', name:'Fixture service', model:'synthetic', kind:'api', endpoint:'http://127.0.0.1:1/v1'}));
let calls = 0, checks = 0, ready = false;
app.router.backends.set('api', {kind:'api',
  checkConnection:async () => {checks++; return {ok:true,verified:'upstream'};},
  generate:async req => {
    calls++;
    if (!ready) throw Error('上下文压缩失败：ECONNRESET');
    const job = app.reviews.jobs().find(job => job.state === 'running')!;
    const caller = {kind:'mcp' as const,...req.principal!,permissions:new Set(['review.read','review.write'])};
    for (let n=job.nextPacket; n<job.packets.length; n++) {
      await app.registry.call('review.readMaterial',{jobId:job.id},caller);
      await app.registry.call('review.checkpoint',{jobId:job.id,packetIndex:n,candidates:[]},caller);
    }
    await app.registry.call('review.finish',{jobId:job.id,report:'Fixture complete'},caller);
    return {text:'Done'};
  }
});
await app.registry.call('persona.character.commit', {requestId:'role',draft:characterDraft.parse({
  persona:{id:'fixture',name:'Fixture',prompt:'Synthetic role'},profileId:'fixture',features:['memory','review'],
  tasks:[{id:'ui-review',type:'review.policies',settings:{name:'Fixture review',scope:'maintenance',enabled:false,report:false,sourceIds:[],targetIds:[],memoryOperations:[]}}]
})},internal);
await app.memories.save({id:'sample',personaId:'fixture',title:'Fixture',text:'Synthetic memory',tags:[],core:false,sources:[]});
const job = await app.registry.call('review.start',{requestId:'review-ui',taskId:'ui-review',personaId:'fixture'},internal) as {id:string};
await expect.poll(() => app.reviews.jobs().find(j=>j.id===job.id)?.state).toBe('paused');
const http = await serve(app,{webRoot:join(project,'dist/web')});
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
  const page = await browser.newPage();
  const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+http.port+'/?workspace=true&page=automation#token='+http.token);
  await page.getByRole('button',{name:/Fixture review/}).click();
  const card = page.locator('article').filter({has:page.getByRole('button',{name:'从断点续跑'})});
  await expect(card.getByText('上下文压缩 · 网络连接中断')).toBeVisible();
  const count=calls;
  await card.getByRole('button',{name:'检查模型连接'}).click();
  await expect(card.getByRole('status')).toContainText('已连通模型目录');
  assert.equal(checks,1); assert.equal(calls,count);
  ready=true;
  await card.getByRole('button',{name:'从断点续跑'}).click();
  await expect.poll(()=>app.reviews.jobs().find(j=>j.id===job.id)?.state).toBe('completed');
  await expect(card).toHaveCount(0);
  assert.equal(calls,count+1); assert.equal(app.reviews.jobs().length,1);
  assert.deepEqual(errors,[]);
  console.log('Task detail diagnosed the failed attempt, checked only its catalog, resumed its original checkpoint and removed the recovery action after completion.');
} finally { await browser.close(); await http.close(); await app.close(); }
