import { seedProfile, seedRoutes } from './inference-fixture.ts';
import { productWorkflows } from './product-steps.ts';
import { libraryWorkflows } from './library-ui-steps.ts';
import { inferenceWorkflows } from './inference-ui-steps.ts';
import { auditWorkbench } from './ui-audit-steps.ts';
import catalog from '../apps/workbench/src/locales.json' with { type: 'json' };
import { sections } from '../apps/workbench/src/navigation.ts';
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { profileSchema, type Backend } from '../packages/contracts/index.ts';
const project = resolve(import.meta.dirname, '..');
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'ui-'));
const app = await Application.create({ runtime, project });
for (const id of [
  'assets',
  'agenda',
  'care',
  'mail',
  'scheduler',
  'backup',
  'notifications',
  'reflections',
  'documents',
  'semantic',
  'approvals',
  'mail-actions',
  'channels',
  'qq',
])
  await app.plugins.enable(id);
const profile = profileSchema.parse({
  id: 'synthetic',
  name: '合成测试后端',
  kind: 'api',
  model: 'synthetic',
  endpoint: 'http://127.0.0.1:1/v1',
  vision: true,
});
seedProfile(app, profile);
seedRoutes(app, { chat: profile.id, review: profile.id, vision: profile.id });
app.store.set('memory.config', { planner: false });
app.router.backends.set('api', {
  kind: 'api',
  generate: async (request) => {
    if (request.messages.at(-1)?.text === 'Synthetic host approval') {
      const decision = await request.onInteraction?.({ kind: 'approval', title: 'Synthetic approval', detail: 'Synthetic file operation' }, request.signal);
      if (decision?.decision !== 'allow') throw Error('Synthetic approval was not delivered');
      return { text: 'Synthetic approval completed' };
    }
    return request.messages[0]?.text.includes('角色记忆整理')
      ? { text: '{"notes":"已完整阅读合成测试对话。","memories":[]}' }
      : { text: '测试回复：我记得你喜欢在傍晚散步。我们可以接着聊聊今天的事。' };
  },
} satisfies Backend);
await app.memories.save({
  personaId: 'companion',
  title: '傍晚散步',
  text: '使用者喜欢在傍晚散步。',
  core: false,
  tags: [],
  sources: [],
});
await app.memories.save(
  {
    personaId: 'companion',
    title: '合成核心设定',
    text: '虚构验收用固定记忆，不属于任何真实用户。',
    core: true,
    tags: [],
    sources: [],
  },
  true,
);
const http = await serve(app, { webRoot: join(project, 'dist', 'web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
});
page.setDefaultTimeout(15000);
const translations = new Map<string, string>();
for (const pair of catalog) for (const source of pair) translations.set(source, pair[0]);
const tr = (source: string) => translations.get(source) ?? source;
const byRole = page.getByRole.bind(page),
  byText = page.getByText.bind(page),
  byLabel = page.getByLabel.bind(page);
page.getByRole = ((role: any, options: any = {}) =>
  byRole(role, {
    ...options,
    name: typeof options.name === 'string' ? tr(options.name) : options.name,
  })) as typeof page.getByRole;
page.getByText = ((value: any, options: any) =>
  byText(typeof value === 'string' ? tr(value) : value, options)) as typeof page.getByText;
page.getByLabel = ((value: any, options: any) =>
  byLabel(typeof value === 'string' ? tr(value) : value, options)) as typeof page.getByLabel;
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${http.port}/#token=${http.token}`);
  await page.getByText('让对话有自己的延续').waitFor();
  if (
    (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) !== 'light'
  )
    throw Error('Light theme default did not override system dark preference');
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/workbench.png' });
  await page.getByRole('button', { name: '开始一段对话', exact: true }).click();
  await page.getByLabel('人格记忆', { exact: true }).check();
  await page.getByLabel('纳入整理', { exact: true }).check();
  await page.getByLabel('聊天消息').fill('我想聊聊傍晚散步。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page
    .locator('.messages')
    .getByText('测试回复：我记得你喜欢在傍晚散步。我们可以接着聊聊今天的事。', { exact: true })
    .waitFor();
  await page.screenshot({ path: 'docs/screenshots/chat.png' });
  if (!app.store.allMessages(app.store.conversations()[0].id).some((m) => m.meta.kind === 'memory'))
    throw Error('Memory injection missing');
  const approval = app.router.send({ conversationId: app.store.conversations()[0].id,
    requestId: 'ui-host-approval', text: 'Synthetic host approval' });
  await page.getByRole('button', { name: '仅允许这一次', exact: true }).click();
  if ((await approval).state !== 'succeeded') throw Error('Workbench did not deliver the approval');
  await page.locator('.messages').getByText('Synthetic approval completed', { exact: true }).waitFor();
  const go = async (name: string) => {
    const ids: Record<string, string> = {
      对话: 'chat',
      人格: 'persona-settings',
      记忆: 'memory',
      观察: 'observation',
      知识库: 'knowledge',
      整理: 'review',
      桌宠: 'avatar',
      推理路由: 'backends',
      插件: 'plugins',
      诊断: 'diagnostics',
      Agenda: 'agenda',
      Files: 'files',
      Assets: 'assets',
      Care: 'care',
      Mail: 'mail',
      Scheduler: 'scheduler',
      Backup: 'backup',
      Notifications: 'notifications',
      Approvals: 'approvals',
      Channels: 'channels',
    };
    const id = ids[name] ?? name,
      section = sections.find((s) => s.views.some((v) => v.id === id))!;
    await page.locator('nav button[data-section="' + section.id + '"]').click();
    if (section.id === 'personas' && id !== 'personas')
      await page.locator('.role-tile').first().click();
    const tab = page.locator('[role="tab"][data-view="' + id + '"]');
    if (await tab.count()) await tab.click();
  };
  await go('人格');
  await page.getByRole('heading', { name: '角色设定', exact: true }).waitFor();
  await go('记忆');
  await page.getByLabel('记忆检索').fill('傍晚散步');
  await page.getByRole('button', { name: '检索预览', exact: true }).click();
  await page.getByRole('heading', { name: '召回结果' }).waitFor();
  await go('观察');
  await page.getByRole('button', { name: '＋ 添加白名单', exact: true }).click();
  await page.getByLabel('白名单内容').fill('example.com');
  await page.getByLabel('来源背景说明').fill('一个演示网站，仅用于测试配置。');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('status').getByText('已保存').waitFor();
  if (app.observations.config().enabled) throw Error('Capture unexpectedly enabled');
  await go('知识库');
  const source = join(runtime, 'synthetic-source.txt');
  await writeFile(source, '这是合成的知识库验收资料。');
  await page.getByRole('button', { name: '导入原件', exact: true }).click();
  await page.getByLabel('材料文件路径').fill(source);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('status').getByText('解析任务已创建', { exact: true }).waitFor();
  await page.getByRole('button').filter({ hasText: 'synthetic-source.txt' }).first().waitFor();
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByLabel('知识库导出 ZIP').fill(join(runtime, 'ui-export.zip'));
  await page.locator('.operation-panel').getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('status').getByText('已导出', { exact: true }).waitFor();
  await go('整理');
  await page.locator('.automation-item').filter({ hasText: 'Echo' }).click();
  await page.getByRole('button', { name: '运行一次', exact: true }).click();
  await page.getByText('已完成', { exact: true }).waitFor();
  await go('桌宠');
  await page.locator('.sprite').waitFor();
  await go('推理路由');
  await page.getByRole('tab', { name: '任务路由', exact: true }).click();
  await page.getByRole('heading', { name: '任务路由', exact: true }).waitFor();
  await go('插件');
  await page.getByRole('heading', { name: '插件', exact: true }).waitFor();
  await go('诊断');
  await page.getByRole('heading', { name: 'MCP 对外能力', exact: true }).waitFor();
  await go('Agenda');
  const now = new Date(),
    day = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  await page.getByRole('button', { name: '在此日期新增 ' + day, exact: true }).click();
  await page.getByLabel('Calendar title').fill('Calendar UI fixture');
  await page.getByLabel('Priority', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: '保存日程', exact: true }).click();
  await page.getByRole('button', { name: 'Calendar UI fixture', exact: true }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/calendar.png' });
  let approved = 0;
  app.plugins.add({
    manifest: {
      id: 'fixture',
      name: 'Fixture',
      description: 'Synthetic approval',
      version: '0.2.0',
      dependencies: [],
      permissions: ['approvals.contribute'],
      settings: [],
      views: [],
    },
    activate: (ctx) => {
      ctx.capabilities.provide(
        'approvals.prepare@1',
        'fixture.local',
        'Synthetic operation',
        () => ({
          title: 'Synthetic approval',
          details: [{ label: 'Effect', value: 'No external operation' }],
          frozen: { synthetic: true },
        }),
      );
      ctx.capabilities.provide(
        'approvals.execute@1',
        'fixture.local',
        'Synthetic operation',
        () => {
          approved++;
          return { state: 'succeeded' };
        },
      );
    },
  });
  await app.plugins.enable('fixture');
  await app.approvals.request('fixture.local', {}, 'ui-approval', new AbortController().signal);
  await go('Approvals');
  await page.getByRole('button').filter({ hasText: 'Synthetic approval' }).click();
  await page.getByText('No external operation', { exact: true }).waitFor();
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '批准执行', exact: true }).click();
  await page.getByText('已成功 · fixture.local', { exact: true }).waitFor();
  if (approved !== 1) throw Error('Frontend approval did not execute exactly once');
  await page.setViewportSize({ width: 800, height: 900 });
  await page.screenshot({ path: 'docs/screenshots/responsive.png' });
  // Deterministically place a reply in the gap between initial pending lookup and SSE subscription.
  for (const receipt of app.store.receipts().filter((r) => r.kind === 'bubble'))
    app.store.saveReceipt(receipt.id, { ...receipt, state: 'dismissed' });
  const avatarPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let releaseEvents!: () => void, reachedEvents!: () => void;
  const eventGate = new Promise<void>((r) => (releaseEvents = r)),
    eventReached = new Promise<void>((r) => (reachedEvents = r));
  await avatarPage.route('**/events', async (route) => {
    reachedEvents();
    await eventGate;
    await route.continue();
  });
  await avatarPage.goto(`http://127.0.0.1:${http.port}/#token=${http.token}`);
  await eventReached;
  await app.router.send({
    conversationId: app.store.conversations()[0].id,
    text: 'Synthetic event during the subscription gap',
    requestId: 'sse-gap',
    source: 'observation',
    bubble: true,
  });
  releaseEvents();
  await avatarPage
    .locator('.messages')
    .getByText('Synthetic event during the subscription gap', { exact: true })
    .waitFor({ state: 'attached' });
  await avatarPage.close();
  for (const view of [
    'Files',
    'Assets',
    'Agenda',
    'Care',
    'Mail',
    'Scheduler',
    'Backup',
    'Notifications',
    'Approvals',
    'Channels',
  ]) {
    await go(view);
    await page.locator('.page-content h1').waitFor();
  }
  const workflows = await productWorkflows(page, app);
  const library = await libraryWorkflows(page, app, runtime);
  const inference = await inferenceWorkflows(page, app);
  const audit = await auditWorkbench(page, app);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '放弃修改并离开', exact: true }).click();
  await page.locator('dialog.workspace-drawer').waitFor({ state: 'hidden' });
  await go('personas');
  await page.locator('.role-tile').first().waitFor();
  if (await page.locator('[data-view="memory"]').count())
    throw Error('Memory appeared before opening a character');
  await page.getByRole('button', { name: '＋ 新角色', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('Synthetic second character');
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.locator('.role-heading').getByText('Synthetic second character').waitFor();
  await page.locator('[data-view="avatar"]').click();
  await page.getByRole('heading', { name: '桌宠展示', exact: true }).waitFor();
  await go('observation');
  await page.getByRole('button', { name: '＋ 新观察任务', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('Synthetic second task');
  const second = app.store
    .documents<{ id: string; name: string }>('personas')
    .find((role) => role.name === 'Synthetic second character')!;
  await page.locator('#view-observation select').first().selectOption(second.id);
  await page
    .locator('#view-observation textarea')
    .first()
    .fill('Synthetic task-only vision prompt');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.locator('.observation-task').getByText('Synthetic second task').waitFor();
  if (
    !app.observations
      .configurations()
      .some(
        (task) =>
          task.personaId === second.id &&
          task.observationPrompt === 'Synthetic task-only vision prompt' &&
          !task.enabled,
      )
  )
    throw Error('Observation did not save a role-owned task with its own prompt');
  if (errors.length) throw Error(errors.join('\n'));
  const report = {
    passed: true,
    audit,
    roleWorkspaceAndObservationTask: true,
    workflows,
    library,
    inference,
    views: sections.flatMap((s) => s.views).length,
    calendar: 'created through date + button',
    approval: 'frontend only, executed once',
    libraryExport: true,
    chat: 'generated once',
    memory: 'injected',
    review: 'completed',
    capture: 'remained disabled',
    browserErrors: errors.length,
    subscriptionGapRecovered: true,
    runtime,
    defaultTheme: 'light (tested under system dark preference)',
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: 'test-results/ui-last-failure.png' });
  if (errors.length) console.error(errors);
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
