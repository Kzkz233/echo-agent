import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, temporary } from './helpers.ts';
import { internal, defineManifest } from '../packages/kernel/registry.ts';
import { naturalHistory, buildLocalQuery } from '../packages/kernel/search-query.ts';
import { requestStorageMigration, cancelStorageMigration, storageMigrationStatus, applyStorageMigration, storageLocation } from '../packages/kernel/storage.ts';
import { InstanceLock } from '../packages/kernel/instance.ts';
import { packPlugin, inspectPluginPackage } from '../packages/kernel/plugin-package.ts';

test('zero recent-message window never turns into an unbounded conversation query', () => {
  const history = Array.from({ length: 100 }, () => ({ role: 'user', text: '历史秘密词', meta: { kind: 'chat' } }));
  assert.deepEqual(naturalHistory(history, 0), []);
  assert.equal(naturalHistory(history, 4).length, 4);
  assert(!buildLocalQuery('杭州', history, { historyWindow: 0 }).includes('历史'));
});
test('new character defaults use local query construction even if legacy application policy used a model', async (t) => {
  const app = await setup(t, ['memory']);
  app.store.set('memory.config', { planner: true, limit: 6 });
  const catalog = await app.registry.call('persona.character.catalog', {}, internal);
  const defaults = catalog.features.find((feature: any) => feature.id === 'memory').value;
  assert.equal(defaults.planner, false);
  app.store.put('characters', 'existing', { id: 'existing', features: ['memory'], routes: {}, mainConversationId: '' });
  app.store.put('character-settings.memory', 'existing', { planner: true, limit: 6 });
  assert.equal(app.memories.config('existing').planner, true);
});
test('calendar settings cannot reintroduce a private time zone and shared clock changes re-arm reminders', async (t) => {
  const app = await setup(t, ['agenda']);
  await app.registry.call('settings.save', { pluginId: 'clock', value: { timezone: 'America/New_York' } }, internal);
  await app.registry.call('settings.save', { pluginId: 'agenda', value: { allDayReminderHour: 8, timezone: 'Asia/Shanghai' } }, internal);
  assert.equal(app.agenda.config().timezone, 'America/New_York');
  assert.equal(app.store.get<any>('agenda.config', {}).timezone, undefined);
  let rearmed = 0; const original = (app.agenda as any).arm.bind(app.agenda);
  (app.agenda as any).arm = () => { rearmed++; original(); };
  await app.registry.call('settings.save', { pluginId: 'clock', value: { timezone: 'Europe/London' } }, internal);
  assert(rearmed > 0); assert.equal(app.agenda.config().timezone, 'Europe/London');
});
test('migration uses declared paths, rewrites managed model references, retains target lock and can be cancelled', async (t) => {
  const root = await temporary(t), source = join(root, 'source'), target = join(root, 'target'); await mkdir(source);
  const db = new DatabaseSync(join(source, 'echo.sqlite'));
  db.exec('CREATE TABLE documents(namespace TEXT,id TEXT,data TEXT); CREATE TABLE kv(key TEXT,value TEXT);');
  db.prepare('INSERT INTO documents VALUES(?,?,?)').run('profiles', 'model', JSON.stringify({ model: join(source, 'models', 'fixture.gguf'), name: 'Literal ' + source, options: { projector: join(source, 'models', 'projector.gguf') } }));
  db.prepare('INSERT INTO documents VALUES(?,?,?)').run('demo.assets', 'one', JSON.stringify({ files: [{ location: join(source, 'file.png') }], text: source })); db.close();
  await requestStorageMigration(source, target); await cancelStorageMigration(source);
  assert.equal((await storageMigrationStatus(source)).state, 'cancelled'); assert.equal(await applyStorageMigration(source, source), source);
  await requestStorageMigration(source, target, [{ table: 'documents', collection: 'demo.assets', pointers: ['/files/*/location'] }]);
  let retained: InstanceLock | undefined;
  await applyStorageMigration(source, source, (lock) => { retained = lock; });
  assert.equal(await storageLocation(source), target); assert.throws(() => InstanceLock.acquire(target), /已有 Echo/);
  retained!.release();
  const moved = new DatabaseSync(join(target, 'echo.sqlite'), { readOnly: true });
  try {
    const model = JSON.parse((moved.prepare("SELECT data FROM documents WHERE namespace='profiles'").get() as any).data);
    const asset = JSON.parse((moved.prepare("SELECT data FROM documents WHERE namespace='demo.assets'").get() as any).data);
    assert.equal(model.model, join(target, 'models', 'fixture.gguf')); assert.equal(model.options.projector, join(target, 'models', 'projector.gguf'));
    assert.equal(model.name, 'Literal ' + source); assert.equal(asset.files[0].location, join(target, 'file.png')); assert.equal(asset.text, source);
  } finally { moved.close(); }
});
test('plugin package updates reject dependency cycles before replacing the installed version', async (t) => {
  const app = await setup(t, []), source = await temporary(t);
  const manifest = { apiVersion: 1, id: 'audit-plugin', name: 'Audit', version: '1', description: 'Synthetic' };
  await writeFile(join(source, 'main.mjs'), 'throw Error("must never run on install");'); await writeFile(join(source, 'LICENSE'), 'Synthetic test license');
  await writeFile(join(source, 'echo-plugin.json'), JSON.stringify(manifest));
  const first = join(source, 'first.echo-plugin'); await packPlugin(source, first, 'main.mjs', ['LICENSE']);
  const hash = (await inspectPluginPackage(first)).sha256;
  app.plugins.intent.set('audit-plugin', true); // Stale intent cannot implicitly enable a new installation.
  await app.extensions.installPackage(first, hash); assert.equal(app.plugins.intent.get('audit-plugin'), false);
  await writeFile(join(source, 'echo-plugin.json'), JSON.stringify({ ...manifest, version: '2', dependencies: ['audit-plugin'] }));
  const next = join(source, 'next.echo-plugin'); await packPlugin(source, next, 'main.mjs', ['LICENSE']);
  await assert.rejects(app.extensions.installPackage(next, (await inspectPluginPackage(next)).sha256), /循环依赖/);
  assert.equal(app.store.document<any>('extensions', manifest.id).manifest.version, '1');
  assert(!app.store.document('extension-rollback', manifest.id));
  const stage = async (id: string, version: string, dependencies: string[]) => {
    await writeFile(join(source, 'echo-plugin.json'), JSON.stringify({ ...manifest, id, version, dependencies }));
    const file = join(source, `${id}-${version}.echo-plugin`);
    await packPlugin(source, file, 'main.mjs', ['LICENSE']);
    return app.extensions.installPackage(file, (await inspectPluginPackage(file)).sha256);
  };
  await stage('audit-peer', '1', []);
  await stage('audit-plugin', '3', ['audit-peer']); // New manifest is staged; the loaded plugin still has version 1.
  await assert.rejects(stage('audit-peer', '2', ['audit-plugin']), /循环依赖/);
  assert.equal(app.store.document<any>('extensions', 'audit-peer').manifest.version, '1');
  assert.throws(() => app.plugins.validateReplacement(defineManifest({ ...manifest, storagePaths: [{ table: 'documents', collection: 'personas', pointers: ['/prompt'] }] })), /自己数据/);
  assert((await readFile(join(source, 'main.mjs'), 'utf8')).includes('must never run'));
});
