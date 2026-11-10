import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { accountSchema } from '../plugins/mail/index.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { inferenceTasks } from '../packages/contracts/inference.ts';
import { seedProfile, seedRoutes } from './inference-fixture.ts';
const project = resolve(import.meta.dirname, '..'),
  base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'proactive-ui-')),
  app = await Application.create({ runtime, project });
for (const id of [
  'observation',
  'reflections',
  'care',
  'mail-triggers',
  'notifications',
  'channels',
  'agenda',
  'semantic',
  'documents',
])
  await app.plugins.enable(id);
await app.mailTriggers.settled();
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    name: 'Fixture model',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'fixture',
    vision: true,
  }),
);
seedRoutes(app, { chat: 'fixture', query: 'fixture', review: 'fixture', vision: 'fixture' });
await app.router.inference.saveModel({
  ...app.router.inference.models().find((model) => model.id === 'fixture')!,
  embedding: { enabled: false, inputs: ['text'] },
});
await app.router.inference.saveConnection({
  id: 'vector-fixture',
  name: 'Fixture vectors',
  adapterId: 'core.api',
  deployment: 'local',
  config: { endpoint: 'http://127.0.0.1:1/v1' },
});
for (const id of ['gemma-fixture', 'bge-fixture'])
  await app.router.inference.saveModel({
    id,
    name: id,
    connectionId: 'vector-fixture',
    model: id,
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'] },
  });
app.store.set('routes', {
  ...app.store.get<object>('routes', {}),
  [inferenceTasks.embedding]: 'bge-fixture',
});
let calls = 0;
app.router.backends.set('api', {
  kind: 'api',
  generate: async () => {
    calls++;
    return { text: 'Fixture result' };
  },
});
app.store.put(
  'mail-accounts',
  'fixture-mail',
  accountSchema.parse({
    id: 'fixture-mail',
    personaId: 'fixture',
    name: 'Fixture inbox',
    user: 'fixture@example.invalid',
    from: 'fixture@example.invalid',
    passwordRef: 'unused',
    imap: { host: 'localhost', port: 143, secure: false },
    smtp: { host: 'localhost', port: 25, secure: false },
  }),
);
await app.registry.call(
  'persona.character.commit',
  {
    requestId: 'fixture-create',
    draft: characterDraft.parse({
      persona: { id: 'fixture', name: 'Fixture', prompt: 'A fictional test character.' },
      profileId: 'fixture',
      features: [
        'memory',
        'reflections',
        'care',
        'mail',
        'mail-triggers',
        'observation',
      ],
      routes: { 'semantic.memory-embedding': 'gemma-fixture' },
      tasks: [
        {
          id: 'observe-fixture',
          type: 'observation.tasks',
          settings: {
            name: 'Observe fixture',
            enabled: false,
            quality: 65,
            allowlist: [
              {
                id: 'game-fixture',
                type: 'process',
                value: 'fictional-game.exe',
                enabled: true,
                prompt: 'Fictional game',
              },
            ],
          },
        },
        {
          id: 'care-fixture',
          type: 'care.rules',
          settings: { name: 'Care fixture', enabled: false, hourStart: 0, hourEnd: 24 },
        },
        {
          id: 'mail-fixture',
          type: 'mail-triggers.rules',
          settings: {
            name: 'Mail fixture',
            enabled: false,
            accountIds: ['fixture-mail'],
            keywords: 'deadline',
          },
        },
      ],
    }),
  },
  internal,
);
await app.registry.call(
  'memory.save',
  {
    personaId: 'fixture',
    title: 'A lasting experience',
    text: 'A fictional lasting feeling remains a memory.',
    core: false,
    tags: [],
    sources: [],
  },
  internal,
);
const http = await serve(app, { webRoot: join(project, 'dist/web') }),
  browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
  page = await context.newPage();
