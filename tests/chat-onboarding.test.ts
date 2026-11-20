import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { internal } from '../packages/kernel/registry.ts';
import { setup } from './helpers.ts';

test('creating an individual companion is repeatable and does not create the studio or activate plugins', async t => {
  const app = await setup(t);
  const active = [...app.plugins.active.keys()].sort();
  const catalog = await app.registry.call('persona.character.catalog', {}, internal);
  const memory = catalog.features.find((feature: any) => feature.id === 'memory');
  assert.equal(memory.fields.find((field: any) => field.key === 'historyWindow').advanced, true);
  const create = (requestId: string, characterId?: string) => app.registry.call('characters.examples.create', { profileId: 'test', requestId, characterId }, internal);
  const first = await create('individual-first', 'miyu');
  assert.deepEqual(first.roles, ['example-miyu']);
  assert.deepEqual((await create('individual-retry','miyu')).roles, first.roles);
  assert.equal(app.store.documents('groups').length, 0);
  assert.equal(app.store.document('personas','example-hina'), undefined);
  assert.deepEqual([...app.plugins.active.keys()].sort(), active);
  assert.deepEqual((await create('intentional-studio')).roles.sort(), ['example-hina','example-miyu']);
});

test('local chat setup requires confirmation, a completed download and tool support from the local runtime', async t => {
  const app = await setup(t);
  const invoke = (confirmed: boolean) => app.registry.call('local-models.installChat', { confirmed }, internal);
  let capabilities: string[] = [];
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const target = new URL(url);
    assert.equal(target.origin, 'http://127.0.0.1:11434');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body as string).model, 'qwen3:4b');
    calls.push(target.pathname);
    return Response.json(target.pathname === '/api/pull' ? { status:'success' } : { capabilities });
  });
  await assert.rejects(invoke(false));
  assert.deepEqual(calls, []);
  await assert.rejects(invoke(true), /工具调用/);
  capabilities = ['completion','tools'];
  assert.deepEqual(await invoke(true), { model:'qwen3:4b' });
  assert.deepEqual(calls, ['/api/pull','/api/show','/api/pull','/api/show']);
});

test('quick connection retries reuse their own model, validate transport, and preserve inference routes', async t => {
  const app = await setup(t);
  const call = (name: string, input: object) => app.registry.call(name, input, internal);
  const routes = app.store.get('routes', {});
  const input = { provider: 'custom', endpoint: 'http://127.0.0.1:45555/v1', model: 'offline-fixture', requestId: randomUUID() };
  const connection = await call('models.setupChat', input);
  assert.deepEqual(await call('models.setupChat', input), connection);
  assert.equal(app.router.inference.models().filter(m => m.id === connection.id).length, 1);
  await assert.rejects(call('models.setupChat', { ...input, model:'different' }));
  await assert.rejects(call('models.setupChat', { ...input, requestId:randomUUID(), endpoint:'http://example.org' }));
  await call('models.restoreBundled', {});
  assert.deepEqual(app.store.get('routes', {}), routes);
});
