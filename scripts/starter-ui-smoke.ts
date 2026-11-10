import { version } from '../packages/contracts/version.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile } from './inference-fixture.ts';
import { FakeBackend } from '../tests/helpers.ts';

const project = resolve(import.meta.dirname, '..'),
  base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'starter-ui-'));
const app = await Application.create({ project, runtime });
seedProfile(
  app,
  profileSchema.parse({
    id: 'demo-model',
    name: 'My language model',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'example-model',
    vision: true,
  }),
);
const backend = new FakeBackend();
app.router.backends.set('api', backend);
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
await mkdir(join(project, 'test-results'), { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${http.port}/?page=personas#token=${http.token}`);
  await page.getByRole('button', { name: '查看示例', exact: true }).click();
  await page.getByLabel('语言与视觉模型', { exact: true }).selectOption('demo-model');
  await page.screenshot({ path: join(project, 'docs/screenshots/starter-studio.png') });
  await page.getByRole('button', { name: '创建两个角色及群聊', exact: true }).click();
  await page.getByRole('button', { name: '停用角色', exact: true }).waitFor();
  await page.screenshot({ path: join(project, 'docs/screenshots/starter-character.png') });
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  assert((await page.getByLabel('角色人设', { exact: true }).inputValue()).length > 1000);
  await page.getByRole('button', { name: '通道与表达', exact: true }).click();
  assert((await page.getByLabel('QQ 回复风格', { exact: true }).inputValue()).length > 100);
  await page.getByRole('button', { name: '工具与委派', exact: true }).click();
  const delegation = page.locator('[data-role-feature="delegation"]');
  await delegation.getByRole('button', { name: '添加目录', exact: true }).click();
  await delegation.getByRole('button', { name: '移除目录', exact: true }).last().click();
  assert.equal(
    await delegation.getByRole('button', { name: '添加执行配置', exact: true }).count(),
    0,
  );
  await delegation.getByText('子任务可访问的目录', { exact: true }).waitFor();
  const approvals = delegation.getByLabel('操作审批', { exact: true });
  assert.deepEqual(await approvals.locator('option').allTextContents(), [
    '未选择',
    '逐次确认',
    '不允许',
  ]);
  assert.equal(await page.getByRole('button', { name: '添加 Worker', exact: true }).count(), 0);
  await page.screenshot({ path: join(project, 'test-results/subtask-authorization-settings.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '停用角色', exact: true }).click();
  await page.getByRole('button', { name: '启用角色', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '聊天消息' }).isDisabled(), true);
  await page.screenshot({ path: join(project, 'docs/screenshots/character-paused.png') });
  await page.goto(`http://127.0.0.1:${http.port}/?persona=example-hina#token=${http.token}`);
  await page.getByRole('button', { name: '启用角色', exact: true }).waitFor();
  await page.getByRole('button', { name: '启用角色', exact: true }).click();
  await page.getByRole('button', { name: '停用角色', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '聊天消息' }).isDisabled(), false);
  await page.getByRole('button', { name: '双人工作室', exact: true }).click();
  await page.getByText('请谁回应', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Hina', exact: true }).count(), 1);
  assert.equal(await page.getByRole('checkbox', { name: 'Miyu', exact: true }).count(), 1);
  assert.equal(backend.calls.length, 0);
  assert.deepEqual(errors, []);
  const result = {
    version,
    examplesCreated: true,
    roleTogglePersists: true,
    composerGated: true,
    groupMembers: true,
    fullPromptFields: true,
    subtaskAuthorization: true,
    inferenceCalls: 0,
    pageErrors: 0,
  };
  await writeFile(join(project, 'test-results/starter-ui.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: join(project, 'test-results/starter-ui-failed.png') });
  console.log((await page.locator('body').innerText()).slice(-3500));
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
