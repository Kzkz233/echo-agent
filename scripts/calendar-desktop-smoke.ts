import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, symlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { localDay } from '../packages/kernel/time.ts';
import type {Page,Locator} from '@playwright/test';
const project = resolve(import.meta.dirname, '..'),
  exe = resolve(
    process.argv.find((arg) => arg.startsWith('--exe='))?.slice(6) ??
      'apps/desktop/target/release/echo-desktop.exe',
  );
const resource = resolve(
    process.argv.find((arg) => arg.startsWith('--resources='))?.slice(12) ?? 'dist/runtime',
  ),
  blocked = process.argv.includes('--expect-blocked');
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
  'An existing desktop must finish before isolated native acceptance',
);
const root = join(tmpdir(), 'EchoTests');
await mkdir(root, { recursive: true });
const fixture = await mkdtemp(join(root, 'calendar-desktop-')),
  runtime = join(fixture, 'data'),
  stage = join(fixture, 'app');
await mkdir(stage);
await copyFile(exe, join(stage, 'Echo.exe'));
await symlink(resource, join(stage, 'runtime'), 'junction');
const app = await Application.create({ runtime, project, plugins: ['agenda'] }),
  today = localDay(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
  tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
const entry = app.agenda.save({ title: 'Hold and drag this task', date: today });
app.store.set('plugins.intent', { agenda: true });
await app.close();
const listener = createServer();
await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
const port = (listener.address() as any).port;
await new Promise<void>((done) => listener.close(() => done()));
const child = spawn(join(stage, 'Echo.exe'), [], {
  cwd: stage,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    ECHO_DATA_DIR: runtime,
    ECHO_WEBVIEW_DEBUG_PORT: String(port),
    ECHO_WEBVIEW_TEST_DIR: join(fixture, 'webview'),
    WEBVIEW2_USER_DATA_FOLDER: join(fixture, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
});
async function nativeHoldAndDrag(page:Page,source:Locator,target:Locator){
  await target.scrollIntoViewIfNeeded();await source.scrollIntoViewIfNeeded();
  const from=await source.boundingBox(),to=await target.boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));assert(from&&to);
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',join(project,'scripts/native-pointer-drag.ps1'),'-TargetProcessId',String(child.pid),'-ExpectedExecutable',join(stage,'Echo.exe'),'-StartX',String(from.x+Math.min(from.width/2,100)),'-StartY',String(from.y+from.height/2),'-EndX',String(to.x+to.width/2),'-EndY',String(to.y+to.height/2),'-ViewportWidth',String(viewport.width),'-ViewportHeight',String(viewport.height)],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined, connection: any;
const rpc = async (method: string, params: any = {}) => {
  const body = await (
    await fetch(connection.url + '/rpc', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  ).json();
  if (body.error) throw Error(body.error.message);
  return body.result;
};
try {
  for (let i = 0; i < 120; i++) {
    assert.equal(child.exitCode, null, 'Fixture desktop exited');
    try {
      connection = JSON.parse(await readFile(join(runtime, 'connection.json'), 'utf8'));
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 800 });
      break;
    } catch {
      await pause(200);
    }
  }
  assert(browser && connection, 'Native fixture not ready');
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('[data-section="agenda"]').click();
  await page.getByRole('heading', { name: '日历与提醒', exact: true }).waitFor();
  const target = page
    .locator('.calendar-day')
    .filter({ has: page.locator('time[datetime="' + tomorrow + '"]') });
  await nativeHoldAndDrag(
    page,
    page.getByRole('button', { name: 'Hold and drag this task', exact: true }),
    target,
  );
  await pause(700);
  const calendarMoved =
    (await rpc('agenda.list')).find((i: any) => i.id === entry.id).date === tomorrow;
  if (calendarMoved) {
    await page.getByRole('button', { name: '撤销改期', exact: true }).click();
    await pause(250);
  }
  assert.equal(calendarMoved, !blocked);
  if (!blocked)
    assert.equal((await rpc('agenda.list')).find((i: any) => i.id === entry.id).date, today);
  assert.deepEqual(errors, []);
  const report = {
    nativeWebView2: true,
    calendarMoved,
    heldTaskText: true,
    expectedLegacyFailure: blocked,
    errors: 0,
    executable: exe,
  };
  await writeFile(
    join(project, 'test-results/calendar-native' + (blocked ? '-before' : '') + '.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  const page = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((page) => !page.isClosed());
  await page
    ?.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('quit_echo'))
    .catch(() => {});
  await browser?.close().catch(() => {});
  if (connection) await rpc('system.shutdown').catch(() => {});
  await pause(700);
  if (child.exitCode === null) child.kill();
}
