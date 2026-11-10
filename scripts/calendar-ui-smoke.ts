import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { localDay } from '../packages/kernel/time.ts';
import { holdAndDrag } from './agenda-drag-steps.ts';
const project = resolve(import.meta.dirname, '..'),
  root = join(tmpdir(), 'EchoTests');
await mkdir(root, { recursive: true });
const runtime = await mkdtemp(join(root, 'calendar-ui-')),
  app = await Application.create({
    runtime,
    project,
    plugins: ['agenda'],
  });
const today = localDay(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
  tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10);
const item = app.agenda.save({
  title: 'Movable fixture',
  date: today,
});
const http = await serve(app, { webRoot: join(project, 'dist/web') }),
  browser = await chromium.launch({ channel: 'msedge', headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${http.port}/?page=agenda#token=${http.token}`);
  await page.getByRole('heading', { name: '日历与提醒', exact: true }).waitFor();
  const target = page
    .locator('.calendar-day')
    .filter({ has: page.locator('time[datetime="' + tomorrow + '"]') });
  await holdAndDrag(
    page,
    page.getByRole('button', { name: 'Movable fixture', exact: true }),
    target,
  );
  await page.getByRole('button', { name: '撤销改期', exact: true }).waitFor();
  assert.equal(app.store.document<any>('agenda', item.id).date, tomorrow);
  await page.getByRole('button', { name: '撤销改期', exact: true }).click();
  await page.getByRole('button', { name: 'Movable fixture', exact: true }).waitFor();
  assert.equal(app.store.document<any>('agenda', item.id).date, today);
  assert.deepEqual(errors, []);
  const report = {
    calendarDrag: true,
    undo: true,
    errors: 0,
  };
  await writeFile(join(project, 'test-results/calendar-ui.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: join(project, 'test-results/calendar-ui-failure.png') });
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
