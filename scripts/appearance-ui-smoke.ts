import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile } from './inference-fixture.ts';

// This audit creates only invented content in an isolated runtime. No inference,
// personal configuration, installed libraries, or external services are inputs.
const project = resolve(import.meta.dirname, '..');
const runtime = await mkdtemp(join(tmpdir(), 'Echo-appearance-'));
const output = resolve(process.env.ECHO_UI_AUDIT_DIR ?? join(project, 'test-results/appearance'));
await mkdir(output, { recursive: true });
const app = await Application.create({ runtime, project });
for (const id of [
  'agenda',
  'mail',
  'documents',
  'semantic',
  'notifications',
  'approvals',
  'backup',
  'qq',
])
  await app.plugins.enable(id);
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    name: '示例模型',
    model: 'example-model',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    vision: true,
  }),
);
const portrait =
  'data:image/webp;base64,' +
  (
    await readFile(
      join(project, 'apps/workbench/public/assets/starter-characters/hina/portrait.webp'),
    )
  ).toString('base64');
await app.registry.call(
  'persona.character.commit',
  {
    requestId: 'appearance-role',
    draft: characterDraft.parse({
      persona: { id: 'design-demo', name: 'Hina', prompt: '用于界面验收的虚构角色。', portrait },
      profileId: 'fixture',
      features: ['memory', 'delegation', 'review', 'observation'],
      configurations: {},
      tasks: [],
    }),
  },
  internal,
);
const role = await app.registry.call('persona.character.read', { id: 'design-demo' }, internal);
// Match the approved preview's content and reading measure as well as its palette.
// All of this content belongs to this temporary fixture, never a user's runtime.
app.store.remove('personas', 'companion');
await app.registry.call(
  'persona.character.commit',
  {
    requestId: 'appearance-second-role',
    draft: characterDraft.parse({
      persona: {
        id: 'design-reader',
        name: 'Miyu',
        prompt: '用于界面验收的虚构角色。',
        portrait:
          'data:image/webp;base64,' +
          (
            await readFile(
              join(project, 'apps/workbench/public/assets/starter-characters/miyu/portrait.webp'),
            )
          ).toString('base64'),
      },
      profileId: 'fixture',
      features: [],
      configurations: {},
      tasks: [],
    }),
  },
  internal,
);
const day = new Date();
day.setHours(0, 0, 0, 0);
const lines: { role: 'user' | 'assistant'; text: string; minutes: number; parts?: string[] }[] = [
  { role: 'user', text: '这周收了不少阅读笔记，想找时间理一理。', minutes: -204 },
  { role: 'assistant', text: '先收着就好，想整理的时候我们再一起看。', minutes: -203 },
  { role: 'user', text: '帮我整理一下重复的内容，先给我一个简短清单？', minutes: 582 },
  {
    role: 'assistant',
    text: '',
    minutes: 583,
    parts: [
      '整理好了，主要是「注意力」「休息」「工作节奏」这三个主题。',
      '重复的观点放在一起了。另有两条笔记的说法不太一致，我先保留原文，等你决定。',
    ],
  },
  { role: 'user', text: '好。周末想把这些先放一放，去看个展。', minutes: 584 },
  {
    role: 'assistant',
    text: '那就给周末留一点空白。清单放在这里，先去看你想看的那场展，回来再接着聊。',
    minutes: 584,
  },
];
for (const line of lines) {
  const message = app.store.append(
    role.mainConversationId,
    line.role,
    'chat',
    line.parts?.join('\n\n') ?? line.text,
    undefined,
    {
      replyPhase: 'final',
      deliveryChannelId: 'core.chat',
      ...(line.parts ? { replyParts: line.parts } : {}),
    },
  );
  message.createdAt = new Date(day.getTime() + line.minutes * 60_000).toISOString();
  app.store.db
    .prepare('UPDATE messages SET data=? WHERE id=?')
    .run(JSON.stringify(message), message.id);
}
const vault = app.files.roots().find((v) => !v.owner)!;
await app.knowledge.save(
  vault.id,
  '把休息当作一天的一部分',
  '有时候，一天结束时的疲惫并不来自做了太多事，而是注意力一直没有真正停下来。\n\n## 值得留下的想法\n\n- 给没有明确产出的时间留出位置。\n- 散步和看展，也可以是重新看待日常的方式。',
  { path: '阅读札记/休息.md' },
);
await app.knowledge.save(vault.id, '本周阅读笔记整理', '三个主题：注意力、休息和工作节奏。', {
  path: '阅读札记/本周.md',
});
const extension = join(runtime, 'extension');
await cp(join(project, 'examples/workbench-extension'), extension, { recursive: true });
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  colorScheme: 'light',
});
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = `http://127.0.0.1:${http.port}`;
const open = async (query: string) => {
  await page.goto(base + '/?' + query + '#token=' + http.token);
  await page.locator('.workbench').waitFor();
};
const appearance = async () => {
  await page.getByRole('button', { name: '外观与语言', exact: true }).click();
  await page.locator('.appearance-dialog[open]').waitFor();
};
const closeAppearance = () =>
  page.locator('.appearance-dialog').getByRole('button', { name: '完成', exact: true }).click();
