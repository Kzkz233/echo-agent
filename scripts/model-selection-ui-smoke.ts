import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { z } from 'zod';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterFeature } from '../packages/kernel/characters.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { inferenceTasks, modelProfileSchema } from '../packages/contracts/inference.ts';
import { seedProfile } from './inference-fixture.ts';
const project = resolve(import.meta.dirname, '..'),
  root = join(tmpdir(), 'EchoTests');
await mkdir(root, { recursive: true });
const runtime = await mkdtemp(join(root, 'model-selection-ui-'));
let generations = 0;
const upstream = createServer((req, res) => {
  if (req.method !== 'GET') generations++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: [{ id: 'language' }, { id: 'vision' }] }));
});
await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
const app = await Application.create({ runtime, project }),
  endpoint = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
for (const plugin of ['semantic', 'worker-dsh', 'worker-codex']) await app.plugins.enable(plugin);
await app.router.inference.refresh();
for (const [id, kind, vision] of [
  ['language', 'api', false],
  ['vision', 'api', true],
  ['dsh-worker', 'dsh', true],
  ['codex-worker', 'codex', true],
] as const)
  seedProfile(app, profileSchema.parse({ id, name: id, model: id, kind, vision, endpoint }));
for (const kind of ['dsh', 'codex'] as const)
  app.router.backends.set(kind, {
    kind,
    generate: async () => {
      throw Error('No model calls');
    },
    listModels: async () => [{ id: kind + '-worker', label: kind + '-worker', reasoning: { source: 'host', levels: ['low', 'high'] } }],
  });
