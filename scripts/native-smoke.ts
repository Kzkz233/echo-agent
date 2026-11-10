import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { StdioRpc } from '../packages/backends/rpc.ts';
import { spawnSync } from 'node:child_process';
import { showFixture } from './windows-fixture.ts';
const root = resolve(import.meta.dirname, '..');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    req.url?.includes('private')
      ? '<!doctype html><title>Private fixture</title><body style="margin:0;background:#ff00ff;height:100vh"><h1>PRIVATE OVERLAY — NEVER CAPTURE</h1></body>'
      : `<!doctype html><title>Allowed fixture</title><body style="margin:0;background:rgb(20,120,100);color:white;height:100vh;font:32px sans-serif"><h1>Echo authorized test page</h1><p>Only this committed webpage is allowed.</p><iframe title="Denied embedded source" src="http://localhost:${(server.address() as any).port}/private" style="width:340px;height:220px;border:0"></iframe></body>`,
  );
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port;
const browser = await chromium.launch({
  channel: 'msedge',
  headless: false,
  args: ['--window-position=50,50', '--window-size=1100,800', '--force-renderer-accessibility'],
});
const rpc = new StdioRpc(
  process.env.ECHO_NATIVE_TEST_PATH ?? join(root, 'native/target/release/echo-native.exe'),
  [],
  root,
);
try {
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/allowed`);
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: 50, top: 50, width: 1100, height: 800 },
  });
  const deniedContext = await browser.newContext({ viewport: null });
  const denied = await deniedContext.newPage();
  await denied.goto(`http://localhost:${port}/private`);
  const cdp2 = await deniedContext.newCDPSession(denied);
  const window2 = await cdp2.send('Browser.getWindowForTarget');
  await cdp2.send('Browser.setWindowBounds', {
    windowId: window2.windowId,
    bounds: { left: 500, top: 230, width: 800, height: 550 },
  });
  await new Promise((r) => setTimeout(r, 1000));
  await showFixture(browser, 'Allowed fixture');
  await showFixture(browser, 'Private fixture');
  const allowlist = [{ id: 'fixture', type: 'website', value: '127.0.0.1', enabled: true }];
  const browserAllowlist = [
    { id: 'edge', name: 'Microsoft Edge', type: 'process', value: 'msedge.exe', enabled: true },
  ];
  const probe = await rpc.call('probe', { allowlist, browserAllowlist }, 20000);
  if (!probe.allowed) {
    if (process.env.ECHO_NATIVE_TEST_PATH)
      console.log(JSON.stringify(await rpc.call('diagnose', {}, 10000)));
    throw Error('Committed browser document was not authorized: ' + JSON.stringify(probe));
  }
  if (probe.sources.some((s: any) => !s.source.startsWith(`http://127.0.0.1:${port}/`)))
    throw Error('Unknown website admitted');
  const capture = await rpc.call(
    'capture',
    { allowlist, browserAllowlist, proof: probe.proof, width: 1120, quality: 90 },
    20000,
  );
  if (!capture.allowed) throw Error('Capture invalidated: ' + JSON.stringify(capture));
  const jpeg = Buffer.from(capture.jpeg, 'base64');
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  let magenta = 0,
    green = 0,
    black = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 180 && b > 160 && g < 100) magenta++;
    if (g > 70 && g > r * 2 && b > 30) green++;
    if (r < 10 && g < 10 && b < 10) black++;
  }
  if (magenta > 20) throw Error('Private overlay leaked into capture');
  if (green < 500) throw Error('Allowed page content not captured');
  if (black < 500) throw Error('Mask missing');
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results/native-mask.jpg'), jpeg);
  let resources: unknown;
  if (process.env.ECHO_MEASURE_CAPTURE === '1') {
    const sample = () =>
      JSON.parse(
        spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Get-Process -Id ${rpc.child.pid} | Select-Object CPU,WorkingSet64 | ConvertTo-Json -Compress`,
          ],
          { encoding: 'utf8', windowsHide: true },
        ).stdout,
      );
    const first = sample(),
      started = performance.now();
    let captures = 0,
      bytes = 0,
      probes = 0;
    for (let i = 0; i < 20; i++) {
      const p = await rpc.call('probe', { allowlist, browserAllowlist }, 20000);
      probes++;
      if (i % 5 === 0 && p.allowed) {
        const c = await rpc.call(
          'capture',
          { allowlist, browserAllowlist, proof: p.proof, width: 840, quality: 75 },
          20000,
        );
        if (c.allowed) {
          captures++;
          bytes += Buffer.from(c.jpeg, 'base64').length;
        }
      }
      await new Promise((r) =>
        setTimeout(r, Math.max(0, 1000 * (i + 1) - (performance.now() - started))),
      );
    }
    const last = sample(),
      seconds = (performance.now() - started) / 1000;
    resources = {
      seconds,
      probes,
      captures,
      cpuCorePercent: ((last.CPU - first.CPU) / seconds) * 100,
      rssMB: last.WorkingSet64 / 1048576,
      averageFrameBytes: captures ? bytes / captures : 0,
    };
    await writeFile(
      join(root, 'test-results/capture-resources.json'),
      JSON.stringify(resources, null, 2),
    );
  }
  console.log(
    JSON.stringify({
      browserDocumentVerified: true,
      unauthorizedIframeMasked: true,
      privateOverlayPixels: magenta,
      authorizedPixels: green,
      maskedPixels: black,
      signatureBytes: Buffer.from(probe.signature, 'base64').length,
      resources,
    }),
  );
} finally {
  rpc.close();
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