page.setDefaultTimeout(12000);
const errors: string[] = [];
context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${http.port}/#token=${http.token}`);
  await page
    .locator('aside')
    .getByRole('button', { name: /Fixture/ })
    .click();
  await page.getByRole('tab', { name: '角色记忆', exact: true }).click();
  await page.locator('[data-memory-kind="concerns"]').click();
  assert.equal(await page.getByRole('tab', { name: '主观想法', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '已解决', exact: true }).count(), 0);
  await page.getByRole('button', { name: '添加关注', exact: true }).click();
  const editor = page.locator('dialog[open]');
  await editor.getByLabel('标题', { exact: true }).fill('Next small discovery');
  await editor
    .getByLabel('在意的内容', { exact: true })
    .fill('I would like to hear about the next attempt.');
  await editor
    .getByLabel('想接着关注', { exact: true })
    .fill('Ask naturally when the topic returns.');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: 'Next small discovery' }).waitFor();
  assert.equal(app.store.documents<any>('reflections')[0].status, undefined);
  await page.screenshot({ path: join(project, 'test-results/current-concerns-ui.png') });
  await page.getByRole('button', { name: '淡出关注', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '淡出关注', exact: true }).click();
  await page.getByText('暂时没有在意的事', { exact: true }).waitFor();
  assert.equal(
    ((await app.registry.call('memory.list', { personaId: 'fixture' }, internal)) as any[]).length,
    1,
  );
  await page.locator('[data-section="agenda"]').click();
  await page.getByRole('heading', { name: '日历与提醒', exact: true }).waitFor();
  assert.equal(await page.locator('.role-heading').count(), 0);
  assert.equal(await page.getByRole('tablist', { name: '角色能力' }).count(), 0);
  await page.screenshot({ path: join(project, 'test-results/shared-workbench-ui.png') });
  const popup = page.waitForEvent('popup');
  await page
    .locator('.sidebar-settings')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  const settings = await popup;
  settings.setDefaultTimeout(12000);
  await settings.locator('[data-section="connections"]').click();
  for (const id of ['agenda', 'mail', 'activity', 'knowledge', 'automation'])
    assert.equal(await settings.locator(`[data-section="${id}"]`).count(), 0);
  assert.equal(await settings.getByRole('tab', { name: '公共推理用途', exact: true }).count(), 0);
  await settings.getByRole('tab', { name: '消息渠道连接', exact: true }).click();
  await settings.getByRole('heading', { name: '消息渠道连接', exact: true }).waitFor();
  await settings.getByRole('heading', { name: '可用消息渠道', exact: true }).waitFor();
  assert.equal(await settings.getByRole('heading', { name: '会话绑定', exact: true }).count(), 0);
  await settings.getByRole('tab', { name: '推理后端', exact: true }).click();
  await settings.getByRole('tab', { name: '文档解析', exact: true }).click();
  await settings.getByRole('heading', { name: '文档解析连接', exact: true }).waitFor();
  await settings.getByText('尚未配置 API 凭据', { exact: true }).waitFor();
  assert.equal(
    await settings.getByLabel('解析提供方', { exact: true }).inputValue(),
    'documents.mineru-api',
  );
  await settings.screenshot({ path: join(project, 'test-results/general-settings-ui.png') });
  await settings.locator('[data-section="plugins"]').click();
  await settings.locator('[data-plugin="observation"]').waitFor();
  for (const id of ['persona', 'scheduler', 'channels', 'notifications'])
    assert.equal(await settings.locator(`[data-plugin="${id}"]`).count(), 0);
  await settings.locator('[data-section="system"]').click();
  const modules = settings
    .locator('.card')
    .filter({ has: settings.getByRole('heading', { name: '内建模块' }) });
  for (const name of ['角色设定', '任务调度', '会话通道'])
    await modules.getByText(new RegExp(name)).waitFor();
  assert.equal(await modules.getByRole('checkbox').count(), 0);
  await page.locator('[data-section="automation"]').click();
  const sources = page.locator('details').filter({ hasText: '已登记的触发来源' });
  await sources.locator('summary').click();
  for (const name of ['实时观察线索', '主动交流机会', '新邮件线索'])
    await sources.getByText(name, { exact: true }).waitFor();
  await page
    .locator('aside')
    .getByRole('button', { name: /Fixture/ })
    .click();
  await settings.evaluate(() =>
    window.dispatchEvent(new CustomEvent('echo:settings-page', { detail: 'agenda' })),
  );
  await page.locator('[data-section="agenda"].selected').waitFor();
  assert.equal(await page.locator('.role-heading').count(), 0);
  await page
    .locator('aside')
    .getByRole('button', { name: /Fixture/ })
    .click();
  await page.getByRole('tab', { name: '自动化任务', exact: true }).click();
  const careTask = page.locator('.automation-item').filter({ hasText: 'Care fixture' });
  await careTask.locator('.automation-item-open').click();
  await page.getByRole('heading', { name: '运行情况', exact: true }).waitFor();
  assert.equal(await page.locator('.automation-editor').count(), 0);
  assert.equal(await careTask.getByRole('button', { name: '编辑', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '编辑任务', exact: true }).count(), 0);
  await page
    .locator('aside')
    .getByRole('button', { name: /Fixture/ })
    .click();
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page.getByRole('button', { name: /运行方式/ }).click();
  await settings.evaluate(() =>
    window.dispatchEvent(new CustomEvent('echo:settings-page', { detail: 'plugins' })),
  );
  await settings.locator('[data-plugin="embeddings"]').click();
  assert.equal(await settings.getByLabel('共享语义向量', { exact: true }).inputValue(), 'bge-fixture');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('aside').getByRole('button', { name: /Fixture/ }).click();
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page.getByRole('button', { name: /行为与任务/ }).click();
  await page.getByRole('button', { name: /行为与任务/ }).click();
  await page
    .locator('.task-tabs')
    .getByRole('button', { name: 'Care fixture', exact: true })
    .click();
  assert.equal(await page.getByLabel('检测间隔（分钟）', { exact: true }).inputValue(), '30');
  assert.equal(await page.getByLabel('开口概率策略', { exact: true }).inputValue(), 'daily-budget');
  assert.equal(await page.getByLabel('每天最多尝试开口次数', { exact: true }).inputValue(), '3');
  await page
    .locator('.task-tabs')
    .getByRole('button', { name: 'Observe fixture', exact: true })
    .click();
  assert.equal(await page.getByLabel('组图 JPEG 质量', { exact: true }).inputValue(), '65');
  const occlusionGroup = page.getByRole('group', { name: '忽略遮挡的窗口', exact: true });
  await occlusionGroup.waitFor();
  assert.equal(await occlusionGroup.locator('.card').count(), 0);
  await occlusionGroup.getByRole('button', { name: '添加条目', exact: true }).click();
  await page.getByLabel('进程名或完整路径', { exact: true }).fill('fixture-overlay.exe');
  await page.getByLabel('窗口标题包含', { exact: true }).fill('Fixture Overlay');
  await page.getByRole('button', { name: /检查并启用/ }).click();
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: '配置角色', exact: true }).waitFor();
  const configuredOccluder = app.observations.configurations()
    .find((task) => task.name === 'Observe fixture')?.occlusionAllowlist[0];
  assert.equal(configuredOccluder?.value, 'fixture-overlay.exe');
  assert.equal(configuredOccluder?.title, 'Fixture Overlay');
  assert.equal(
    app.store.document<any>('characters', 'fixture').routes['semantic.memory-embedding'],
    undefined,
  );
  assert.equal(app.store.get<any>('routes', {})[inferenceTasks.embedding], 'bge-fixture');
  await page.getByRole('tab', { name: '自动化任务', exact: true }).click();
  await page
    .locator('.automation-item')
    .filter({ hasText: 'Observe fixture' })
    .locator('.automation-item-open')
    .click();
  await page.getByRole('heading', { name: '近期观察', exact: true }).waitFor();
  assert.equal(await page.getByLabel('组图 JPEG 质量', { exact: true }).count(), 0);
  assert.equal(calls, 0);
  assert.deepEqual(errors, []);
  const result = {
    concernsBesideMemory: true,
    noTaskStatusForConcerns: true,
    sharedAgendaInMain: true,
    generalSettingsOnly: true,
    roleInferenceHiddenFromGlobal: true,
    settingsReturnToWorkbench: true,
    probabilityFields: true,
    builtinDiagnostics: true,
    sharedTriggerSources: true,
    roleTaskConfigurationOnly: true,
    roleEmbeddingSelector: false,
    sharedEmbeddingRoute: true,
    observationReadOnlyStatus: true,
    observationEncodingControls: true,
    userDefinedOcclusionRules: true,
    documentConnectionSeparatedFromImport: true,
    modelCalls: calls,
  };
  await writeFile(join(project, 'test-results/proactive-ui.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: join(project, 'test-results/proactive-ui-failure.png') });
  console.log((await page.locator('body').innerText()).slice(-4500));
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
