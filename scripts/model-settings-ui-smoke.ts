import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { PiBackend } from '../packages/backends/pi.ts';

const project = resolve(import.meta.dirname, '..');
const runtime = await mkdtemp(join(tmpdir(), 'Echo-model-settings-'));
const bodies: any[] = [];
const upstream = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'synthetic' }] }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  bodies.push(JSON.parse(body));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        id: 'synthetic',
        model: 'synthetic',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Synthetic result' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
const app = await Application.create({ runtime, project, plugins: [] });
await app.router.inference.saveConnection({
  id: 'fixture',
  name: 'Synthetic service',
  adapterId: 'core.api',
  deployment: 'local',
  config: { endpoint: `http://127.0.0.1:${(upstream.address() as any).port}/v1` },
});
await app.router.inference.saveModel({
  id: 'fixture',
  name: 'Synthetic model',
  connectionId: 'fixture',
  model: 'synthetic',
});
// Reproduce editing request settings while an earlier run awaits reconciliation.
app.store.saveConversation({ id: 'pending', personaId: 'fixture', title: 'Synthetic',
  injection: false, review: false, createdAt: new Date().toISOString() });
app.store.createRun({ id: 'pending', requestId: 'pending', conversationId: 'pending', profileId: 'fixture',
  epoch: 1, state: 'unknown', source: 'human', input: 'Synthetic', createdAt: new Date().toISOString(), meta: {} });
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    `http://127.0.0.1:${http.port}/?window=settings&page=backends#token=${http.token}`,
  );
  await page.getByRole('button', { name: 'Synthetic model', exact: true }).click();
  await page.getByText('生成参数', { exact: true }).click();
  await expect(page.getByText('上游未提供思考能力元数据', { exact: true }).first()).toBeVisible();
  await page.getByLabel('API 思考参数格式', { exact: true }).selectOption('effort');
  const declaration = page.getByRole('group', { name: '手动声明支持的思考级别', exact: true });
  await declaration.getByRole('checkbox', { name: 'low', exact: true }).check();
  await declaration.getByRole('checkbox', { name: 'high', exact: true }).check();
  await page.getByLabel('默认思考强度', { exact: true }).selectOption('high');
  await page.getByLabel('单次最大输出 token', { exact: true }).fill('128000');
  await page.getByLabel('模型上下文窗口（tokens，可选）', { exact: true }).fill('512000');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect.poll(() => app.router.profile('fixture').maxOutputTokens).toBe(128000);
  const saved = app.router.profile('fixture');
  assert.equal(saved.reasoning, 'high');
  assert.deepEqual(saved.reasoningSupport?.levels, ['low', 'high']);
  await page.getByRole('button', { name: '服务设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存服务', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Synthetic model', exact: true }).click();
  await page.getByText('生成参数', { exact: true }).click();
  await expect(page.getByLabel('默认思考强度', { exact: true })).toHaveValue('high');
  await expect(page.getByLabel('单次最大输出 token', { exact: true })).toHaveValue('128000');
  await new PiBackend(app.registry, async () => undefined).generate({
    profile: saved,
    messages: [{ role: 'user', text: 'Synthetic request' }],
    toolPolicy: 'none',
    requestId: 'settings-wire',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].max_tokens, 128000);
  assert.equal(bodies[0].reasoning_effort, 'high');
  const automatic = { ...saved, reasoningStyle: 'auto' as const, reasoningLevels: undefined, reasoningSupport: undefined };
  for (const effort of ['high', 'off'] as const)
    await new PiBackend(app.registry, async () => undefined).generate({ profile: automatic, reasoning: effort,
      messages: [{ role: 'user', text: 'Synthetic request' }], toolPolicy: 'none',
      requestId: 'automatic-' + effort, signal: AbortSignal.timeout(10000) });
  assert.equal(bodies[1].reasoning_effort, 'high');
  assert.equal(bodies[2].reasoning_effort, 'none');
  await page.getByLabel('单次最大输出 token', { exact: true }).fill('131073');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(page.locator('.inference-editor .form-actions').getByRole('alert')).toBeVisible();
  assert.equal(app.router.profile('fixture').maxOutputTokens, 128000);
  await page.getByLabel('单次最大输出 token', { exact: true }).fill('127999');
  await page.getByRole('button', { name: '服务设置', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改并离开', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic model', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByText('生成参数', { exact: true }).click();
  await expect(page.getByLabel('单次最大输出 token', { exact: true })).toHaveValue('128000');
  await page.setViewportSize({ width: 1000, height: 760 });
  await expect(page.getByLabel('默认思考强度', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  await mkdir(join(project, 'test-results'), { recursive: true });
  const report = {
    unknownMetadataExplained: true,
    manualDraftPreview: true,
    defaultReasoningEditable: true,
    settingsPersistAcrossReload: true,
    savedNavigationClean: true,
    discardedDraftCleared: true,
    saveFailureVisibleAtButton: true,
    pendingRunSettingsEditable: true,
    wireOutputTokens: bodies[0].max_tokens,
    wireReasoning: bodies[0].reasoning_effort,
    automaticReasoningHonored: true,
    pageErrors: errors.length,
    realProviderCalls: 0,
  };
  await writeFile(
    join(project, 'test-results/model-settings-ui.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(-4000));
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
  upstream.closeAllConnections();
  await new Promise<void>((done) => upstream.close(() => done()));
  await rm(runtime, { recursive: true, force: true });
}
