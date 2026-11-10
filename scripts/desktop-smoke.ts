import{seedProfile,seedRoutes}from'./inference-fixture.ts';
import { validateNativeDesktop } from './desktop-native-steps.ts';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn,spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Application } from '../apps/server/application.ts';
import { profileSchema } from '../packages/contracts/index.ts';

if(process.platform==='win32'){
 const check=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',"Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Echo.exe','echo-desktop.exe') } | Select-Object -ExpandProperty ProcessId"],{encoding:'utf8',windowsHide:true});
 if(check.status!==0)throw Error('Unable to verify desktop test isolation');
 if(check.stdout.trim())throw Error('Another Echo desktop is running. The isolated test will not forward to it.');
}
const project = resolve(import.meta.dirname, '..');
const testBase = join(project, 'test-results', 'runtime');
await mkdir(testBase, { recursive: true });
const runtime = await mkdtemp(join(testBase, 'desktop-'));
const stage = await mkdtemp(join(testBase, 'packaged-ui-'));
await cp(join(project, 'apps/desktop/target/release/echo-desktop.exe'), join(stage, 'Echo.exe'));
// Use the exact resource layout of an installed/portable release.
await mkdir(join(stage, 'runtime'), { recursive: true });
await cp(join(project, 'dist/runtime'), join(stage, 'runtime'), { recursive: true });
let calls = 0;
let visionCalls = 0,
  observationReplies = 0;
const fake = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><title>Allowed Echo entertainment fixture</title><body style="margin:0;background:rgb(20,120,100);color:white;font:32px sans-serif;height:100vh"><h1>Echo fictional entertainment page</h1><p>Visible source for full observation acceptance.</p></body>',
    );
    return;
  }
  let body = '';
  for await (const data of req) body += data;
  const input = JSON.parse(body);
  calls++;
  const vision = input.messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'),
  );
  const observe =
    !vision &&
    input.messages.some((m: any) => JSON.stringify(m.content).includes('SYNTHETIC_OBSERVATION_INTERACTION'));
  if (vision) {
    visionCalls++;
    if (!body.includes('Allowed Echo entertainment fixture') || !body.includes('127.0.0.1'))
      throw Error('Window/source metadata missing from vision request');
  }
  if (observe) observationReplies++;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: vision
              ? JSON.stringify({
                  summary:
                    'Synthetic acceptance: a green entertainment webpage is visible with a heading and explanatory text.',
                  interesting: true,
                })
              : observe
                ? 'Observation acceptance: the visible entertainment page reached this same conversation.'
                : 'Echo desktop test: a shared conversation and a visible bubble.',
          },
        },
      ],
    }),
  );
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const app = await Application.create({ runtime, project });
const profile = profileSchema.parse({
  id: 'synthetic',
  name: 'Local acceptance fixture',
  kind: 'api',
  endpoint: `http://127.0.0.1:${(fake.address() as any).port}/v1`,
  model: 'fixture',
  vision: true,
});
seedProfile(app,profile);
seedRoutes(app, { chat: profile.id, vision: profile.id });
app.store.saveConversation({
  id: 'desktop-fixture',
  title: 'Desktop acceptance',
  personaId: 'companion',
  injection: false,
  review: false,
  createdAt: new Date().toISOString(),
});
app.store.set('avatar.config', { enabled: true, scale: 1, bubbleSeconds: 5, corner: 'left' });
await app.close();
const debugging = createServer();
await new Promise<void>((r) => debugging.listen(0, '127.0.0.1', r));
const debugPort = (debugging.address() as any).port;
await new Promise<void>((r) => debugging.close(() => r()));
const child = spawn(join(stage, 'Echo.exe'), [], {
  cwd: stage,
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    ECHO_DATA_DIR: runtime,
    ECHO_WEBVIEW_TEST_DIR: join(runtime, 'webview'),
    ECHO_WEBVIEW_DEBUG_PORT: String(debugPort),
    WEBVIEW2_USER_DATA_FOLDER: join(runtime, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  },
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let fixtureBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let connection: any;
const rpc = async (method: string, params: any = {}) => {
  const response = await fetch(connection.url + '/rpc', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = (await response.json()) as any;
  if (data.error) throw Error(data.error.message);
  return data.result;
};
try {
  for (let i = 0; i < 100 && !connection; i++) {
    try {
      connection = JSON.parse(await readFile(join(runtime, 'connection.json'), 'utf8'));
    } catch {
      if (child.exitCode !== null) throw Error('Desktop exited before core readiness');
      await pause(100);
    }
  }
  if (!connection) throw Error('Core not ready');
  await validateNativeDesktop({
    project,
    runtime,
    child,
    debugPort,
    rpc,
    pause,
    fake,
    getCounts: () => ({ calls, visionCalls, observationReplies }),
  });
} catch (error) {
  if (connection)
    console.error(
      JSON.stringify({
        observation: (await rpc('system.status').catch(() => ({}))).observation,
        visionCalls,
        observationReplies,
      }),
    );
  throw error;
} finally {
  await fixtureBrowser?.close().catch(() => {});
  if (browser) {
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => !p.isClosed());
    if (page)
      await page
        .evaluate(async () => {
          await (window as any).__TAURI_INTERNALS__.invoke('quit_echo');
        })
        .catch(() => {});
    await browser.close().catch(() => {});
  }
  if (connection) await rpc('system.shutdown').catch(() => {});
  await pause(500);
  if (child.exitCode === null) child.kill();
  await new Promise<void>((r) => fake.close(() => r()));
}
