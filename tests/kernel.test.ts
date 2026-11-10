import{seedProfile}from'../scripts/inference-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { join } from 'node:path';
import { Store } from '../packages/kernel/store.ts';
import { Registry, PluginManager, internal } from '../packages/kernel/registry.ts';
import { EchoError, profileSchema } from '../packages/contracts/index.ts';
import { setup, temporary, conversation, FakeBackend, until } from './helpers.ts';
import { cp, writeFile } from 'node:fs/promises';

test('a standalone extension is discovered, permission checked and disposed', async (t) => {
  const app = await setup(t),
    directory = join(app.runtime, 'extension');
  await cp(join(app.project, 'examples/hello-extension'), directory, { recursive: true });
  await writeFile(
    join(directory, 'echo-plugin.json'),
    JSON.stringify({
      apiVersion: 1,
      id: 'hello',
      name: 'Hello',
      description: 'Fixture',
      version: '0.1.0',
      dependencies: [],
      permissions: ['hello.read'],
      command: process.execPath,
      args: ['extension.mjs'],
      settings: [{ key: 'greeting', label: 'Greeting', type: 'text' }],
    }),
  );
  await app.extensions.install(directory, true);
  await app.plugins.enable('hello');
  assert.deepEqual(await app.registry.call('hello.greet', { name: 'Echo' }, internal), {
    text: 'Hello, Echo!',
  });
  await app.registry.call(
    'settings.save',
    { pluginId: 'hello', value: { greeting: 'Welcome' } },
    internal,
  );
  assert.deepEqual(await app.registry.call('hello.greet', { name: 'Echo' }, internal), {
    text: 'Welcome, Echo!',
  });
  await assert.rejects(
    app.registry.call('settings.save', { pluginId: 'hello', value: { unknown: true } }, internal),
  );
  await assert.rejects(
    app.registry.call('hello.greet', { name: 'Echo' }, { kind: 'mcp', permissions: new Set() }),
    /权限/,
  );
  await app.plugins.disable('hello');
  assert(!app.registry.list(internal).some((o) => o.name === 'hello.greet'));
});

