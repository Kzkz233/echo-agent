import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve, sep } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { buildSchema } from '../packages/contracts/build.ts';
import { fileInventory, jsonFile } from '../packages/kernel/update-files.ts';
import { updateRoot, type UpdatePlan } from '../packages/kernel/update-transaction.ts';
import { Store } from '../packages/kernel/store.ts';
import type { UpdateJournal, UpdateManifest } from '../packages/contracts/update.ts';

const project = resolve(import.meta.dirname, '..'),
  base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const fixture = process.env.ECHO_UPDATE_TEST_REUSE
  ? resolve(process.env.ECHO_UPDATE_TEST_REUSE)
  : await mkdtemp(join(base, 'updates-desktop-'));
assert(fixture.startsWith(resolve(base) + sep) && fixture.includes('updates-desktop-'));
if (process.env.ECHO_UPDATE_TEST_REUSE) {
  const db = new DatabaseSync(join(fixture, 'data/echo.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(
      JSON.parse(
        (db.prepare('SELECT value FROM kv WHERE key=?').get('update.fixture') as any).value,
      ),
      { retained: true },
    );
  } finally {
    db.close();
  }
  const journal = await jsonFile<UpdateJournal>(
    join(updateRoot(join(fixture, 'App')), 'journal.json'),
  );
  assert(
    !journal || ['complete', 'rolled-back', 'failed'].includes(journal.phase),
    'An active update fixture cannot be reused',
  );
}
const appRoot = join(fixture, 'App'),
  data = join(fixture, 'data'),
  parent = updateRoot(appRoot);
const pause = () => new Promise((done) => setTimeout(done, 100));
async function wait(predicate: () => Promise<boolean>, message: string, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw Error(message);
    await pause();
  }
}
async function connection() {
  return jsonFile<{ pid: number; url: string; token: string }>(join(data, 'connection.json'));
}
async function rpc(method: string, params = {}) {
  const current = await connection();
  assert(current);
  const response = await fetch(current.url + '/rpc', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + current.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const value = (await response.json()) as any;
  if (value.error) throw Error(value.error.message);
  return value.result;
}
async function stopFixture() {
  await rpc('system.shutdown').catch(() => {});
  await wait(async () => !(await connection()), 'Fixture backend did not stop', 20000);
  const script = `$root = [IO.Path]::GetFullPath($env:ECHO_UPDATE_TEST_APP); $base = [IO.Path]::GetFullPath($env:ECHO_UPDATE_TEST_BASE); if (!$root.StartsWith($base + '\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test root' }; Get-Process | Where-Object { $_.ProcessName -in @('Echo','echo-desktop') -and $_.Path -and [IO.Path]::GetDirectoryName($_.Path) -eq $root } | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0`;
  const stopped = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, ECHO_UPDATE_TEST_APP: appRoot, ECHO_UPDATE_TEST_BASE: base },
    },
  );
  assert.equal(stopped.status, 0, stopped.stderr);
}
let browser: Browser | undefined,
  success = false;
