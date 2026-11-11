/** Isolated UI acceptance. No real credentials, model calls or user conversations. */
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

const project = resolve(import.meta.dirname, '..'),
  base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'scroll-'));
const app = await Application.create({ project, runtime });
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    name: 'Synthetic',
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
  { profileId: 'fixture', requestId: 'scroll-fixture' },
  internal,
);
const id = app.store.document<any>('characters', 'example-hina')!.mainConversationId;
for (let i = 0; i < 160; i++)
  app.store.append(
    id,
    i % 2 ? 'assistant' : 'user',
    i % 2 ? 'chat' : 'human',
    'Synthetic message ' +
      i +
      '\n\n' +
      'A paragraph of synthetic conversation content.\n\n'.repeat(6),
    undefined,
    { delivery: { source: 'human', targets: [{ id: 'core.chat', ready: true }] } },
  );
const server = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const bottom = () =>
  page.waitForFunction(() => {
    const el = document.querySelector('.messages') as HTMLElement;
    return (
      !!el &&
      el.scrollHeight > el.clientHeight + 500 &&
      el.scrollHeight - el.scrollTop - el.clientHeight < 4
    );
  });
try {
  await page.goto(
    `http://127.0.0.1:${server.port}/?page=character-session&persona=example-hina#token=${server.token}`,
  );
  await bottom();
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await bottom();
  await page.locator('.messages').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(100);
  await page.getByRole('tab', { name: '后台工作会话', exact: true }).click();
  await bottom();
  // Late layout growth must stay anchored, even without a new message event.
  await page.locator('.message-list-content').evaluate((el) => {
    const block = document.createElement('div');
    block.style.height = '600px';
    block.dataset.fixture = 'late-layout';
    el.append(block);
  });
  await bottom();
  await page.locator('.messages').evaluate((el) => {
    el.scrollTop = 120;
  });
  await page.waitForTimeout(100);
  const oldTop = await page.locator('.messages').evaluate((el) => el.scrollTop);
  app.store.append(id, 'assistant', 'chat', 'Synthetic new arrival', undefined, {
    delivery: { source: 'human', targets: [{ id: 'core.chat', ready: true }] },
  });
  app.events.emit('message.posted', { conversationId: id });
  await page.getByText('Synthetic new arrival', { exact: true }).waitFor();
  assert(Math.abs((await page.locator('.messages').evaluate((el) => el.scrollTop)) - oldTop) < 4);
  await page.getByRole('button', { name: '回到最新消息 ↓', exact: true }).click();
  await bottom();
  assert.equal(backend.calls.length, 0);
  assert.deepEqual(errors, []);
  await mkdir(join(project, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(project, 'test-results/conversation-scroll.png') });
  const result = {
    initialLatest: true,
    surfaceSwitchLatest: true,
    lateLayoutAnchored: true,
    readingHistoryPreserved: true,
    latestButton: true,
    inferenceCalls: 0,
    pageErrors: 0,
  };
  await writeFile(join(project, 'test-results/conversation-scroll.json'), JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await server.close();
  await app.close();
}