test('the built-in product starts without optional capture, workers or timers', async (t) => {
  const app = await setup(t, []);
  assert.deepEqual([...app.plugins.active.keys()].sort(), ['assets','channels','clock','delegation','documents','embeddings','files','knowledge','local-models','models','notifications','persona','scheduler','storage']);
  assert.equal(app.files.roots().filter(v=>!v.owner).length,1);
  assert.equal(app.localModels.status().loaded,0);
  assert.equal(app.store.documents('personas').length, 1);
  assert.equal(app.clock.pending, 0);
  assert.equal(app.observations.status().enabled, false);
  assert.equal(
    app.registry.list(internal).some((o) => o.owner !== 'core' && !app.plugins.isBuiltin(o.owner)),
    false,
  );
  await assert.rejects(app.plugins.disable('persona'), /内建模块/);
});
test('registry validates inputs and permissions before executing', async () => {
  const registry = new Registry();
  let count = 0;
  registry.register({
    name: 'test.add',
    description: '',
    owner: 'test',
    permission: 'write',
    mcp: true,
    input: z.object({ n: z.number() }),
    output: z.number(),
    run: ({ n }) => {
      count++;
      return n + 1;
    },
  });
  await assert.rejects(
    registry.call('test.add', { n: 1 }, { kind: 'mcp', permissions: new Set() }),
    /需要权限/,
  );
  await assert.rejects(registry.call('test.add', { n: 'x' }, internal));
  assert.equal(count, 0);
  assert.equal(await registry.call('test.add', { n: 1 }, internal), 2);
});
test('dependency activation is ordered and disabling releases dependent resources', async () => {
  const events: string[] = [],
    manager = new PluginManager(new Registry());
  const plugin = (id: string, dependencies: string[]) => ({
    manifest: {
      id,
      name: id,
      description: '',
      version: '1',
      dependencies,
      permissions: [],
      settings: [],
    },
    activate: ({ dispose }: any) => {
      events.push(id);
      dispose(() => events.push('-' + id));
    },
  });
  manager.add(plugin('one', []));
  manager.add(plugin('two', ['one']));
  await manager.enable('two');
  await manager.disable('one');
  assert.deepEqual(events, ['one', 'two', '-two', '-one']);
  assert.equal(manager.active.size, 0);
});
test('plugin cycles are rejected', () => {
  const manager = new PluginManager(new Registry());
  const p = (id: string, dependencies: string[]) => ({
    manifest: {
      id,
      name: id,
      description: '',
      version: '1',
      dependencies,
      permissions: [],
      settings: [],
    },
    activate: () => {},
  });
  manager.add(p('one', ['two']));
  assert.throws(() => manager.add(p('two', ['one'])), /循环依赖/);
});
test('same request generates once and conflicts cannot change its input', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const input = { conversationId: c.id, text: '你好', requestId: 'exactly-once' };
  const first = await app.router.send(input);
  const duplicate = await app.router.send(input);
  assert.equal(first.id, duplicate.id);
  assert.equal(backend.calls.length, 1);
  assert.equal(app.store.messages(c.id).filter((m) => m.role === 'assistant').length, 1);
  await assert.rejects(app.router.send({ ...input, text: 'changed' }), /不同内容/);
});
test('unknown result blocks replay and another turn', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  backend.responder = async () => {
    throw new EchoError('lost', 'lost', true);
  };
  app.router.backends.set('api', backend);
  const run = await app.router.send({ conversationId: c.id, text: 'test', requestId: 'unknown' });
  assert.equal(run.state, 'unknown');
  await assert.rejects(
    app.router.send({ conversationId: c.id, text: 'again', requestId: 'second' }),
    /未知/,
  );
  assert.equal(backend.calls.length, 1);
});
test('restart converts in-flight runs to unknown without replay', async (t) => {
  const root = await temporary(t),
    path = join(root, 'test.sqlite');
  const store = new Store(path);
  store.saveConversation({
    id: 'c',
    title: 'c',
    personaId: 'p',
    injection: false,
    review: false,
    createdAt: '2026-01-01',
  });
  store.createRun({
    id: 'r',
    requestId: 'q',
    conversationId: 'c',
    profileId: 'p',
    epoch: 1,
    state: 'running',
    input: 'test',
    source: 'human',
    createdAt: '2026-01-01',
    meta: {},
  });
  store.close();
  const reopened = new Store(path);
  assert.equal(reopened.run('r')!.state, 'unknown');
  reopened.close();
});
test('switch imports complete history once, archives old binding and increments epoch', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(c.id, 'user', 'human', 'original');
  app.store.append(c.id, 'assistant', 'chat', 'original answer');
  const first = await app.router.bind(c.id, 'test', new AbortController().signal);
  seedProfile(app,profileSchema.parse({ ...app.router.profile('test'), id: 'other' }));
  const second = await app.router.bind(c.id, 'other', new AbortController().signal);
  assert.equal(second.epoch, first.epoch + 1);
  assert.equal(backend.seeds[1].length, 2);
  assert.deepEqual(backend.archived, [first.sessionId]);
  assert.deepEqual(
    app.store.messages(c.id).map((m) => m.role),
    ['user', 'assistant'],
  );
});
test('oversized migration does not change binding or strand the conversation lock', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(c.id, 'user', 'human', 'x'.repeat(5000));
  seedProfile(app,profileSchema.parse({ ...app.router.profile('test'), id: 'small', contextChars: 4000 }));
  await assert.rejects(app.router.bind(c.id, 'small', new AbortController().signal), /超过/);
  assert.equal(app.store.binding(c.id), undefined);
  const binding = await app.router.bind(c.id, 'test', new AbortController().signal);
  assert.equal(binding.state, 'active');
});
test('observation is structurally an application message, and its reply is a native assistant', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const run = await app.router.send({
    conversationId: c.id,
    text: '观察信号',
    source: 'observation',
    reasoning: 'off',
    bubble: true,
    requestId: 'observe-one',
  });
  const messages = app.store.messages(c.id);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].source, 'observation');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].source, 'observation');
  assert.equal(backend.calls[0].reasoning, 'off');
  await until(() => app.store.pendingDeliveries().length === 1);
  assert.equal(app.store.pendingDeliveries().length, 1);
  assert.equal(run.state, 'succeeded');
});
