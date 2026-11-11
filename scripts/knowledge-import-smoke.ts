/** Import UI acceptance with a temporary library and local text parser only. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';

const project = resolve(import.meta.dirname, '..');
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'import-ui-'));
const app = await Application.create({ project, runtime });
await app.plugins.enable('knowledge');
await app.knowledge.save('local', 'Existing manual', 'Synthetic manual', {
  path: 'Work/Manual/Existing.md',
});
const source = join(runtime, 'New manual.md');
await writeFile(source, 'Synthetic import evidence.');
const server = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
try {
  await page.goto(`http://127.0.0.1:${server.port}/?page=knowledge#token=${server.token}`);
  await page.getByRole('button', { name: '展开目录 Work', exact: true }).click();
  await page.getByRole('button', { name: 'Manual', exact: true }).click();
  await page.getByRole('button', { name: '导入原件', exact: true }).click();
  assert.equal(await page.getByLabel('目标目录', { exact: true }).inputValue(), 'Work/Manual');
  await page.getByLabel('目标目录', { exact: true }).fill('Work/Manual/Examples');
  await page.getByRole('textbox', { name: '材料文件路径', exact: true }).fill(source);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.parse-jobs')?.textContent?.includes('已完成'),
  );
  if (!(await page.getByRole('button', { name: '查看条目', exact: true }).isVisible()))
    await page.locator('.parse-jobs summary').click();
  await page.getByRole('button', { name: '查看条目', exact: true }).waitFor();
  const imported = (await app.knowledge.list('local')).find((entry) => entry.source === source);
  assert(imported?.logicalPath?.startsWith('Work/Manual/Examples/'));
  await page.getByRole('button', { name: '查看条目', exact: true }).click();
  await page.getByRole('button', { name: 'Examples', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      selectedFolderDefault: true,
      customNestedFolder: true,
      completionLink: true,
      pageErrors: 0,
    }),
  );
} finally {
  await browser.close();
  await server.close();
  await app.close();
  await rm(runtime, { recursive: true, force: true });
}
