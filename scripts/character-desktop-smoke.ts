import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, copyFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile } from './inference-fixture.ts';

const project = resolve(import.meta.dirname, '..');
const check = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Echo.exe','echo-desktop.exe') } | Select-Object -ExpandProperty ProcessId",
  ],
  { encoding: 'utf8', windowsHide: true },
);
assert.equal(check.status, 0);
assert.equal(
  check.stdout.trim(),
  '',
  'Close the existing Echo desktop before this isolated native acceptance.',
);
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const fixture = await mkdtemp(join(base, 'characters-desktop-'));
const runtime = join(fixture, 'data'),
  stage = join(fixture, 'app');
await mkdir(stage);
await copyFile(
  join(project, 'apps/desktop/target/release/echo-desktop.exe'),
  join(stage, 'Echo.exe'),
);
await symlink(join(project, 'dist/runtime'), join(stage, 'runtime'), 'junction');
let calls = 0;
const fake = createServer(async (req, res) => {
  for await (const _chunk of req) {
    /* Consume the synthetic local request. */
  }
  calls++;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Native fixture response' } }],
    }),
  );
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const app = await Application.create({ runtime, project });
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    name: 'Local fixture API',
    kind: 'api',
    endpoint: `http://127.0.0.1:${(fake.address() as any).port}/v1`,
    model: 'fixture',
  }),
);
await app.registry.call(
  'persona.character.commit',
  {
    requestId: 'fixture-create',
    draft: characterDraft.parse({
      persona: { id: 'fixture-role', name: 'Native Fixture', prompt: 'Fictional test identity' },
      features: [],
      profileId: 'fixture',
    }),
  },
  internal,
);
await app.close();
const listener = createServer();
await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
const port = (listener.address() as any).port;
await new Promise<void>((r) => listener.close(() => r()));
const child = spawn(join(stage, 'Echo.exe'), [], {
  cwd: stage,
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    ECHO_DATA_DIR: runtime,
    ECHO_WEBVIEW_TEST_DIR: join(fixture, 'webview'),
    ECHO_WEBVIEW_DEBUG_PORT: String(port),
    WEBVIEW2_USER_DATA_FOLDER: join(fixture, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let connection: any;
const rpc = async (method: string, params: any = {}) => {
  const response = await fetch(connection.url + '/rpc', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const data: any = await response.json();
  if (data.error) throw Error(data.error.message);
  return data.result;
};
try {
  for (let i = 0; i < 120; i++) {
    assert.equal(child.exitCode, null, 'Fixture desktop exited early');
    try {
      connection = JSON.parse(await readFile(join(runtime, 'connection.json'), 'utf8'));
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      break;
    } catch {
      await pause(200);
    }
  }
  assert(browser && connection, 'Fixture desktop did not become ready');
  const context = browser.contexts()[0];
  let main = context.pages().find((page) => !page.url().includes('window=settings'))!;
  if (!main) main = await context.waitForEvent('page');
  main.setDefaultTimeout(15000);
  const errors: string[] = [];
  main.on('pageerror', (e) => errors.push(e.message));
  await main
    .locator('aside')
    .getByRole('button', { name: /Native Fixture/ })
    .click();
  await main.getByRole('button', { name: '配置角色', exact: true }).waitFor();
  await main.getByRole('button', { name: '设置', exact: true }).click();
  let settings;
  for (let i = 0; i < 80; i++) {
    settings = context.pages().find((page) => page.url().includes('window=settings'));
    if (settings) break;
    await pause(100);
  }
  assert(settings, 'Independent native settings window was not created');
  await settings.getByRole('heading', { name: '插件', exact: true }).waitFor();
  assert.equal(context.pages().filter((page) => page.url().includes('window=settings')).length, 1);
  await main.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('open_settings', { page: 'backends' }),
  );
  await settings.getByRole('heading', { name: '推理后端', exact: true }).waitFor();
  assert.equal(context.pages().filter((page) => page.url().includes('window=settings')).length, 1);
  await settings.screenshot({ path: join(project, 'test-results/character-native-settings.png') });
  await settings
    .evaluate(() =>
      (window as any).__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'settings' }),
    )
    .catch(() => {});
  for (let i = 0; i < 50 && !settings.isClosed(); i++) await pause(100);
  assert(settings.isClosed(), 'Settings did not release its WebView');
  assert(!main.isClosed());
  await rpc('conversations.send', {
    conversationId: 'main-fixture-role',
    text: 'Synthetic native acceptance',
    requestId: 'native-fixture-turn',
  });
  for (let i = 0; i < 100; i++) {
    const runs = await rpc('runs.list');
    if (
      runs.some((run: any) => run.requestId === 'native-fixture-turn' && run.state === 'succeeded')
    )
      break;
    await pause(100);
  }
  assert(
    (await rpc('runs.list')).some(
      (run: any) => run.requestId === 'native-fixture-turn' && run.state === 'succeeded',
    ),
  );
  assert.equal(calls, 1);
  const roles = await rpc('persona.character.read', { id: 'fixture-role' });
  assert.equal(roles.mainConversationId, 'main-fixture-role');
  assert.deepEqual(errors, []);
  const result = {
    nativeSettingsWindow: true,
    reusedSettingsWindow: true,
    settingsClosedMainSurvived: true,
    mainConversationReply: true,
    modelCalls: 'local fixture only',
  };
  await writeFile(
    join(project, 'test-results/character-desktop.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  const page = browser
    ?.contexts()
    .flatMap((c) => c.pages())
    .find((p) => !p.isClosed());
  await page
    ?.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('quit_echo'))
    .catch(() => {});
  await browser?.close().catch(() => {});
  if (connection) await rpc('system.shutdown').catch(() => {});
  await pause(800);
  if (child.exitCode === null) child.kill();
  await new Promise<void>((r) => fake.close(() => r()));
}
