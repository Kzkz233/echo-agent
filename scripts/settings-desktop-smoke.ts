import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';

// Exercise the native window registry, not browser popups. Everything runs with
// fresh data, disabled feature plugins, and a local-only test debugger.
const project = resolve(import.meta.dirname, '..');
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const fixture = await mkdtemp(join(base, 'settings-desktop-'));
const appRoot = join(fixture, 'App');
await mkdir(appRoot);
await cp(join(project, 'apps/desktop/target/release/echo-desktop.exe'), join(appRoot, 'Echo.exe'));
await symlink(join(project, 'dist/runtime'), join(appRoot, 'runtime'), 'junction');
const socket = createServer();
await new Promise<void>((done) => socket.listen(0, '127.0.0.1', done));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((done) => socket.close(() => done()));
const child = spawn(join(appRoot, 'Echo.exe'), [], {
  cwd: appRoot,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    ECHO_DATA_DIR: join(fixture, 'data'),
    ECHO_PLUGINS: '',
    ECHO_WEBVIEW_DEBUG_PORT: String(port),
    ECHO_WEBVIEW_TEST_DIR: join(fixture, 'webview'),
  },
});
const exited = new Promise<void>((done) => child.once('exit', () => done()));
const pause = () => new Promise((done) => setTimeout(done, 100));
async function wait(check: () => Promise<boolean>, message: string, timeout = 30000) {
  const until = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > until) throw Error(message);
    await pause();
  }
}
let browser: Browser | undefined;
try {
  await wait(
    () =>
      fetch(`http://127.0.0.1:${port}/json/version`).then(
        (r) => r.ok,
        () => false,
      ),
    'Isolated WebView did not start',
  );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await wait(async () => context.pages().length > 0, 'Main page missing');
  const main = context.pages()[0];
  const errors: string[] = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  main.on('pageerror', (error) => errors.push(error.message));
  await main.getByRole('button', { name: '设置', exact: true }).waitFor();
  const settingsPages = () => context.pages().filter((p) => p.url().includes('window=settings'));
  const invoke = (command: string, args: Record<string, unknown> = {}) =>
    main.evaluate(
      ({ command, args }) => (window as any).__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  for (let cycle = 0; cycle < 3; cycle++) {
    // This created eight native windows with the same label before the fix.
    await main.evaluate(() =>
      Promise.all(
        Array.from({ length: 8 }, () =>
          (window as any).__TAURI_INTERNALS__.invoke('open_settings', { page: 'plugins' }),
        ),
      ),
    );
    await wait(async () => settingsPages().length > 0, 'Settings did not open');
    assert.equal(
      settingsPages().length,
      1,
      'Concurrent requests created duplicate settings windows',
    );
    const settings = settingsPages()[0];
    await settings.getByRole('heading', { name: '扩展', exact: true }).waitFor();
    assert.deepEqual((await invoke('plugin:window|get_all_windows')).sort(), ['main', 'settings']);
    await invoke('open_settings', { page: 'updates' });
    await settings.getByRole('heading', { name: '版本与更新', exact: true }).waitFor();
    assert.equal(settingsPages().length, 1, 'Settings navigation created another window');
    await invoke('plugin:window|close', { label: 'settings' });
    await wait(async () => settingsPages().length === 0, 'Settings failed to close');
    assert.deepEqual(await invoke('plugin:window|get_all_windows'), ['main']);
  }
  // Also cover the actual sidebar entry and storage failures before native IPC.
  await main.getByRole('button', { name: '设置', exact: true }).click();
  await wait(async () => settingsPages().length === 1, 'Sidebar failed to open settings');
  await settingsPages()[0].getByRole('heading', { name: '扩展', exact: true }).waitFor();
  await invoke('plugin:window|close', { label: 'settings' });
  await wait(async () => settingsPages().length === 0, 'Sidebar settings failed to close');
  await main.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'echo.settings-navigation') {
        (window as any).__settingsFailureInjected = true;
        Storage.prototype.setItem = original;
        throw Error('Synthetic settings storage failure');
      }
      return original.call(this, key, value);
    };
  });
  await main.getByRole('button', { name: '设置', exact: true }).click();
  await wait(
    async () => main.evaluate(() => Boolean((window as any).__settingsFailureInjected)),
    'Failure injection did not run',
  );
  await main
    .getByText('无法打开设置窗口：Synthetic settings storage failure', { exact: true })
    .waitFor();
  assert.equal(settingsPages().length, 0);
  await assert.rejects(invoke('open_settings', { page: '../invalid' }), /Invalid settings page/);
  assert.deepEqual(errors, [], 'Unexpected frontend errors');
  console.log(
    'Native settings: 24 concurrent opens, close/reopen, page reuse, sidebar and failure reporting passed; no model calls.',
  );
  await invoke('quit_echo').catch(() => {});
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(Error('Fixture did not exit')), 15000)),
  ]);
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  console.log('Isolated settings fixture: ' + fixture);
}
