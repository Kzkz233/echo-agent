import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { packPlugin } from '../packages/kernel/plugin-package.ts';
import { Application } from '../apps/server/application.ts';
import { temporary, project } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';

async function fixture(t: Parameters<typeof temporary>[0]) {
  const root = await temporary(t),
    runtime = join(root, 'Data'),
    source = join(root, 'Source');
  await mkdir(source);
  await mkdir(runtime);
  const manifest = {
    apiVersion: 1,
    id: 'optional-demo',
    name: 'Independent extension',
    description: 'Synthetic fixture',
    version: '1.0.0',
    package: 'echo-plugin-optional-demo',
    dependencies: ['knowledge'],
    permissions: ['optional-demo.read', 'ui.contribute'],
    pages: [
      {
        id: 'optional-demo.page',
        title: 'Independent page',
        section: 'knowledge',
        view: { type: 'webview', entry: 'view.html', operations: ['optional-demo.read'] },
      },
    ],
    storagePaths: [{ table: 'documents', collection: 'optional-demo-items', pointers: ['/path'] }],
  };
  await writeFile(join(source, 'echo-plugin.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'LICENSE'), 'Synthetic test license');
  await writeFile(join(source, 'view.html'), '<p>Independent page</p>');
  await writeFile(
    join(source, 'entry.mjs'),
    `export function createPlugin(host) {
    const data = host.dependency('knowledge',1);
    return {manifest:${JSON.stringify(manifest)}, activate(ctx){
      ctx.registry.register({name:'optional-demo.read',owner:'optional-demo',description:'fixture',permission:'optional-demo.read',mcp:false,
        input:{parse:v=>v},output:{parse:v=>v},run:()=>({retained:host.store.get('optional-demo.config',{}),vaults:data.vaults().length})});
    }};
  }`,
  );
  const archive = join(root, 'extension.echo-plugin');
  await packPlugin(source, archive, 'entry.mjs', ['LICENSE', 'view.html'], 'module');
  return { root, runtime, archive };
}

test('independent modules survive core replacement, uninstall, reinstall and missing package files', async (t) => {
  const { runtime, archive } = await fixture(t);
  let app = await Application.create({ runtime, project, plugins: [] });
  try {
    app.store.set('optional-demo.config', { sentinel: 'KEEP_ME' });
    app.store.saveConversation({
      id: 'retained',
      title: 'Retained conversation',
      personaId: 'companion',
      injection: false,
      review: false,
      createdAt: new Date().toISOString(),
    });
    app.store.put('external-mcp-servers', 'fixture', {
      id: 'fixture',
      name: 'Keep external registration',
      enabled: false,
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp',
    });
    const preview = await app.extensions.inspectPackage(archive);
    assert.equal(preview.fullTrust, true);
    assert.equal(
      app.plugins.plugins.has('optional-demo'),
      false,
      'inspection must not execute code',
    );
    const saved = await app.extensions.installPackage(archive, preview.sha256);
    assert.equal(saved.requiresRestart, true);
    app.store.set('plugins.intent', {
      ...app.store.get<object>('plugins.intent', {}),
      'optional-demo': true,
    });
    await app.close();
    app = await Application.create({ runtime, project });
    assert.equal(app.plugins.active.has('optional-demo'), true);
    assert.equal(
      (await app.registry.call('optional-demo.read', {}, internal)).retained.sentinel,
      'KEEP_ME',
    );
    assert((await app.frontend.pages()).some((p) => p.id === 'optional-demo.page'));
    await app.plugins.disable('optional-demo');
    assert.equal((await app.frontend.pages()).length, 0);
    await assert.rejects(app.registry.call('optional-demo.read', {}, internal));
    await app.plugins.enable('optional-demo');
    assert.equal(
      app.store.document('extensions', 'optional-demo'),
      undefined,
      'old cores must not interpret module registrations as process extensions',
    );
    const location = app.store.document<any>('module-extensions', 'optional-demo').directory;
    await app.close();
    await rename(location, location + '-absent');
    app = await Application.create({ runtime, project });
    assert.equal(app.plugins.active.has('optional-demo'), false);
    assert.equal(app.plugins.active.has('knowledge'), true);
    assert.equal(app.store.conversation('retained')?.title, 'Retained conversation');
    assert.equal(
      app.store.document<any>('external-mcp-servers', 'fixture')?.name,
      'Keep external registration',
    );
    await app.extensions.uninstall('optional-demo');
    assert.equal(app.plugins.plugins.has('optional-demo'), false);
    assert.equal(app.store.get<any>('optional-demo.config', {}).sentinel, 'KEEP_ME');
    await app.extensions.installPackage(archive, preview.sha256);
    app.store.set('plugins.intent', {
      ...app.store.get<object>('plugins.intent', {}),
      'optional-demo': true,
    });
    await app.close();
    app = await Application.create({ runtime, project });
    assert.equal(
      (await app.registry.call('optional-demo.read', {}, internal)).retained.sentinel,
      'KEEP_ME',
    );
    await app.extensions.uninstall('optional-demo');
    assert.equal(app.plugins.active.has('knowledge'), true);
    assert.equal(app.store.conversation('retained')?.title, 'Retained conversation');
  } finally {
    await app.close();
  }
});

test('module integrity failure is isolated and does not silently run changed code', async (t) => {
  const { runtime, archive } = await fixture(t);
  let app = await Application.create({ runtime, project, plugins: [] });
  try {
    const inspected = await app.extensions.inspectPackage(archive);
    await app.extensions.installPackage(archive, inspected.sha256);
    const installed = app.store.document<any>('module-extensions', 'optional-demo');
    await writeFile(
      join(installed.directory, 'entry.mjs'),
      'throw Error("TAMPERED_CODE_EXECUTED")',
    );
    app.store.set('plugins.intent', { 'optional-demo': true });
    await app.close();
    app = await Application.create({ runtime, project });
    const status = app.plugins.list().find((p) => p.id === 'optional-demo')!;
    assert.equal(status.state, 'failed');
    assert.match(status.error!, /校验失败/);
    assert(!status.error!.includes('TAMPERED_CODE_EXECUTED'));
    assert.equal(app.plugins.active.has('persona'), true);
  } finally {
    await app.close();
  }
});

test('disabled module packages do not import code or start factories at application startup', async (t) => {
  const { runtime, archive } = await fixture(t);
  let app = await Application.create({ runtime, project, plugins: [] });
  try {
    const preview = await app.extensions.inspectPackage(archive);
    await app.extensions.installPackage(archive, preview.sha256);
    const row = app.store.document<any>('module-extensions', 'optional-demo');
    // An unreadable entry would fail if the loader touched disabled code.
    await rename(join(row.directory, 'entry.mjs'), join(row.directory, 'unavailable.mjs'));
    await app.close();
    app = await Application.create({ runtime, project });
    const plugin = app.plugins.list().find((p) => p.id === 'optional-demo')!;
    assert.equal(plugin.state, 'disabled');
    assert.equal(plugin.enabled, false);
    assert.equal(app.plugins.active.has('persona'), true);
  } finally {
    await app.close();
  }
});
