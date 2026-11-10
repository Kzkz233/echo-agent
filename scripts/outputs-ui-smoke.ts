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
import { FakeBackend, until, submitFixtureReplies } from '../tests/helpers.ts';

const project = resolve(import.meta.dirname, '..'),
  base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'outputs-ui-')),
  app = await Application.create({ project, runtime });
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    name: 'Example model',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'example-model',
    vision: true,
  }),
);
const backend = new FakeBackend();
app.router.backends.set('api', backend);
let deliveries = 0;
app.plugins.add({
  manifest: {
    id: 'fixture',
    name: 'Fixture',
    description: 'Synthetic channel',
    version: '1',
    permissions: ['channels.adapter'],
    dependencies: ['channels'],
    settings: [],
  },
  activate: (ctx) => {
    ctx.capabilities.provide('channels.send@1', 'fixture.channel', 'Example inbox', () => {
      deliveries++;
      return { state: 'delivered' };
    });
  },
});
await app.plugins.enable('fixture');
await app.registry.call(
  'characters.examples.create',
  { profileId: 'fixture', requestId: 'examples' },
  internal,
);
const role = await app.registry.call('persona.character.read', { id: 'example-hina' }, internal);
await app.registry.call(
  'channels.bind',
  {
    id: 'fixture-binding',
    adapter: 'fixture.channel',
    peer: 'example-recipient',
    conversationId: role.mainConversationId,
  },
  internal,
);
const http = await serve(app, { webRoot: join(project, 'dist/web') }),
  browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
try {
  await page.goto(`http://127.0.0.1:${http.port}/?persona=example-hina#token=${http.token}`);
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page.getByLabel('角色人设', { exact: true }).waitFor();
  await page.getByRole('button', { name: '自动化任务', exact: true }).last().click();
  await page.locator('.task-tabs').getByRole('button', { name: '日常交流', exact: true }).click();
  const options = page.locator('.output-targets');
  await options.getByRole('checkbox', { name: '聊天', exact: true }).uncheck();
  await options.getByRole('checkbox', { name: /^桌宠气泡/ }).uncheck();
  await options.getByRole('checkbox', { name: /Example inbox/ }).check();
  await page.screenshot({ path: join(project, 'test-results/task-outputs.png') });
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: '配置角色', exact: true }).waitFor();
  const saved = app.care.rules().find((rule) => rule.id === 'example-hina-care')!;
  assert.deepEqual(saved.outputTargets, ['channels.binding.fixture-binding']);
  backend.responder = (request) => submitFixtureReplies(request, 'SYNTHETIC_EXTERNAL_RESULT');
  await app.triggerActions.dispatch(
    {
      action: 'conversation',
      kind: 'care.opportunity',
      requestId: 'fixture-output',
      conversationId: role.mainConversationId,
      text: 'Synthetic activity',
      outputTargets: saved.outputTargets,
      task: { type: 'care.rules', id: saved.id },
    },
    'care',
    new AbortController().signal,
  );
  await until(() => deliveries === 1);
  assert.equal(backend.calls.length, 1);
  assert.equal(await page.getByText('SYNTHETIC_EXTERNAL_RESULT', { exact: true }).count(), 0);
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '自动化', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '手动委派子任务', exact: true }).count(), 0);
  await page.getByRole('tab', { name: '子任务', exact: true }).click();
  await page.getByRole('button', { name: '手动委派', exact: true }).click();
  await page.getByRole('heading', { name: '手动委派子任务', exact: true }).waitFor();
  await page.getByText('本次执行设置', { exact: true }).click();
  await page.getByLabel('本次执行时限（分钟）', { exact: true }).waitFor();
  assert.equal(await page.locator('.task-record').filter({ hasText: '日常交流' }).count(), 0);
  await page.getByRole('tab', { name: '自动化', exact: true }).click();
  await page.locator('.task-record').filter({ hasText: '日常交流' }).click();
  await page.getByRole('heading', { name: '结果与投递', exact: true }).waitFor();
  await page.getByText('SYNTHETIC_EXTERNAL_RESULT', { exact: true }).first().click();
  await page.getByText(/Example inbox.*已送达/).waitFor();
  await page.screenshot({ path: join(project, 'test-results/task-delivery-history.png') });
  assert.deepEqual(errors, []);
  const result = {
    taskScopedOutputs: true,
    externalOnlyHiddenInChat: true,
    oneGeneration: true,
    deliveryHistory: true,
    separateAutomationAndWork: true,
    pageErrors: 0,
    realProviderCalls: 0,
  };
  await writeFile(join(project, 'test-results/outputs-ui.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: join(project, 'test-results/outputs-ui-failure.png') });
  console.log((await page.locator('body').innerText()).slice(-4000));
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
