import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';

const runtime = await mkdtemp(join(tmpdir(), 'Echo-extension-smoke-'));
const project = resolve(import.meta.dirname, '..');
const app = await Application.create({ runtime, project, plugins: [] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const bridge = randomUUID();
let frameUrl = '';
const parent = createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:*;");
  if (req.url === '/parent.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(`addEventListener('message', async e => {
      const d = e.data; if (d?.bridge !== ${JSON.stringify(bridge)} || d.type !== 'echo:call' || e.source !== document.querySelector('iframe').contentWindow) return;
      const reply = await fetch('/call', {method:'POST',body:JSON.stringify(d)}).then(r=>r.json());
      e.source.postMessage({type:'echo:result',bridge:d.bridge,id:d.id,...reply},'*');
    });`);
  } else if (req.url === '/call') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { const value = JSON.parse(raw); res.end(JSON.stringify({ result: await app.frontend.invoke('workbenchdemo.dashboard', value.operation, value.input) })); }
    catch (e) { res.end(JSON.stringify({ error: (e as Error).message })); }
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<script src="/parent.js"></script><iframe sandbox="allow-scripts" src="${frameUrl}"></iframe>`);
  }
});
try {
  const extension = join(runtime, 'extension');
  await cp(join(project, 'examples/workbench-extension'), extension, { recursive: true });
  await app.extensions.install(extension, true); await app.plugins.enable('workbenchdemo');
  const mounted = await app.frontend.mount('workbenchdemo.dashboard', bridge);
  frameUrl = `http://127.0.0.1:${http.port}/extension-view/${mounted.ticket}`;
  await new Promise<void>((done) => parent.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(parent.address() as any).port}`);
  const frame = page.frameLocator('iframe');
  await frame.locator('#count').filter({ hasText: /^\d+$/ }).waitFor();
  const original = Number(await frame.locator('#count').textContent());
  await frame.locator('#increment').click();
  await frame.locator('#count').filter({ hasText: new RegExp(`^${original + 1}$`) }).waitFor();
  assert.deepEqual(errors, []);
  assert.equal(await page.frames()[1].evaluate(() => { try { return Boolean(window.parent.document); } catch { return false; } }), false);
  const response = await fetch(frameUrl); assert.equal(response.status, 200);
  assert(response.headers.get('content-security-policy')?.includes("connect-src 'none'"));
  await app.plugins.disable('workbenchdemo');
  assert.equal((await fetch(frameUrl)).status, 409);
  await app.plugins.enable('workbenchdemo');
  assert.equal((await fetch(frameUrl)).status, 409);
  console.log('Isolated HTML extension loaded and completed read/write bridge under a strict parent CSP; cross-frame authority and stale mounts denied.');
} finally {
  await browser?.close(); parent.closeAllConnections();
  await new Promise<void>((done) => parent.close(() => done()));
  await http.close(); await app.close();
  assert(runtime.startsWith(join(tmpdir(), 'Echo-extension-smoke-')));
  await rm(runtime, { recursive: true, force: true });
}