try {
  if (process.env.ECHO_UPDATE_TEST_REUSE && (await connection())) await stopFixture();
  await mkdir(appRoot, { recursive: true });
  await cp(
    join(project, 'apps/desktop/target/release/echo-desktop.exe'),
    join(appRoot, 'Echo.exe'),
  );
  await cp(join(project, 'dist/runtime'), join(appRoot, 'runtime'), {
    recursive: true,
    dereference: true,
  });
  const info = buildSchema.parse(
    JSON.parse(await readFile(join(appRoot, 'runtime/dist/build-info.json'), 'utf8')),
  );
  const store = new Store(join(data, 'echo.sqlite'));
  store.set('update.fixture', { retained: true });
  store.saveConversation({
    id: 'fixture-main',
    title: 'Update fixture',
    personaId: 'fixture',
    injection: false,
    review: false,
    createdAt: new Date().toISOString(),
  });
  store.append('fixture-main', 'user', 'human', 'Synthetic retained message');
  store.close();
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  const initial = spawn(join(appRoot, 'Echo.exe'), [], {
    cwd: appRoot,
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      ECHO_DATA_DIR: data,
      ECHO_PLUGINS: '',
      ECHO_WEBVIEW_DEBUG_PORT: String(port),
      ECHO_WEBVIEW_TEST_DIR: join(fixture, 'webview'),
    },
  });
  await wait(async () => Boolean(await connection()), 'Initial packaged backend did not start');
  await wait(
    async () =>
      fetch(`http://127.0.0.1:${port}/json/version`).then(
        (response) => response.ok,
        () => false,
      ),
    'Fixture WebView debugger did not start',
  );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await wait(async () => Boolean(browser?.contexts()[0]?.pages()[0]), 'Fixture page unavailable');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => Boolean((window as any).__TAURI_INTERNALS__?.invoke));
  const versions = await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('desktop_info'),
  );
  assert.equal(versions.buildId, info.buildId);
  await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('open_settings', { page: 'updates' }),
  );
  await wait(
    async () =>
      browser!
        .contexts()[0]
        .pages()
        .some((page) => page.url().includes('window=settings')),
    'Settings window unavailable',
  );
  const settings = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes('window=settings'))!;
  await settings.getByRole('heading', { name: '版本与更新', exact: true }).waitFor();
  assert.deepEqual(await settings.locator('.version-card strong').allTextContents(), [
    info.version,
    info.version,
  ]);
  await settings.screenshot({ path: join(project, 'test-results/updates-desktop.png') });
  console.log('Packaged desktop reports matching desktop and backend builds.');
  await rpc('system.lifecycle.dirty', { window: 'synthetic-editor', dirty: true });
  await rpc('system.lifecycle.request', { action: 'restart' });
  await wait(
    async () => (await rpc('system.lifecycle.status')).blockers.includes('有尚未保存的编辑'),
    'Unsaved editor did not block restart',
  );
  assert.equal((await rpc('system.lifecycle.status')).state, 'waiting');
  await rpc('system.lifecycle.cancel');
  await rpc('system.lifecycle.dirty', { window: 'synthetic-editor', dirty: false });
  console.log(
    'Native lifecycle waits for unsaved edits and cancellation restores the current app.',
  );
  const runHelper = async (broken: boolean) => {
    const id = randomUUID(),
      transaction = join(parent, id),
      candidate = join(transaction, 'candidate/app');
    await cp(appRoot, candidate, { recursive: true, dereference: true });
    if (broken)
      await writeFile(
        join(candidate, 'runtime/dist/server.mjs'),
        'throw Error("Synthetic update startup failure");',
      );
    const manifest: UpdateManifest = {
      format: 'echo-update-v1',
      platform: 'win32-x64',
      build: info,
      files: await fileInventory(candidate),
    };
    let errors = '';
    if (broken) {
      // Start from a fully stopped old application and inject a broken startup file.
      const plan: UpdatePlan = {
        format: 'echo-update-plan-v1',
        id,
        appRoot,
        dataRoot: data,
        anchor: data,
        executable: 'Echo.exe',
        before: info,
        manifest,
        desktopPid: initial.pid!,
        backendPid: initial.pid!,
      };
      await writeFile(join(transaction, 'plan.json'), JSON.stringify(plan));
      const helper = spawn(
        join(parent, 'node.exe'),
        [join(parent, 'update-helper.mjs'), transaction],
        {
          cwd: parent,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, ECHO_DATA_DIR: data, ECHO_PLUGINS: '' },
        },
      );
      helper.stderr?.on('data', (chunk) => {
        errors = (errors + chunk.toString()).slice(-3000);
      });
    } else {
      // Package staging is tested separately. This runs the real native handoff,
      // including the backend admission guard and the detached helper startup.
      await writeFile(
        join(parent, 'prepared.json'),
        JSON.stringify({ id, manifest, rollback: false }),
      );
      await page
        .evaluate((id) => (window as any).__TAURI_INTERNALS__.invoke('install_update', { id }), id)
        .catch(() => {});
    }
    await wait(
      async () => Boolean(await jsonFile(join(transaction, 'helper-ready.json'))),
      'Update helper not ready: ' + errors,
    );
    await wait(
      async () => {
        const journal = await jsonFile<UpdateJournal>(join(parent, 'journal.json'));
        return journal?.id === id && ['complete', 'rolled-back', 'failed'].includes(journal.phase);
      },
      'Update helper timed out: ' + errors,
      600000,
    );
    const journal = (await jsonFile<UpdateJournal>(join(parent, 'journal.json')))!;
    assert.equal(journal.phase, broken ? 'rolled-back' : 'complete', JSON.stringify(journal));
    await wait(async () => Boolean(await connection()), 'Updated or restored backend missing');
    assert.equal((await rpc('system.status')).version, info.version);
    const db = new DatabaseSync(join(data, 'echo.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(
        JSON.parse(
          (db.prepare('SELECT value FROM kv WHERE key=?').get('update.fixture') as any).value,
        ),
        { retained: true },
      );
      assert.equal(
        JSON.parse(
          (
            db
              .prepare(
                'SELECT data FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 1',
              )
              .get('fixture-main') as any
          ).data,
        ).text,
        'Synthetic retained message',
      );
    } finally {
      db.close();
    }
    console.log(
      broken
        ? 'Native startup failure restored the previous application and retained conversation data.'
        : 'Native directory swap and frontend/backend readiness confirmation passed.',
    );
  };
  await runHelper(false);
  await browser.close().catch(() => {});
  browser = undefined;
  const beforeRestart = (await connection())!;
  const cli = spawnSync(
    join(appRoot, 'runtime/node.exe'),
    [join(appRoot, 'runtime/dist/cli.mjs'), '--data-dir', data, '--json', 'app', 'restart'],
    { windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).state, 'waiting');
  await wait(
    async () => {
      const next = await connection();
      return !!next && next.pid !== beforeRestart.pid;
    },
    'CLI restart did not launch a new backend',
    90000,
  );
  await wait(
    async () => (await rpc('updates.status')).consistent === true,
    'Restarted desktop/backend mismatch',
  );
  console.log('Packaged CLI safely restarts the real desktop and retains the shared data.');
  await stopFixture();
  await runHelper(true);
  await stopFixture();
  success = true;
} finally {
  await browser?.close().catch(() => {});
  await stopFixture().catch(() => {});
  if (success && resolve(fixture).startsWith(resolve(base) + sep))
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.log('Retained owned test fixture for inspection: ' + fixture);
}
