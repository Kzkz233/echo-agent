import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { readModelListing, readReasoningSupport } from '../packages/backends/model-metadata.ts';
import { thinking } from '../packages/backends/api.ts';

test('reasoning discovery uses explicit capabilities and preserves unknown model catalogs', () => {
  assert.equal(readReasoningSupport({ id: 'deepseek-reasoner', reasoning: true }), undefined);
  assert.equal(readReasoningSupport({ supported_parameters: ['reasoning'] }), undefined);
  assert.deepEqual(readReasoningSupport({ supported_parameters: ['enable_thinking'] })?.levels, ['off', 'high']);
  assert.deepEqual(readModelListing([{ id: 'ordinary' }, { id: 'ordinary' }, { id: 'rich',
    supported_reasoning_efforts: ['none', 'high', 'max'], default_reasoning_effort: 'high' }]), [
    { id: 'ordinary', label: 'ordinary' }, { id: 'rich', label: 'rich', reasoning: {
      source: 'upstream', levels: ['off', 'high', 'max'], default: 'high', style: 'effort', wireValues: { off: 'none', high: 'high', max: 'max' },
    } },
  ]);
  const profile = profileSchema.parse({ id: 'fixture', name: 'Fixture', kind: 'api', reasoning: 'high',
    reasoningSupport: readReasoningSupport({ supported_reasoning_efforts: ['none', 'high', 'max'] }),
  });
  assert.deepEqual(thinking(profile), { reasoning_effort: 'high' });
  assert.deepEqual(thinking(profile, 'off'), { reasoning_effort: 'none' });
  assert.deepEqual(thinking(profile, 'max'), { reasoning_effort: 'max' });
  assert.throws(() => thinking(profile, 'medium'), /不支持/);
  assert.deepEqual(thinking({ ...profile, reasoningStyle: 'none' }), {});
  assert.deepEqual(thinking({ ...profile, reasoningSupport: undefined }), {});
});

test('canceling a run waiting on metadata prevents inference without canceling other readers', async (t) => {
  const app = await setup(t, []);
  let finish!: (value: any) => void;
  const backend = Object.assign(new FakeBackend(), { listModels: () => new Promise<any>((resolve) => { finish = resolve; }) });
  app.router.backends.set('api', backend);
  const profile = app.router.profile('test'), life = new AbortController();
  const pending = app.router.inference.prepare({ ...profile, reasoning: 'high' }, undefined, life.signal);
  const rejected = assert.rejects(pending);
  await until(() => Boolean(finish));
  const other = app.router.inference.discover(profile);
  life.abort();
  await rejected;
  assert.equal(backend.calls.length, 0);
  finish([{ id: 'synthetic', label: 'Fixture' }]);
  assert.equal((await other).length, 1);
});

test('reloading a metadata provider with the same id invalidates its previous discovery cache', async (t) => {
  const app = await setup(t, []);
  let reads = 0;
  app.plugins.add({ manifest: { id: 'catalogfixture', name: 'Catalog fixture', description: 'Fixture', version: '1', dependencies: [],
    permissions: ['inference.contribute', 'inference.provide'], settings: [] }, activate: (ctx) => {
    ctx.capabilities.provide('core.inference.adapters@1', 'catalogfixture.api', 'Fixture', () => ({
      id: 'catalogfixture.api', label: 'Fixture', family: 'api', engine: 'api', generation: ['text'], embedding: [],
      connectionSchema: { type: 'object', properties: { endpoint: { type: 'string' } }, required: ['endpoint'], additionalProperties: false }, modelSchema: { type: 'object', properties: {} },
      connectionFields: [], modelFields: [],
      presets: [], modelCatalogProvider: 'catalogfixture.models',
    }));
    ctx.capabilities.provide('core.inference.models@1', 'catalogfixture.models', 'Fixture', () => {
      reads++; return [{ id: 'fixture', label: 'Fixture ' + reads }];
    });
  } });
  await app.plugins.enable('catalogfixture'); await app.router.inference.refresh();
  assert(app.router.inference.adapters().some((item) => item.id === 'catalogfixture.api'));
  await app.router.inference.saveConnection({ id: 'lifecycle', name: 'Fixture', adapterId: 'catalogfixture.api', config: { endpoint: 'http://127.0.0.1:1/v1' } });
  const profile = app.router.inference.connectionProfile('lifecycle', 'fixture');
  assert.equal((await app.router.inference.discover(profile))[0].label, 'Fixture 1');
  await app.plugins.disable('catalogfixture');
  await assert.rejects(app.router.inference.discover(profile));
  await app.plugins.enable('catalogfixture'); await app.router.inference.refresh();
  assert.equal((await app.router.inference.discover(profile))[0].label, 'Fixture 2');
});

test('a boolean thinking protocol supports explicit off and a task override without model-name guessing', () => {
  const profile = profileSchema.parse({ id: 'vision', name: 'Generic multimodal slot', kind: 'api', reasoning: 'high',
    reasoningSupport: readReasoningSupport({ supported_parameters: ['enable_thinking'] }),
  });
  assert.deepEqual(thinking(profile), { enable_thinking: true });
  assert.deepEqual(thinking(profile, 'off'), { enable_thinking: false });
});

test('model metadata is cached, refreshed, shared with execution and invalidated on endpoint changes', async (t) => {
  const app = await setup(t, []), caller = { kind: 'ui' as const, permissions: new Set(['*']) };
  let reads = 0;
  const backend = Object.assign(new FakeBackend(), { listModels: async () => {
    reads++; return readModelListing([{ id: 'choice', supported_reasoning_efforts: ['none', 'high', 'max'] }]);
  } });
  app.router.backends.set('api', backend);
  await app.router.inference.saveConnection({ id: 'connection', name: 'Fixture', adapterId: 'core.api',
    config: { endpoint: 'http://127.0.0.1:1/v1' } });
  await app.router.inference.saveModel({ id: 'model', connectionId: 'connection', name: 'Fixture', model: 'choice', reasoning: 'high' });
  const snapshot = app.router.inference.models();
  const query = () => app.registry.call('profiles.reasoning', { profileId: 'model' }, caller);
  const [a, b] = await Promise.all([query(), query()]);
  assert.deepEqual(a, b); assert.equal(reads, 1);
  assert.deepEqual(app.router.profile('model').reasoningSupport?.levels, ['off','high','max']);
  assert.deepEqual(app.router.inference.models(), snapshot);
  const chat = conversation(app);
  await app.router.bind(chat.id, 'model', new AbortController().signal);
  const run = await app.router.send({ conversationId: chat.id, requestId: 'turn', text: 'Synthetic', reasoning: 'max' });
  assert.equal(run.state, 'succeeded'); assert.equal(reads, 1);
  assert.equal(backend.calls[0].reasoning, 'max');
  assert.deepEqual(backend.calls[0].profile.reasoningSupport?.levels, ['off','high','max']);
  await app.registry.call('profiles.reasoning', { profileId: 'model', refresh: true }, caller);
  assert.equal(reads, 2);
  const connection = app.router.inference.connections().find((item) => item.id === 'connection')!;
  await app.router.inference.saveConnection({ ...connection, config: { endpoint: 'http://127.0.0.1:2/v1' } });
  assert.equal(app.router.profile('model').reasoningSupport, undefined);
  await query(); assert.equal(reads, 3);
});
