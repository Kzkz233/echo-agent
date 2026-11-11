/** Synthetic, offline UI acceptance. Never connects to a configured model or user data. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { seedProfile } from './inference-fixture.ts';
import { FakeBackend } from '../tests/helpers.ts';
import { starterCharacters } from '../apps/server/starter-content.ts';

const project = resolve(import.meta.dirname, '..');
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'starter-writing-'));
const app = await Application.create({ project, runtime });
seedProfile(
  app,
  profileSchema.parse({
    id: 'demo-model',
    name: 'Synthetic model',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'example-model',
    vision: true,
  }),
);
const backend = new FakeBackend();
app.router.backends.set('api', backend);
const server = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const resultDirectory = join(project, 'test-results');
await mkdir(resultDirectory, { recursive: true });
const url = `http://127.0.0.1:${server.port}/?page=personas#token=${server.token}`;
try {
  await page.goto(url);
  await page.getByRole('button', { name: '查看示例', exact: true }).click();
  for (const role of starterCharacters)
    await page.getByText(role.description, { exact: true }).waitFor();
  await page.getByLabel('语言与视觉模型', { exact: true }).selectOption('demo-model');
  await page.getByRole('button', { name: '创建两个角色及群聊', exact: true }).click();
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  assert.equal(
    await page.getByLabel('角色人设', { exact: true }).inputValue(),
    starterCharacters[0].prompt,
  );
  await page.getByRole('button', { name: '通道与表达', exact: true }).click();
  for (const [key, label] of [
    ['chat', '应用对话风格'],
    ['external', 'QQ 回复风格'],
    ['bubble', '桌宠气泡风格'],
  ] as const)
    assert.equal(
      await page.getByLabel(label, { exact: true }).inputValue(),
      starterCharacters[0].expression[key],
    );
  assert.equal(
    await page.getByRole('textbox', { name: /通知.*回复风格/ }).inputValue(),
    starterCharacters[0].expression.channels['notifications.inbox'],
  );
  await page.screenshot({ path: join(resultDirectory, 'starter-channel-writing.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  // Older examples can refresh writing without choosing/replacing a model.
  app.store.set('starter.studio.v1', {
    ...app.store.get<any>('starter.studio.v1', {}),
    version: '2.0.1',
  });
  const role = app.store.document<any>('personas', 'example-hina')!;
  app.store.put('personas', role.id, { ...role, prompt: 'Synthetic retained custom persona' });
  await page.goto(url);
  await page.reload();
  await page.getByRole('button', { name: '查看示例', exact: true }).click();
  assert.equal(await page.getByLabel('语言与视觉模型', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '更新示例文案', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await page
    .getByRole('button', { name: '更新示例文案', exact: true })
    .waitFor({ state: 'detached' });
  const saved = (await app.registry.call(
    'persona.character.read',
    { id: 'example-hina' },
    internal,
  )) as any;
  assert.equal(saved.persona.prompt, 'Synthetic retained custom persona');
  assert.equal(saved.profileId, 'demo-model');
  assert.equal(backend.calls.length, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(resultDirectory, 'starter-writing-updated.png') });
  const report = {
    characterCreation: true,
    fourEditableChannelStyles: true,
    refreshWithoutModelChange: true,
    localEditsPreserved: true,
    pageErrors: 0,
    inferenceCalls: 0,
  };
  await writeFile(
    join(resultDirectory, 'starter-writing-ui.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: join(resultDirectory, 'starter-writing-failed.png') });
  throw error;
} finally {
  await browser.close();
  await server.close();
  await app.close();
}
