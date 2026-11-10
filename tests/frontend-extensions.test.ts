import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, project, until } from './helpers.ts';
import { z } from 'zod';
import { internal } from '../packages/kernel/registry.ts';
import { navigationSections, isSettingsPage, isWorkspacePage } from '../apps/workbench/src/navigation.ts';

async function fixture(t: Parameters<typeof setup>[0], edit?: (manifest: any) => void) {
  const app = await setup(t, []), root = join(app.runtime, 'workbench-extension');
  await cp(join(project, 'examples/workbench-extension'), root, { recursive: true });
  const path = join(root, 'echo-plugin.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  edit?.(manifest); await writeFile(path, JSON.stringify(manifest));
  await app.extensions.install(root, true); await app.plugins.enable('workbenchdemo');
  return { app, root };
}

test('plugin settings panels reuse the page contract without adding navigation entries', async (t) => {
  const { app } = await fixture(t, (manifest) => {
    manifest.pages.push({ ...manifest.pages[0], id: 'workbenchdemo.options', title: 'Extension options', placement: 'plugin-settings' });
  });
  const pages = await app.frontend.pages();
  assert(pages.some((page) => page.id === 'workbenchdemo.options'));
  assert(!navigationSections(pages).some((section) => section.views.some((view) => view.id === 'workbenchdemo.options')));
  await app.frontend.invoke('workbenchdemo.options', 'workbenchdemo.save', { message: 'Retained setting', count: 2 });
  assert.equal((await app.frontend.invoke('workbenchdemo.options', 'workbenchdemo.read', {})).message, 'Retained setting');
  await app.plugins.disable('workbenchdemo');
  await assert.rejects(app.frontend.invoke('workbenchdemo.options', 'workbenchdemo.read', {}), /不可用/);
});
test('local plugins register pages, sheets and role forms without rebuilding the workbench', async (t) => {
  const { app } = await fixture(t);
  const pages = await app.frontend.pages();
  assert.equal(pages.length, 3);
  assert.equal(navigationSections(pages).find((section) => section.id === 'knowledge')?.views.at(-1)?.id, 'workbenchdemo.dashboard');
  assert(isWorkspacePage('workbenchdemo.notes', pages));
  assert(!isSettingsPage('workbenchdemo.notes', pages));
  const saved = await app.frontend.invoke('workbenchdemo.notes', 'workbenchdemo.save', { message: 'Workspace data', count: 4 });
  assert.equal(saved.count, 4);
  await app.frontend.invoke('workbenchdemo.character', 'workbenchdemo.save', { message: 'Role data' }, 'role-one');
  assert.equal((await app.frontend.invoke('workbenchdemo.character', 'workbenchdemo.read', {}, 'role-one')).message, 'Role data');
  assert.equal((await app.frontend.invoke('workbenchdemo.notes', 'workbenchdemo.read', {})).message, 'Workspace data');
  await assert.rejects(app.frontend.invoke('workbenchdemo.character', 'workbenchdemo.read', {}), /选择角色/);
  const bootstrap = await app.registry.call('system.bootstrap', {}, internal);
  assert.equal(bootstrap.frontend.pages.length, 3);
  await app.plugins.disable('workbenchdemo');
  assert.deepEqual(await app.frontend.pages(), []);
  await assert.rejects(app.frontend.invoke('workbenchdemo.notes', 'workbenchdemo.read', {}), /不可用/);
  await app.plugins.enable('workbenchdemo');
  assert.equal((await app.frontend.pages()).length, 3);
});

test('page calls to another module are revoked when the contributing plugin is unloaded', async (t) => {
  const { app } = await fixture(t, (manifest) => {
    manifest.permissions.push('fixture.wait');
    manifest.pages[1].view.operations.push('fixture.wait');
  });
  let started = false, aborted = false;
  app.registry.register({ name: 'fixture.wait', owner: 'core', description: 'Lifecycle fixture',
    permission: 'fixture.wait', mcp: false, input: z.object({}), output: z.string(),
    run: (_value, _caller, signal) => new Promise((resolve) => {
      started = true;
      signal.addEventListener('abort', () => { aborted = true; resolve('late'); }, { once: true });
    }),
  });
  const pending = app.frontend.invoke('workbenchdemo.dashboard', 'fixture.wait', {});
  const rejected = assert.rejects(pending);
  await until(() => started);
  await app.plugins.disable('workbenchdemo');
  await rejected;
  assert(aborted);
  assert.equal((await app.frontend.pages()).length, 0);
});
test('custom pages cannot use the workbench authority or read outside their package', async (t) => {
  const { app, root } = await fixture(t, (manifest) => {
    manifest.pages[1].view.operations.push('system.status');
    manifest.pages.push({ id: 'workbenchdemo.escape', title: 'Unsafe path', view: { type: 'webview', entry: '../outside.html' } });
    manifest.pages.push({ id: 'workbenchdemo.settings', title: 'Example settings', placement: 'settings', view: manifest.pages[0].view });
  });
  await writeFile(join(root, '..', 'outside.html'), 'SHOULD_NOT_BE_READ');
  await assert.rejects(app.frontend.invoke('workbenchdemo.dashboard', 'system.status', {}), /权限/);
  await assert.rejects(app.frontend.invoke('workbenchdemo.dashboard', 'plugins.enable', {}), /未声明/);
  await assert.rejects(app.frontend.content('workbenchdemo.escape'), /插件目录/);
  const content = await app.frontend.content('workbenchdemo.dashboard');
  assert(content.html?.includes('Echo.call'));
  assert(isSettingsPage('workbenchdemo.settings', await app.frontend.pages()));
});
