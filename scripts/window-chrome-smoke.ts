import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';

// A real packaged WebView2, isolated data and an invented extension. No model calls.
assert.equal(process.platform, 'win32');
const project = resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(join(tmpdir(), 'Echo-window-chrome-'));
const output = resolve(process.env.ECHO_CHROME_AUDIT_DIR ?? join(fixture, 'results'));
const appRoot = join(fixture, 'App'),
  data = join(fixture, 'data');
await mkdir(appRoot);
await mkdir(output, { recursive: true });
const setup = await Application.create({ runtime: data, project });
await setup.registry.call('preferences.save', { language: 'zh-CN', theme: 'light' }, internal);
await setup.registry.call(
  'persona.character.commit',
  {
    requestId: 'chrome-fixture',
    draft: characterDraft.parse({
      persona: { id: 'chrome-fixture', name: '示例角色', prompt: '隔离界面测试。' },
      features: ['memory', 'delegation'],
      configurations: {},
      tasks: [],
    }),
  },
  internal,
);
const extension = join(fixture, 'extension');
await cp(join(project, 'examples/workbench-extension'), extension, { recursive: true });
await setup.extensions.install(extension, true);
await setup.plugins.enable('workbenchdemo');
await setup.close();
await cp(join(project, 'apps/desktop/target/release/echo-desktop.exe'), join(appRoot, 'Echo.exe'));
await cp(join(project, 'dist/runtime'), join(appRoot, 'runtime'), {
  recursive: true,
  dereference: true,
});
const server = createServer();
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
await new Promise<void>((done) => server.close(() => done()));
const child = spawn(join(appRoot, 'Echo.exe'), [], {
  cwd: appRoot,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    ECHO_DATA_DIR: data,
    ECHO_PLUGINS: 'knowledge,persona,memory,delegation,workbenchdemo',
    ECHO_WEBVIEW_DEBUG_PORT: String(port),
    ECHO_WEBVIEW_TEST_DIR: join(fixture, 'webview'),
  },
});
const wait = async (test: () => Promise<unknown>, message: string, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await test().catch(() => false)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(message);
};
await wait(
  () => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok),
  'WebView not ready',
);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
await wait(async () => context.pages().length, 'Main page unavailable');
const main = context.pages()[0];
const errors: string[] = [];
context.on('page', (page) => page.on('pageerror', (e) => errors.push(e.message)));
main.on('pageerror', (e) => errors.push(e.message));
const invoke = (page: typeof main, command: string, args: object = {}) =>
  page.evaluate(({ command, args }) => (window as any).__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const reports: object[] = [];
try {
  await main.locator('.workbench').waitFor();
  await main
    .locator('.character-navigation')
    .getByRole('button', { name: /示例角色/ })
    .click();
  await main.locator('.role-topbar').waitFor();
  await invoke(main, 'open_settings', { page: 'appearance' });
  await invoke(main, 'open_extension_window', { page: 'workbenchdemo.dashboard' });
  await wait(async () => context.pages().length === 3, 'Three host windows unavailable');
  for (const page of context.pages()) {
    await page.locator('.workbench').waitFor();
    const name = page.url().includes('window=settings')
      ? 'settings'
      : page.url().includes('window=extension')
        ? 'extension'
        : 'main';
    if (name === 'main') {
      // An absolutely positioned unread dot used to protrude beyond the last tab
      // and create a scrollbar even in a wide window.
      await page
        .locator('.topbar [role=tab]')
        .last()
        .evaluate((button) => {
          const dot = document.createElement('span');
          dot.className = 'unread-dot';
          button.append(dot);
        });
      const tabs = await page
        .locator('.topbar .page-sheets')
        .evaluate((e) => ({ client: e.clientWidth, scroll: e.scrollWidth }));
      assert(tabs.scroll <= tabs.client + 1, 'Unread marker overflows a wide header');
    }
    const geometry = await page.locator('.topbar').evaluate((element) => {
      const header = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll('.window-control')].map((button) => {
        const b = button.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      });
      const max = buttons[1],
        scale = devicePixelRatio;
      return {
        header: { y: header.y, h: header.height },
        buttons,
        scale,
        bounds: {
          right: Math.round((innerWidth - max.x - max.w) * scale),
          top: Math.round(max.y * scale),
          width: Math.round(max.w * scale),
          height: Math.round(max.h * scale),
          scale,
        },
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        brands: [...document.querySelectorAll('.app-brand-symbol')].filter(
          (e) => e.getBoundingClientRect().width > 0,
        ).length,
      };
    });
    assert.equal(geometry.header.y, 0);
    assert.equal(geometry.header.h, 65);
    assert.equal(geometry.buttons.length, 3);
    assert.equal(geometry.brands, 1);
    assert.equal(geometry.overflow, false);
    for (const button of geometry.buttons) {
      assert.equal(button.w, 46);
      assert.equal(button.h, 65);
    }
    for (let index = 1; index < geometry.buttons.length; index++)
      assert.equal(geometry.buttons[index].x, geometry.buttons[index - 1].x + 46);
    assert.equal(
      await invoke(page, 'window_chrome_update', { owner: 'audit', bounds: geometry.bounds }),
      true,
    );
    assert.equal(
      await invoke(page, 'window_chrome_update', {
        owner: 'audit',
        bounds: { ...geometry.bounds, top: 300 },
      }),
      false,
    );
    // A stale component's cleanup cannot remove the current caption target.
    assert.equal(
      await invoke(page, 'window_chrome_update', { owner: 'stale', bounds: null }),
      true,
    );
    const controls = page.locator('.window-controls');
    await controls.getByRole('button', { name: '最大化窗口', exact: true }).focus();
    await page.keyboard.press('Enter');
    await controls.getByRole('button', { name: '还原窗口', exact: true }).waitFor();
    await controls.getByRole('button', { name: '还原窗口', exact: true }).focus();
    await page.keyboard.press('Enter');
    await controls.getByRole('button', { name: '最大化窗口', exact: true }).waitFor();
    assert.equal(await page.locator('.window-controls-issue').count(), 0);
    await page.screenshot({ path: join(output, name + '.png') });
    const session = await context.newCDPSession(page);
    for (const [width, scale] of [
      [1048, 1],
      [900, 1.25],
      [760, 1.5],
      ...(name === 'extension' ? [[600, 1]] : []),
    ]) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 720,
        deviceScaleFactor: scale,
        mobile: false,
      });
      const layout = await page.evaluate(() => {
        const header = document.querySelector('.topbar')!.getBoundingClientRect();
        const controls = document.querySelector('.window-controls')!.getBoundingClientRect();
        const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
        const brand = document.querySelector('.wordmark')!.getBoundingClientRect();
        return {
          width: innerWidth,
          header: header.height,
          right: controls.right,
          sidebar: sidebar.width,
          brandY: brand.y,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          text: [
            ...document.querySelectorAll(
              '.sidebar .nav-label,.sidebar .app-wordmark,.sidebar .nav-role-copy',
            ),
          ].filter((e) => e.getBoundingClientRect().width > 0).length,
        };
      });
      assert.equal(layout.header, 65);
      assert.equal(layout.right, width);
      assert.equal(layout.overflow, false);
      if (width <= 780 && name !== 'extension') {
        assert.equal(layout.brandY, 0);
        assert.equal(layout.sidebar, 62);
        assert.equal(layout.text, 0);
      }
      await page.screenshot({ path: join(output, `${name}-${width}-${scale}.png`) });
      reports.push({ name, scale, ...layout });
    }
    await session.send('Emulation.clearDeviceMetricsOverride');
    await session.detach();
    reports.push({ name, ...geometry });
  }
  const tabs = main.locator('.topbar .page-sheets');
  const positions = () =>
    tabs.getByRole('tab').evaluateAll((items) =>
      items.map((e) => {
        const r = e.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }),
    );
  const before = await positions();
  for (const name of ['后台工作会话', '角色资料', '任务', '聊天']) {
    await tabs.getByRole('tab', { name, exact: true }).click();
    await tabs.getByRole('tab', { name, exact: true, selected: true }).waitFor();
    assert.deepEqual(await positions(), before, 'Parent navigation moved on child selection');
  }
  // Simulate a busy status in its reserved slot; it must not move tabs/actions.
  await main.locator('.header-status-slot').evaluate((slot) => {
    slot.innerHTML = '<span class="spinner"></span>';
  });
  assert.deepEqual(await positions(), before);
  const gap = await main.locator('.topbar').evaluate((header) => {
    const tabs = header.querySelector('.page-sheets')!.getBoundingClientRect();
    const actions = header.querySelector('.topbar-actions')!.getBoundingClientRect();
    return actions.left - tabs.right;
  });
  assert(gap >= 0 && gap <= 16, 'Tabs and configuration must stay adjacent');
  const mainLabel = await invoke(main, 'plugin:window|is_maximized', { label: 'main' });
  assert.equal(mainLabel, false);
  await main.locator('.role-topbar').getByRole('button', { name: '配置角色', exact: true }).click();
  const field = main.locator('.character-wizard input:visible').first();
  await field.fill('尚未保存的隔离编辑');
  await main.locator('.window-close').click();
  await main.locator('.confirm-dialog[open]').waitFor();
  await main.locator('.confirm-dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await field.inputValue(), '尚未保存的隔离编辑');
  await main
    .locator('.character-wizard')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await main
    .locator('.confirm-dialog[open]')
    .getByRole('button', { name: '放弃修改并离开', exact: true })
    .click();
  // Leave the fixture available for native pointer/resize/Snap checks when requested.
  await writeFile(
    join(output, 'fixture.json'),
    JSON.stringify({ fixture, appRoot, data, port, pid: child.pid, reports, gap }, null, 2),
  );
  if (process.env.ECHO_CHROME_HOLD === '1') {
    console.log('Native fixture ready: ' + join(output, 'fixture.json'));
    await wait(
      () => access(join(output, 'resume')).then(() => true),
      'Native audit hold expired',
      900000,
    );
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ passed: true, reports, gap, errors }, null, 2),
  );
  // Gracefully exit only this isolated app through its lifecycle coordinator.
  const connection = JSON.parse(await readFile(join(data, 'connection.json'), 'utf8'));
  await fetch(connection.url + '/rpc', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'system.lifecycle.request',
      params: { action: 'stop' },
    }),
  });
  console.log(JSON.stringify({ passed: true, output, windows: reports.length, gap, errors }));
} catch (error) {
  await main.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  // Failure cleanup is confined to this newly created, disposable fixture.
  for (const page of context.pages())
    await invoke(page, 'report_dirty', { dirty: false }).catch(() => {});
  const connection = await readFile(join(data, 'connection.json'), 'utf8').then(
    JSON.parse,
    () => null,
  );
  if (connection)
    await fetch(connection.url + '/rpc', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'system.lifecycle.request',
        params: { action: 'stop' },
      }),
    }).catch(() => {});
  await invoke(main, 'quit_echo').catch(() => {});
  await browser.close();
  await wait(async () => child.exitCode !== null, 'Isolated desktop did not exit', 20000);
}
