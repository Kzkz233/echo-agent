import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Registry, PluginManager, internal } from '../packages/kernel/registry.ts';
import { setup, until } from './helpers.ts';
const manifest = (id: string, dependencies: string[] = []) => ({
  id,
  name: id,
  description: 'Fixture',
  version: '1',
  dependencies,
  permissions: [id + '.read'],
  settings: [],
});
test('cleanup failures do not stop independent or required-provider cleanup', async () => {
  const manager = new PluginManager(new Registry()),
    disposed: string[] = [];
  manager.add({
    manifest: manifest('base'),
    activate: ({ dispose }) =>
      dispose(() => {
        disposed.push('base');
      }),
  });
  manager.add({
    manifest: manifest('dependent', ['base']),
    activate: ({ dispose }) =>
      dispose(() => {
        disposed.push('dependent');
        throw Error('fixture disposer failure');
      }),
  });
  manager.add({
    manifest: manifest('independent'),
    activate: ({ dispose }) =>
      dispose(() => {
        disposed.push('independent');
      }),
  });
  await manager.enable('dependent');
  await manager.enable('independent');
  await assert.rejects(manager.close(), /fixture disposer failure/);
  assert.deepEqual(new Set(disposed), new Set(['base', 'dependent', 'independent']));
  assert.equal(manager.active.size, 0);
});
test('late dependency installation and return activate waiting consumers without reloading independent plugins', async () => {
  const manager = new PluginManager(new Registry());
  let starts = 0;
  manager.add({
    manifest: manifest('consumer', ['provider']),
    activate: () => {
      starts++;
    },
  });
  await manager.enable('consumer');
  assert.equal(manager.list()[0].state, 'pending');
  manager.add({ manifest: manifest('provider'), activate: () => {} });
  await until(() => manager.active.has('consumer'));
  assert.equal(starts, 1);
  await manager.disable('provider');
  assert(!manager.active.has('consumer'));
  assert.equal(manager.list().find((p) => p.id === 'consumer')!.requested, true);
  await manager.enable('provider');
  assert(manager.active.has('consumer'));
  assert.equal(starts, 2);
  await manager.close();
});
test('plugin registrations cannot spoof owners or undeclared permissions', async () => {
  for (const spoof of ['owner', 'permission']) {
    const registry = new Registry(),
      manager = new PluginManager(registry);
    manager.add({
      manifest: manifest('demo'),
      activate: ({ registry }) => {
        registry.register({
          name: 'demo.read',
          owner: spoof === 'owner' ? 'core' : 'demo',
          permission: spoof === 'permission' ? 'system.write' : 'demo.read',
          mcp: true,
          input: z.object({}),
          output: z.any(),
          description: 'fixture',
          run: () => 1,
        });
      },
    });
    await assert.rejects(manager.enable('demo'));
    assert.equal(registry.list(internal).length, 0);
  }
});
test('unload revokes new calls and rejects a late return from the old plugin generation', async () => {
  const registry = new Registry(),
    manager = new PluginManager(registry);
  let started = false;
  manager.add({
    manifest: manifest('demo'),
    activate: ({ registry }) => {
      registry.register({
        name: 'demo.wait',
        owner: 'demo',
        permission: 'demo.read',
        mcp: true,
        input: z.object({}),
        output: z.any(),
        description: 'fixture',
        run: (_v, _c, signal) =>
          new Promise((resolve) => {
            started = true;
            signal.addEventListener('abort', () => resolve('late result'), { once: true });
          }),
      });
    },
  });
  await manager.enable('demo');
  const call = registry.call('demo.wait', {}, internal);
  const rejected = assert.rejects(call);
  await until(() => started);
  await manager.disable('demo');
  await rejected;
  await assert.rejects(registry.call('demo.wait', {}, internal));
  await manager.close();
});
test('RAG can appear and disappear while memory and Review keep running', async (t) => {
  const app = await setup(t);
  await app.memories.save({
    personaId: 'companion',
    title: 'Tea',
    text: 'Enjoys tea',
    core: false,
    tags: [],
    sources: [],
  });
  const first = await app.memories.recall('companion', 'tea', [], new AbortController().signal);
  assert(first.some((m) => m.method === 'keyword'));
  await app.plugins.enable('semantic');
  assert(app.retrieval.providers.length);
  await app.plugins.disable('semantic');
  assert.equal(app.retrieval.providers.length, 0);
  assert(app.plugins.active.has('memory'));
  assert(app.plugins.active.has('review'));
  const last = await app.memories.recall('companion', 'tea', [], new AbortController().signal);
  assert(last.some((m) => m.method === 'keyword'));
});
test('Review sources are opt-in, disappear with providers, and do not create a hard dependency', async (t) => {
  const app = await setup(t);
  const remove = app.materials.register({
    id: 'mail',
    label: 'Mail',
    read: async (personaId) => [
      { id: 'mail-1', personaId, timestamp: '2026-11-05T00:00:00Z', text: 'Synthetic mail' },
    ],
  });
  assert.equal((await app.reviews.collect('companion')).length, 0);
  app.store.set('review.config', { sourceIds: ['mail.source'] });
  assert.equal((await app.reviews.collect('companion')).length, 1);
  remove();
  assert.equal((await app.reviews.collect('companion')).length, 0);
  assert(app.plugins.active.has('review'));
});

test('a file write from an old lifecycle cannot commit after application components shut down', async (t) => {
  const app = await setup(t);
  const originalPath = app.files.path.bind(app.files);
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  app.files.path = async (vault, path) => {
    const result = await originalPath(vault, path);
    started();
    await waiting;
    return result;
  };
  const work = app.files.write('local', 'late.txt', 'Old generation');
  const rejected = assert.rejects(work, /已停止/);
  await ready;
  await app.plugins.close();
  app.files.path = originalPath;
  finish();
  await rejected;
  await assert.rejects(app.files.records('local'),/未启用/);
});

test('unloading Media Assets during import cannot publish a late asset record', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('assets');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  app.files.import = async (_vault, _source, _captured, signal) => {
    started();
    await new Promise<void>((resolve) =>
      signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    return { id: 'late-file', name: 'Synthetic.png' } as any;
  };
  const work = app.registry.call(
    'assets.import',
    { vaultId: 'local', source: 'Synthetic.png' },
    {
      kind: 'ui',
      permissions: new Set(['*']),
    },
  );
  const rejected = assert.rejects(work);
  await ready;
  await app.plugins.close();
  await rejected;
  assert.equal(app.store.documents('assets').length, 0);
  assert(!app.registry.list({kind:'ui',permissions:new Set(['*'])}).some(op=>op.owner==='assets'));
});