app.store.put(
  'profiles',
  'vectors',
  modelProfileSchema.parse({
    id: 'vectors',
    name: 'Vectors',
    connectionId: 'language',
    model: 'vectors',
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'] },
  }),
);
app.store.put(
  'profiles',
  'rank',
  modelProfileSchema.parse({
    id: 'rank',
    name: 'Rank',
    connectionId: 'language',
    model: 'rank',
    generation: { enabled: false, inputs: ['text'] },
    reranking: { enabled: true, inputs: ['text'] },
  }),
);
const schema = z.object({ model: z.string().default(''), executor: z.string().default('') });
const fields: any[] = [
  {
    key: 'model',
    label: 'Fixture query model',
    type: 'select',
    resource: 'model',
    inferenceTask: inferenceTasks.query,
  },
  {
    key: 'executor',
    label: 'Fixture vision executor',
    type: 'select',
    resource: 'executor',
    inferenceTask: inferenceTasks.vision,
  },
];
app.plugins.add({
  manifest: {
    id: 'selectionfixture',
    name: 'Selection fixture',
    description: 'Fixture',
    version: '1',
    dependencies: ['memory'],
    permissions: ['character.contribute'],
    settings: [
      { ...fields[0], key: 'globalModel', label: 'Global query model' },
      { ...fields[1], key: 'globalExecutor', label: 'Global vision executor' },
    ],
    characterSettings: { section: 'tools', title: '工具与委派', order: 40 },
  },
  config: {
    schema: z.object({
      globalModel: z.string().default(''),
      globalExecutor: z.string().default(''),
    }),
  },
  character: characterFeature(app.store, 'selectionfixture', schema, fields),
  activate: () => {},
});
await app.plugins.enable('selectionfixture');
await app.registry.call(
  'persona.character.commit',
  {
    requestId: 'fixture',
    draft: characterDraft.parse({
      persona: { id: 'mira', name: 'Mira', prompt: 'Synthetic' },
      profileId: 'language',
      features: ['memory', 'observation', 'review', 'delegation', 'selectionfixture'],
      configurations: {
        delegation: { templates: [{ id: 'worker', name: 'Worker', profileId: 'dsh-worker' }] },
      },
      tasks: [
        {
          id: 'watch',
          type: 'observation.tasks',
          settings: { name: 'Watch fixture', personaId: 'mira', enabled: false },
        },
        {
          id: 'review',
          type: 'review.policies',
          settings: { name: 'Review fixture', personaId: 'mira', enabled: false },
        },
      ],
    }),
  },
  internal,
);
app.store.set('routes', {
  ...app.store.get('routes', {}),
  [inferenceTasks.rerankLanguage]: 'codex-worker',
});
app.store.put('review-jobs', 'paused-fixture', {
  id: 'paused-fixture',
  key: 'fixture',
  personaId: 'mira',
  state: 'paused',
  materials: [],
  packets: [],
  nextPacket: 0,
  notes: '',
  drafts: [],
  applied: false,
  profileId: 'dsh-worker',
  createdAt: new Date().toISOString(),
});
const http = await serve(app, { webRoot: join(project, 'dist/web') }),
  browser = await chromium.launch({ channel: 'msedge', headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const go = (query: string) =>
  page.goto(`http://127.0.0.1:${http.port}/?${query}#token=${http.token}`);
const values = async (label: string, scope: any = page) =>
  (
    await scope
      .getByLabel(label, { exact: true })
      .locator('option:enabled')
      .evaluateAll((nodes: HTMLOptionElement[]) => nodes.map((node) => node.value))
  ).filter(Boolean);
try {
  await go('window=settings&page=plugins');
  await page.locator('[data-plugin="semantic"]').click();
  await page.getByLabel('查询优化', { exact: true }).waitFor();
  assert.deepEqual((await values('查询优化')).sort(), ['language', 'vision']);
  assert.deepEqual((await values('语言模型重排')).sort(), ['language', 'vision']);
  assert.equal(await page.getByLabel('语言模型重排', { exact: true }).inputValue(), 'codex-worker');
  assert.equal(
    await page
      .getByLabel('语言模型重排', { exact: true })
      .locator('option[value="codex-worker"]')
      .evaluate((node: HTMLOptionElement) => node.disabled),
    true,
  );
  assert.deepEqual((await values('共享语义向量')).sort(), ['language', 'vectors', 'vision']);
  await page.locator('[data-plugin="selectionfixture"]').click();
  await page.getByLabel('Global query model', { exact: true }).waitFor();
  assert.deepEqual((await values('Global query model')).sort(), ['language', 'vision']);
  assert(
    await page
      .getByLabel('Global vision executor', { exact: true })
      .locator('option[value="worker-dsh.provider"]')
      .evaluate((node: HTMLOptionElement) => node.disabled),
  );
  await go('persona=mira');
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page
    .locator('.role-editor-nav')
    .getByRole('button', { name: '模型与权限', exact: true })
    .click();
  assert.deepEqual((await values('主会话模型')).sort(), ['language', 'vision']);
  await page
    .locator('.role-editor-nav')
    .getByRole('button', { name: '记忆与资料', exact: true })
    .click();
  assert.deepEqual((await values('记忆检索词构造')).sort(), ['language', 'vision']);
  await page
    .locator('.role-editor-nav')
    .getByRole('button', { name: '工具与委派', exact: true })
    .click();
  const worker = page.locator('[data-delegation-executors]');
  assert.equal(await worker.getByLabel('子任务执行方式', { exact: true }).inputValue(), 'choose');
  await worker.getByLabel('子任务执行方式', { exact: true }).selectOption('fixed');
  await worker.getByLabel('指定执行器', { exact: true }).selectOption('worker-dsh.provider');
  await worker.getByLabel('子任务默认思考强度', { exact: true }).selectOption('high');
  assert.equal(await worker.getByLabel('子任务默认思考强度', { exact: true }).inputValue(), 'high');
  assert.equal(await worker.getByLabel('执行模型', { exact: true }).inputValue(), 'dsh-worker');
  assert.deepEqual(await values('执行模型', worker), ['dsh-worker']);
  const extra = page.locator('[data-role-feature="selectionfixture"]');
  assert.deepEqual((await values('Fixture query model', extra)).sort(), ['language', 'vision']);
  assert(
    await extra
      .getByLabel('Fixture vision executor', { exact: true })
      .locator('option[value="worker-dsh.provider"]')
      .evaluate((node: HTMLOptionElement) => node.disabled),
  );
  await app.plugins.disable('worker-dsh');
  app.events.emit('plugins.changed', {});
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>(
        '[data-delegation-executors] select[aria-label="执行模型"]',
      )?.selectedOptions[0]?.disabled === true,
  );
  assert.equal(await worker.getByLabel('执行模型', { exact: true }).inputValue(), 'dsh-worker');
  await app.plugins.enable('worker-dsh');
  app.router.backends.set('dsh', {
    kind: 'dsh',
    generate: async () => {
      throw Error('No model calls');
    },
    listModels: async () => [{ id: 'dsh-worker', label: 'Worker' }],
  });
  app.events.emit('plugins.changed', {});
  await page
    .locator('.role-editor-nav')
    .getByRole('button', { name: '自动化任务', exact: true })
    .click();
  await page.locator('.task-tabs button').filter({ hasText: 'Watch fixture' }).click();
  await page.getByLabel('视觉模型', { exact: true }).waitFor();
  assert.deepEqual(await values('视觉模型'), ['vision']);
  assert(
    await page
      .getByLabel('视觉模型', { exact: true })
      .locator('option[value=""]')
      .evaluate((node: HTMLOptionElement) => node.disabled),
  );
  await page.locator('.task-tabs button').filter({ hasText: 'Review fixture' }).click();
  await page.getByLabel('整理执行器', { exact: true }).selectOption('worker-codex.provider');
  assert.equal(await page.getByLabel('执行模型', { exact: true }).inputValue(), 'codex-worker');
  await go('persona=mira&page=review');
  await page.getByLabel('续跑模型', { exact: true }).waitFor();
  assert.deepEqual((await values('续跑模型')).sort(), [
    'codex-worker',
    'dsh-worker',
    'language',
    'vision',
  ]);
  assert.equal(app.store.get<any>('routes', {})[inferenceTasks.rerankLanguage], 'codex-worker');
  assert.equal(generations, 0);
  assert.deepEqual(errors, []);
  const report = {
    sharedRoutes: true,
    roleMainAndRecall: true,
    registeredModelFields: true,
    observationModalityAndInheritance: true,
    workerLifecycle: true,
    reviewWorkersAndResume: true,
    invalidSelectionPreserved: true,
    modelCalls: 0,
    pageErrors: 0,
  };
  await writeFile(
    join(project, 'test-results/model-selection-ui.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: join(project, 'test-results/model-selection-ui-failure.png') });
  console.error((await page.locator('body').innerText()).slice(-4500));
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
  await new Promise<void>((done) => upstream.close(() => done()));
}
