import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile } from './inference-fixture.ts';
import { FakeBackend } from '../tests/helpers.ts';

const project = resolve(import.meta.dirname, '..'),
  base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'observation-batches-ui-'));
const app = await Application.create({ project, runtime });
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    name: 'Example model',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'fixture',
    vision: true,
  }),
);
const backend = new FakeBackend();
app.router.backends.set('api', backend);
await app.registry.call(
  'characters.examples.create',
  { profileId: 'fixture', requestId: 'examples' },
  internal,
);
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(15000);
await mkdir(join(project, 'test-results'), { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${http.port}/?persona=example-hina#token=${http.token}`);
  const open = async () => {
    await page.getByRole('button', { name: '配置角色', exact: true }).click();
    await page.getByLabel('角色人设', { exact: true }).waitFor();
    await page.getByRole('button', { name: '自动化任务', exact: true }).last().click();
    await page.locator('.task-tabs').getByRole('button', { name: '一起看', exact: true }).click();
  };
  for (const [count, timeout] of [
    [1, 120],
    [9, 45],
    [4, 120],
  ]) {
    await open();
    const field = page.getByLabel('组图张数', { exact: true });
    assert.equal(await field.locator('option').count(), 4);
    await field.selectOption(String(count));
    await page.getByLabel('组图超时（秒）', { exact: true }).fill(String(timeout));
    assert.equal(await page.getByLabel('单帧宽度（像素）', { exact: true }).inputValue(), '840');
    await page.getByRole('button', { name: '保存角色', exact: true }).click();
    await page.getByRole('button', { name: '配置角色', exact: true }).waitFor();
    const saved = app.observations.config('example-hina-observe');
    assert.equal(saved.frameCount, count);
    assert.equal(saved.batchTimeoutSeconds, timeout);
  }
  await open();
  assert.equal(await page.getByLabel('组图张数', { exact: true }).inputValue(), '4');
  await page.screenshot({ path: join(project, 'test-results/observation-batches-config.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '自动化', exact: true }).click();
  await page.locator('.task-record').filter({ hasText: '一起看' }).click();
  await page.getByRole('heading', { name: '近期观察', exact: true }).waitFor();
  await page.getByText('当前组图', { exact: true }).waitFor();
  await page.getByText('超时丢弃组数', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('组图张数', { exact: true }).count(), 0);
  assert.equal(backend.calls.length, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(project, 'test-results/observation-batches-status.png') });
  const report = {
    choices: [1, 4, 9],
    savedAndReopened: true,
    numericOptionsUnique: true,
    statusReadOnly: true,
    pageErrors: 0,
    modelCalls: 0,
  };
  await writeFile(
    join(project, 'test-results/observation-batches-ui.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
