import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { createUpdatePackage } from './update-package.ts';
import type { BuildInfo } from '../packages/contracts/build.ts';

const project = resolve(import.meta.dirname, '..');
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const fixture = await mkdtemp(join(base, 'updates-ui-'));
const runtime = join(fixture, 'data');
const app = await Application.create({ runtime, project, plugins: [] });
const before: BuildInfo = {
  version: '1.0.0',
  edition: 'private',
  buildId: 'fixture-old',
  builtAt: '2026-01-01T00:00:00.000Z',
  dataVersion: 1,
};
Object.assign(app.updates, {
  host: {
    installRoot: join(fixture, 'App'),
    executable: 'Echo.exe',
    desktopPid: process.pid,
    anchor: runtime,
    desktopBuild: before,
  },
  current: before,
});
const portable = join(fixture, 'portable'),
  candidate = { ...before, version: '1.0.1', buildId: 'fixture-new' };
await mkdir(join(portable, 'runtime/dist'), { recursive: true });
for (const [name, text] of [
  ['Echo.exe', 'synthetic'],
  ['runtime/node.exe', 'synthetic'],
  ['runtime/dist/server.mjs', '// synthetic'],
  ['runtime/dist/build-info.json', JSON.stringify(candidate)],
])
  await writeFile(join(portable, name), text);
const archive = join(fixture, 'fixture.echo-update');
await createUpdatePackage(portable, archive);
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    `http://127.0.0.1:${http.port}/?window=settings&page=updates#token=${http.token}`,
  );
  await page.getByRole('heading', { name: '版本与更新', exact: true }).waitFor();
  assert(!/公开版|自用版/.test(await page.locator('.updates-page').innerText()));
  assert.equal(
    await page
      .locator('.version-card strong')
      .allTextContents()
      .then((values) => values.join(',')),
    '1.0.0,1.0.0',
  );
  await page.getByLabel('本地更新包（.echo-update）').fill(archive);
  await page.getByRole('button', { name: '检查更新包', exact: true }).click();
  await page.getByText('已准备就绪 · 1.0.1', { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: '重启并更新', exact: true }).isDisabled());
  await mkdir(join(project, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(project, 'test-results/updates-ui.png'), fullPage: true });
  await app.registry.call('preferences.save', { language: 'en', accent: '#5969c9' }, internal);
  await page.reload();
  await page.getByRole('heading', { name: 'Version & updates', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Application updates', exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'Updates settings, package preparation and English translation passed. Browser connections cannot restart the desktop.',
  );
} catch (error) {
  console.log(await app.updates.status());
  console.log((await page.locator('body').innerText()).slice(-3500));
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
  await rm(fixture, { recursive: true, force: true });
}
