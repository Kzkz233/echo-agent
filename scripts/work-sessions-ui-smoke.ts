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

const project = resolve(import.meta.dirname, '..'), base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'work-sessions-ui-'));
const app = await Application.create({ runtime, project });
await app.plugins.enable('scheduler');
await app.plugins.enable('mail');
app.store.put('mail-accounts', 'fixture-mail', { id: 'fixture-mail', name: 'Fixture mailbox' });
seedProfile(app, profileSchema.parse({ id: 'fixture', name: 'Fixture model', kind: 'api',
  endpoint: 'http://127.0.0.1:1/v1', model: 'fixture', maxOutputTokens: 32768 }));
app.router.backends.set('api', { kind: 'api', generate: async () => ({ text: 'SYNTHETIC_WORK_RESULT' }) });
const role = await app.registry.call('persona.character.commit', { requestId: 'fixture', draft: characterDraft.parse({
  persona: { id: 'fixture', name: 'Fixture role', prompt: 'Synthetic persona' }, profileId: 'fixture',
  features: ['memory', 'review', 'delegation', 'mail'], independentToolGrants: true,
  toolPermissions: ['memory.read', 'memory.write', 'delegation.read', 'delegation.write'],
  configurations: { delegation: { authorizationVersion: 3, toolPermissions: ['memory.read'], reportOnCompletion: false } },
  tasks: [{ id: 'fixture-task', type: 'delegation.automations', settings: { name: 'Fixture scheduled work',
    prompt: 'Inspect the synthetic fixture.', enabled: true, mode: 'interval', minutes: 60, report: false, execution: {} } }],
}) }, internal);
await app.registry.call('automation.run', { type: 'delegation.automations', id: 'fixture-task', requestId: 'run-fixture' }, internal);
await app.registry.call('automation.save', { type: 'review.policies', id: 'fixture-review', settings: {
  personaId: 'fixture', name: 'Fixture memory review', enabled: false, report: false, sourceIds: [], targetIds: [],
} }, internal);
app.store.put('review-jobs', 'fixture-review-job', { id: 'fixture-review-job', personaId: 'fixture',
  policy: { id: 'fixture-review' }, state: 'completed', createdAt: new Date().toISOString(),
  materials: [], packets: [], nextPacket: 0, totalPackets: 0, drafts: [], notes: '',
  checkpointFlow: { startPacket: 0 }, applied: true });
for (let i = 0; i < 13; i++) app.store.put('review-candidates.fixture-review-job', 'candidate-' + String(i).padStart(2, '0'), {
  id: 'candidate-' + String(i).padStart(2, '0'), jobId: 'fixture-review-job', packetIndex: 0,
  title: 'Fixture candidate ' + i, text: 'Synthetic narrative '.repeat(40) + 'FULL_CANDIDATE_END',
  sources: ['fixture-source'], state: 'unchanged', reason: 'Already recorded.' });
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${http.port}/?persona=fixture#token=${http.token}`);
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page.getByRole('button', { name: '模型与权限', exact: true }).click();
  await page.getByText('上下文设置', { exact: true }).click();
  await page.getByRole('checkbox', { name: '角色人设', exact: true }).waitFor();
  assert(await page.getByRole('checkbox', { name: '角色人设', exact: true }).isChecked());
  assert(await page.getByRole('checkbox', { name: '核心记忆', exact: true }).isChecked());
  assert(!await page.getByRole('checkbox', { name: '记忆召回', exact: true }).isChecked());
  await page.locator('.role-editor-nav').getByRole('button', { name: '自动化任务', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.locator('.task-type-picker').waitFor();
  const taskTypes = await page.locator('.task-type-picker strong').allTextContents();
  assert(taskTypes.includes('记忆整理'));
  assert(!taskTypes.includes('邮件同步'));
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByText('执行设置', { exact: true }).click();
  await page.getByRole('combobox', { name: '子任务执行器', exact: true }).waitFor();
  await page.getByText('上下文设置', { exact: true }).click();
  await page.getByLabel('单次模型输出上限（tokens）', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('单次模型输出上限（tokens）', { exact: true }).inputValue(), '');
  const report = page.getByRole('checkbox', { name: '结果汇报', exact: true });
  assert(!await report.isChecked());
  assert.equal(await page.getByLabel('汇报要求', { exact: true }).count(), 0);
  await report.check();
  await page.getByLabel('汇报要求', { exact: true }).waitFor();
  await report.uncheck();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    console.log((await dialog.innerText()).slice(0, 1200));
    await dialog.getByRole('button', { name: /放弃|不保存|离开/ }).click();
  }
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('button', { name: /Fixture scheduled work.*持续任务/ }).click();
  await page.getByText('执行设置由来源任务管理。', { exact: true }).waitFor();
  await page.getByText('SYNTHETIC_WORK_RESULT', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '来源自动化任务', exact: true }).count(), 1);
  const worker = app.router.workSessions.list('fixture')[0];
  await assert.rejects(app.registry.call('conversations.update', { id: worker.conversationId,
    title: 'Attempted config edit', reasoning: 'low' }, internal), /来源自动化任务/);
  await page.getByRole('tab', { name: '自动化', exact: true }).click();
  await page.getByRole('button', { name: /Fixture memory review/ }).click();
  await page.getByText('候选记忆', { exact: true }).click();
  await page.getByText('Fixture candidate 0', { exact: true }).waitFor();
  assert.equal(await page.getByText('FULL_CANDIDATE_END', { exact: false }).count(), 0);
  await page.getByRole('button', { name: '查看完整内容', exact: true }).first().click();
  await page.getByText('FULL_CANDIDATE_END', { exact: false }).waitFor();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('Fixture candidate 12', { exact: true }).waitFor();
  await mkdir(join(project, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(project, 'test-results/work-sessions-ui.png') });
  assert.deepEqual(errors, []);
  assert.equal(app.store.conversation(role.mainConversationId)?.kind, 'main');
  console.log('Work-session UI passed: registered context, source-owned work, paged Review candidates and complete narrative reads.');
} catch (error) {
  console.log((await page.locator('body').innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close(); await http.close(); await app.close();
  assert(resolve(runtime).startsWith(resolve(base) + sep));
  await rm(runtime, { recursive: true, force: true });
  await rm(runtime + '-workspaces', { recursive: true, force: true });
}
