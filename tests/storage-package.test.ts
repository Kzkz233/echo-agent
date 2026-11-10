import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zipSync, strToU8 } from 'fflate';
import { temporary, setup } from './helpers.ts';
import { packPlugin, inspectPluginPackage, packagePath } from '../packages/kernel/plugin-package.ts';
import { planStorageMigration, requestStorageMigration, applyStorageMigration, storageLocation } from '../packages/kernel/storage.ts';
import { internal } from '../packages/kernel/registry.ts';

test('storage migration copies offline data, verifies databases and leaves original content unchanged', async (t) => {
  const base = await temporary(t), source = join(base, 'original'), target = join(base, 'new-disk'); await mkdir(source);
  const db = new DatabaseSync(join(source, 'echo.sqlite'));
  db.exec('CREATE TABLE documents(namespace TEXT,id TEXT,data TEXT); CREATE TABLE kv(key TEXT,value TEXT);');
  const originalText = 'Original persona mentions ' + source;
  db.prepare('INSERT INTO documents VALUES(?,?,?)').run('personas', 'fixture', JSON.stringify({ prompt: originalText }));
  db.prepare('INSERT INTO documents VALUES(?,?,?)').run('vaults', 'fixture', JSON.stringify({ path: join(source, 'Libraries', 'fixture') })); db.close();
  await mkdir(join(source, 'credentials')); await writeFile(join(source, 'credentials', 'fixture.secret'), 'opaque-local-secret');
  const baseline = await readFile(join(source, 'echo.sqlite'));
  assert((await planStorageMigration(source, target)).bytes > 0);
  await assert.rejects(planStorageMigration(source, join(source, 'nested')), /不能/);
  await requestStorageMigration(source, target); assert.equal(await storageLocation(source), source);
  assert.equal(await applyStorageMigration(source, source), target); assert.equal(await storageLocation(source), target);
  assert.deepEqual(await readFile(join(source, 'echo.sqlite')), baseline);
  assert.equal(await readFile(join(target, 'credentials', 'fixture.secret'), 'utf8'), 'opaque-local-secret');
  const copied = new DatabaseSync(join(target, 'echo.sqlite'), { readOnly: true });
  try {
    assert.equal(JSON.parse((copied.prepare("SELECT data FROM documents WHERE namespace='personas'").get() as any).data).prompt, originalText);
    assert.equal(JSON.parse((copied.prepare("SELECT data FROM documents WHERE namespace='vaults'").get() as any).data).path, join(target, 'Libraries', 'fixture'));
  } finally { copied.close(); }
});
test('migration failure retains original locator and does not overwrite a destination', async (t) => {
  const base = await temporary(t), source = join(base, 'source'), target = join(base, 'target'); await mkdir(source); await mkdir(target);
  await writeFile(join(source, 'echo.sqlite'), 'invalid database'); await requestStorageMigration(source, target);
  await assert.rejects(applyStorageMigration(source, source)); assert.equal(await storageLocation(source), source);
  assert.equal(await readFile(join(source, 'echo.sqlite'), 'utf8'), 'invalid database');
  await assert.rejects(planStorageMigration(source, target), /必须为空/);
});
test('extension archives install without executing code, validate allowlists and retain rollback', async (t) => {
  const app = await setup(t, []), source = await temporary(t), target = join(source, 'fixture.echo-plugin');
  await writeFile(join(source, 'echo-plugin.json'), JSON.stringify({ apiVersion: 1, id: 'fixture-extension', name: 'Fixture', version: '1.0.0', description: 'Synthetic extension' }));
  await writeFile(join(source, 'main.mjs'), 'throw Error("Must not execute during installation");');
  await writeFile(join(source, 'LICENSE'), 'Synthetic test license');
  await packPlugin(source, target, 'main.mjs', ['LICENSE']);
  const inspected = await inspectPluginPackage(target);
  const installed = await app.extensions.installPackage(target, inspected.sha256);
  assert.equal(installed.requiresRestart, false); assert(!app.plugins.active.has('fixture-extension'));
  await assert.rejects(app.extensions.installPackage(target, 'wrong-hash'), /已变化/);
  assert.equal((await app.extensions.installPackage(target, inspected.sha256)).requiresRestart, true);
  assert.equal(app.extensions.rollbackPackage('fixture-extension').requiresRestart, true);
  for (const path of ['../escape', 'C:/escape', 'bad\\path', 'dir/CON', 'dir/a.']) assert.throws(() => packagePath(path));
  const malicious = join(source, 'bad.echo-plugin'); await writeFile(malicious, zipSync({ '../escape': strToU8('bad') }));
  await assert.rejects(inspectPluginPackage(malicious), /路径/);
  await assert.rejects(packPlugin(source, join(source, 'private.echo-plugin'), 'main.mjs', ['LICENSE', 'echo.sqlite']));
  const components = (await app.registry.call('system.bootstrap', {}, internal)).plugins;
  assert(components.find((p: any) => p.id === 'clock')?.builtin); assert(components.find((p: any) => p.id === 'storage')?.builtin);
  await assert.rejects(app.plugins.disable('clock'), /内建/);
});