const reports: object[] = [];
try {
  for (const theme of ['light', 'dark'] as const) {
    await app.registry.call(
      'preferences.save',
      { language: 'zh-CN', accent: '#1f647a', theme },
      internal,
    );
    for (const [name, query] of [
      ['chat', 'persona=design-demo'],
      ['session', 'persona=design-demo&page=character-session'],
      ['knowledge', 'workspace=true&page=knowledge'],
      ['agenda', 'workspace=true&page=agenda'],
      ['automation', 'workspace=true&page=automation'],
      ['notifications', 'workspace=true&page=notifications'],
      ['models', 'window=settings&page=backends'],
      ['extensions', 'window=settings&page=plugins'],
      ['appearance', 'window=settings&page=appearance'],
      ['maintenance', 'window=settings&page=updates'],
      ['role-editor', 'persona=design-demo&page=character-wizard'],
    ]) {
      await open(query);
      await page.waitForFunction(
        (mode) => document.documentElement.dataset.echoTheme === mode,
        theme,
      );
      if (name === 'chat') {
        await page.locator('.dialogue-avatar').first().waitFor();
        assert((await page.locator('.dialogue-bubble').count()) >= 2);
      }
      await page.screenshot({ path: join(output, `${name}-${theme}.png`) });
      const geometry = await page
        .locator('.workbench')
        .evaluate((root) => ({ width: root.clientWidth, scroll: root.scrollWidth }));
      assert(geometry.scroll <= geometry.width + 1, JSON.stringify({ name, theme, geometry }));
      reports.push({ name, theme, ...geometry });
    }
  }
  // Shared sandbox styles update in place, including explicit/system appearance.
  await app.extensions.install(extension, true);
  await app.plugins.enable('workbenchdemo');
  await open('workspace=true&page=workbenchdemo.dashboard');
  const frame = page.frameLocator('.plugin-webview');
  await frame.locator('#count').filter({ hasText: /^\d+$/ }).waitFor();
  await frame.locator('#message').evaluate((node) => {
    node.textContent = 'Unsaved local page state';
    (window as any).appearanceMount = 'retained';
  });
  const beforeCount = await frame.locator('#count').textContent();
  await appearance();
  const modal = page.locator('.appearance-dialog');
  await modal.getByRole('button', { name: '浅色', exact: true }).click();
  await frame.locator('html[data-echo-theme=light]').waitFor();
  await modal.getByRole('button', { name: '深色', exact: true }).click();
  await frame.locator('html[data-echo-theme=dark]').waitFor();
  assert.equal(
    await frame.locator('body').evaluate(() => (window as any).appearanceMount),
    'retained',
  );
  assert.equal(await frame.locator('#message').textContent(), 'Unsaved local page state');
  assert.equal(await frame.locator('#count').textContent(), beforeCount);
  await modal.getByLabel('聊天字号', { exact: true }).selectOption('17');
  await modal.getByLabel('增强界面对比', { exact: true }).check();
  await modal.getByLabel('减少动态效果', { exact: true }).check();
  await closeAppearance();
  await frame.locator('#increment').click();
  assert.equal(Number(await frame.locator('#count').textContent()), Number(beforeCount) + 1);
  await page.screenshot({ path: join(output, 'extension-dark.png') });
  // Other senders cannot replace host tokens or gain access to parent authority.
  const fg = await frame
    .locator('body')
    .evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text'));
  await frame.locator('body').evaluate(() => {
    postMessage(
      {
        type: 'echo:theme',
        bridge: 'forged',
        appearance: { version: 1, mode: 'light', tokens: { '--text': '#ff0000' } },
      },
      '*',
    );
  });
  assert.equal(
    await frame
      .locator('body')
      .evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text')),
    fg,
  );
  assert.equal(
    await frame.locator('body').evaluate(() => {
      try {
        return !!parent.document;
      } catch {
        return false;
      }
    }),
    false,
  );
  await appearance();
  await page
    .locator('.appearance-dialog')
    .getByRole('button', { name: '跟随系统', exact: true })
    .click();
  await closeAppearance();
  await page.emulateMedia({ colorScheme: 'light' });
  await frame.locator('html[data-echo-theme=light]').waitFor();
  await page.emulateMedia({ colorScheme: 'dark' });
  await frame.locator('html[data-echo-theme=dark]').waitFor();
  await page.emulateMedia({ colorScheme: 'light' });
  await app.plugins.disable('workbenchdemo');
  await app.registry.call(
    'preferences.save',
    {
      language: 'zh-CN',
      accent: '#1f647a',
      theme: 'light',
      chatFontSize: 15,
      uiFontSize: 14,
      highContrast: false,
      reducedMotion: false,
    },
    internal,
  );
  await page.setViewportSize({ width: 1048, height: 814 });
  await open('persona=design-demo');
  await page.locator('.dialogue-bubble').last().waitFor();
  const alignment = await page.evaluate(() => {
    const header = document.querySelector('.role-topbar')!.getBoundingClientRect();
    const logo = document.querySelector('.wordmark')!.getBoundingClientRect();
    const tab = document
      .querySelector('.role-topbar [aria-selected=true]')!
      .getBoundingClientRect();
    return {
      sidebar: document.querySelector('.sidebar')!.getBoundingClientRect().width,
      header: header.height,
      logo: logo.height,
      tabBottom: tab.bottom,
      headerBottom: header.bottom,
      centerDelta: Math.abs((tab.top + tab.bottom) / 2 - (header.top + header.bottom) / 2),
    };
  });
  assert.equal(alignment.sidebar, 190);
  assert.equal(alignment.header, 65);
  assert.equal(alignment.logo, 65);
  assert(Math.abs(alignment.tabBottom - alignment.headerBottom) <= 2, JSON.stringify(alignment));
  assert(alignment.centerDelta <= 2, JSON.stringify(alignment));
  const metrics = await page.evaluate(() => {
    const values: Record<
      string,
      {
        x: number;
        y: number;
        width: number;
        height: number;
        font: string;
        lineHeight: string;
        weight: string;
        padding: string;
        margin: string;
        borderRadius: string;
      }
    > = {};
    for (const selector of [
      '.sidebar',
      '.topbar',
      '.wordmark',
      '.brand-mark',
      '.nav-item:has(.nav-role-copy)',
      '.nav-role-copy strong',
      '.nav-role-copy small',
      '.nav-item:not(:has(.role-initial))',
      '.dialogue-bubble',
      '.composer',
      '.composer textarea',
    ]) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const box = node.getBoundingClientRect(),
        css = getComputedStyle(node);
      values[selector] = {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        font: css.fontSize,
        lineHeight: css.lineHeight,
        weight: css.fontWeight,
        padding: css.padding,
        margin: css.margin,
        borderRadius: css.borderRadius,
      };
    }
    return values;
  });
  assert.equal(metrics['.nav-item:has(.nav-role-copy)'].height, 59);
  assert.equal(metrics['.nav-role-copy strong'].font, '14px');
  assert.equal(metrics['.nav-role-copy small'].font, '12px');
  assert.equal(metrics['.dialogue-bubble'].font, '15px');
  assert.equal(metrics['.dialogue-bubble'].lineHeight, '26.25px');
  assert.equal(metrics['.dialogue-bubble'].width, 313);
  assert.equal(metrics['.composer'].width, 646);
  assert(Math.abs(metrics['.composer'].height - 55.25) < 1);
  await writeFile(join(output, 'actual-metrics.json'), JSON.stringify(metrics, null, 2));
  await page.screenshot({ path: join(output, 'reference-chat-1048.png') });
  await page
    .locator('.role-topbar')
    .screenshot({ path: join(output, 'reference-header-1048.png') });
  await open('workspace=true&page=knowledge');
  await page.locator('.document-row').first().click();
  await page.locator('.document-reader h2').waitFor();
  await page.screenshot({ path: join(output, 'reference-knowledge-1048.png') });
  await open('window=settings&page=appearance');
  await page.screenshot({ path: join(output, 'reference-settings-1048.png') });
  for (const width of [1080, 810, 540, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, query] of [
      ['chat', 'persona=design-demo'],
      ['knowledge', 'workspace=true&page=knowledge'],
      ['appearance', 'window=settings&page=appearance'],
    ]) {
      await open(query);
      const geometry = await page
        .locator('.workbench')
        .evaluate((root) => ({ width: root.clientWidth, scroll: root.scrollWidth }));
      assert(geometry.scroll <= geometry.width + 2, JSON.stringify({ name, width, geometry }));
      if (width === 390) await page.screenshot({ path: join(output, `${name}-narrow.png`) });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        views: 11,
        themes: 2,
        liveExtensionTheme: true,
        noRemount: true,
        systemAppearance: true,
        narrowWidths: 4,
        alignment,
        reports,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      views: 11,
      themes: 2,
      liveExtensionTheme: true,
      noRemount: true,
      systemAppearance: true,
      narrowWidths: 4,
      errors,
    }),
  );
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') });
  console.log((await page.locator('body').innerText()).slice(-1600));
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
