import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { seedProfile } from './inference-fixture.ts';
import { profileSchema } from '../packages/contracts/index.ts';

const project=resolve(import.meta.dirname,'..'), base=join(tmpdir(),'EchoTests');
await mkdir(base,{recursive:true});
const runtime=await mkdtemp(join(base,'review-sources-ui-'));
const app=await Application.create({runtime,project});
seedProfile(app,profileSchema.parse({id:'fixture',name:'Fixture model',kind:'api',endpoint:'http://127.0.0.1:1/v1',model:'synthetic'}));
const role=await app.registry.call('persona.character.commit',{requestId:'fixture',draft:characterDraft.parse({
  persona:{id:'fixture',name:'Fixture role',prompt:'Synthetic persona'},profileId:'fixture',features:['memory','review'],
  tasks:[{id:'fixture-review',type:'review.policies',settings:{name:'Fixture review',enabled:false}}],
})},internal);
app.store.saveConversation({id:'legacy-selected',personaId:'fixture',title:'Legacy selected conversation',
  injection:false,review:true,createdAt:new Date().toISOString()});
const raw=app.store.get<any[]>('review.tasks',[]).map(task=>task.id==='fixture-review'?{...task,conversationScope:'marked'}:task);
app.store.set('review.tasks',raw);app.reviews.tasks();
const http=await serve(app,{webRoot:join(project,'dist/web')});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1050}});
page.setDefaultTimeout(12000);
const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${http.port}/?persona=fixture#token=${http.token}`);
  await page.getByRole('button',{name:'配置角色',exact:true}).click();
  await page.locator('.role-editor-nav').getByRole('button',{name:'自动化任务',exact:true}).click();
  const scope=page.getByLabel('会话材料范围',{exact:true});
  await scope.waitFor();
  assert.deepEqual(await scope.locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value)),['main','selected']);
  assert.equal(await scope.inputValue(),'selected');
  assert(await page.getByRole('checkbox',{name:'Legacy selected conversation',exact:true}).isChecked());
  assert.equal(await page.getByText('使用会话的纳入整理开关',{exact:true}).count(),0);
  await scope.selectOption('main');
  assert.equal(await page.getByRole('checkbox',{name:'Legacy selected conversation',exact:true}).count(),0);
  const before=app.store.get('review.tasks',[]);
  await page.reload(); // Discard an unsaved form change; stored selection must stay unchanged.
  assert.deepEqual(app.store.get('review.tasks',[]),before);
  await page.getByRole('tab',{name:'后台工作会话',exact:true}).click();
  await page.getByRole('button',{name:'会话状态与上下文',exact:true}).click();
  const inspector=page.locator('.conversation-inspector');
  await inspector.waitFor({state:'visible'});
  assert(!/纳入整理|未启用.*记忆整理/.test(await inspector.innerText()));
  assert.equal(await inspector.getByText('记忆整理',{exact:true}).count(),0);
  assert.equal(app.store.conversation(role.mainConversationId)?.kind,'main');
  assert.deepEqual(errors,[]);
  console.log('Review source UI passed: two task-owned choices, preserved migration selection, no conversation switch or stale status.');
} finally {
  await browser.close();await http.close();await app.close();
  assert(resolve(runtime).startsWith(resolve(base)+sep));
  await rm(runtime,{recursive:true,force:true});await rm(runtime+'-workspaces',{recursive:true,force:true});
}
