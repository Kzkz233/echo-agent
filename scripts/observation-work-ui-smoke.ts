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
import { inferenceTasks } from '../packages/contracts/inference.ts';
import { profileSchema } from '../packages/contracts/index.ts';

const project = resolve(import.meta.dirname, '..'), base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'observation-work-ui-'));
const app = await Application.create({ runtime, project });
seedProfile(app, profileSchema.parse({ id: 'fixture', name: 'Fixture model', kind: 'api', vision: true,
  endpoint: 'http://127.0.0.1:1/v1', model: 'fixture', maxOutputTokens: 32768, modelOptions: { contextWindowTokens: 262144 } }));
app.router.backends.set('api', { kind: 'api', generate: async () => ({ text: 'SYNTHETIC_VISION_ACTIVITY',
  usage: { prompt_tokens: 1500, completion_tokens: 50, cached_tokens: 1200 } }) });
const role = await app.registry.call('persona.character.commit', { requestId: 'fixture', draft: characterDraft.parse({
  persona: { id: 'fixture', name: 'Fixture role', prompt: 'Synthetic persona' }, profileId: 'fixture',
  features: ['memory', 'review', 'delegation', 'observation'], independentToolGrants: true,
  toolPermissions: ['memory.read', 'delegation.read'],
  tasks: [{ id: 'fixture-screen', type: 'observation.tasks', settings: { name: 'Fixture visual work', enabled: false,
    frameCount: 1, visionProfileId: 'fixture', report: false } }],
}) }, internal);
const work = app.router.workSessions.list('fixture').find(work => work.origin.id === 'fixture-screen')!;
assert(work);
assert.equal(work.profileId, 'fixture');

const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${http.port}/?persona=fixture#token=${http.token}`);
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '非活跃', exact: true }).click();
  const rows = page.getByRole('button', { name: /Fixture visual work.*持续任务/ });
  assert.equal(await rows.count(), 1); // No synthetic duplicate "background" row.
  await rows.click();
  await page.getByText('等待任务执行', { exact: true }).waitFor();
  assert.match(await page.locator('.chat-title-main').innerText(), /Fixture model/);
  await app.router.workSessions.infer({ id: work.id, task: inferenceTasks.vision, requestId: 'fixture-vision', profileId: 'fixture',
    messages: [{ role: 'system', text: 'Synthetic instructions' }, { role: 'user', text: 'Synthetic frame metadata' }] }, new AbortController().signal);
  await page.getByText('SYNTHETIC_VISION_ACTIVITY', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '聊天消息' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '来源自动化任务', exact: true }).count(), 1);
  await page.getByRole('button', { name: '查看上下文明细', exact: true }).click();
  const inspector = page.getByRole('region', { name: '上下文用量', exact: true });
  assert.match(await inspector.innerText(), /1\.5K \/ 262\.1K/);
  await inspector.getByText('固定前缀', { exact: true }).click();
  await inspector.getByText('任务指引', { exact: true }).waitFor();
  await inspector.getByText('本次执行累计用量', { exact: true }).click();
  await inspector.getByText('缓存读取', { exact: true }).waitFor();
  const bounds = await inspector.boundingBox();
  assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 1050);
  assert.match(await inspector.innerText(), /1\.2K/);
  assert.match(await page.locator('.conversation-status').innerText(), /缓存命中 80%/);
  await mkdir(join(project, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(project, 'test-results/observation-work-ui.png') });
  assert.deepEqual(errors, []);
  assert.equal(app.store.conversation(role.mainConversationId)?.kind, 'main');
  console.log('Observe work UI passed: one real child session, source-owned settings, read-only API history, shared nested context and cumulative usage.');
} catch (error) {
  console.log((await page.locator('body').innerText()).slice(-2000)); throw error;
} finally {
  await browser.close(); await http.close(); await app.close();
  assert(resolve(runtime).startsWith(resolve(base) + sep));
  await rm(runtime, { recursive: true, force: true });
  await rm(runtime + '-workspaces', { recursive: true, force: true });
}
