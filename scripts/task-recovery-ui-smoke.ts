import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { deliveryPoint } from '../packages/contracts/delivery.ts';
import { latestDaily } from '../packages/kernel/schedule-policy.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { seedProfile } from './inference-fixture.ts';
import { profileSchema } from '../packages/contracts/index.ts';

const project = resolve(import.meta.dirname,'..');
const runtime = await mkdtemp(join(tmpdir(),'echo-checkpoint-ui-'));
const app = await Application.create({runtime, project});
app.clock.pause();
seedProfile(app,profileSchema.parse({id:'fixture', name:'Fixture service', model:'synthetic', kind:'api', endpoint:'http://127.0.0.1:1/v1'}));
let calls = 0, checks = 0, ready = false, deliveries = 0;
const reports: string[][] = [];
const destination = 'fixture.mobile';
app.capabilities.provide({
  id:'fixture', permissions:new Set(['outputs.provide']), signal:new AbortController().signal,
}, deliveryPoint, 'fixture.channels', 'Synthetic destinations', input => {
  if (input.action === 'list') return {targets:[{id:destination, label:'Fixture mobile', revision:'same-contact', ready}]};
  if (input.action === 'deliver') deliveries++;
  return {result:{state:'delivered'}};
});
app.router.backends.set('api', {kind:'api',
  checkConnection:async () => {checks++; return {ok:true,verified:'upstream'};},
  generate:async req => {
    if (req.replyTargets?.length) {
      reports.push(req.replyTargets);
      for (const targetId of req.replyTargets) req.respond!({targetId,phase:'final',messages:['Fixture report']});
      return {text:''};
    }
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
  tasks:[{id:'ui-review',type:'review.policies',settings:{name:'Fixture review',scope:'maintenance',mode:'daily',timezone:'Asia/Shanghai',enabled:true,report:true,outputTargets:['core.chat', destination],sourceIds:[],targetIds:[],memoryOperations:[]}}]
})},internal);
await app.memories.save({id:'sample',personaId:'fixture',title:'Fixture',text:'Synthetic memory',tags:[],core:false,sources:[]});
const due = latestDaily(Date.now() + 2 * 86400000, 7, 0, 'Asia/Shanghai');
app.store.set('review.nextSlot.ui-review', due);
await app.reviews.tick(new Date(due + 2 * 3600000));
const [job] = app.reviews.jobs();
assert(job, 'The overdue schedule must create its own Review');
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
  await expect.poll(() => reports.length).toBe(1);
  assert.deepEqual(reports[0],['core.chat']);
  ready=true;
  await card.getByRole('button',{name:'从断点续跑'}).click();
  await expect.poll(()=>app.reviews.jobs().find(j=>j.id===job.id)?.state).toBe('completed');
  await expect(card).toHaveCount(0);
  assert.equal(calls,count+1); assert.equal(app.reviews.jobs().length,1);
  const occurrence=page.locator('.task-run-history > details').filter({has:page.locator('summary').filter({hasText:'补跑'})});
  await expect(occurrence.locator(':scope > summary')).toContainText('已成功');
  await occurrence.locator(':scope > summary').click();
  await expect(occurrence.locator('details > summary').filter({hasText:'从断点续跑'})).toHaveCount(1);
  await expect(occurrence.locator('details > summary').filter({hasText:'已保存断点'})).toHaveCount(1);
  await expect(occurrence.locator(':scope > summary')).toContainText('已送达 2/2');
  assert.deepEqual(reports,[['core.chat'],['core.chat',destination]]);
  assert.equal(deliveries,1);
  assert.equal(job.delivery!.targets.find(target=>target.id===destination)?.ready,false);
  assert.deepEqual(errors,[]);
  console.log('Task detail diagnosed the failed attempt, checked only its catalog, resumed its original checkpoint and removed the recovery action after completion.');
} finally { await browser.close(); await http.close(); await app.close(); }
