import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { readModelListing, readReasoningSupport } from '../packages/backends/model-metadata.ts';
import { thinking, ApiBackend } from '../packages/backends/api.ts';
import { modelProtocol } from '../packages/backends/protocol.ts';
import { defaultOutputTokens } from '../packages/contracts/generation-limits.ts';
import { createInitialSystemMessage, normalizeContext } from '@earendil-works/pi-ai';

test('official Responses explicitly sends non-strict function schemas while compatible endpoints retain their wire format', async () => {
  const parameters = { type: 'object' as const, properties: { note: { type: 'string' } }, required: [] };
  const tools = [{ name: 'fixture_note', description: 'Optional note', parameters }];
  for (const official of [true, false]) {
    const { model, streams } = await modelProtocol(profileSchema.parse({
      id: 'fixture', name: 'Fixture', kind: 'pi', model: 'synthetic',
      endpoint: official ? 'https://api.openai.com/v1' : 'https://provider.invalid/v1',
      protocol: 'openai-responses',
    }));
    let wire: any;
    const stream = streams.streamSimple(model, normalizeContext({ messages: [
      createInitialSystemMessage('Fixture', tools)!,
      { role: 'user', content: 'Test', timestamp: 0 },
    ] }), { apiKey: 'fixture', maxRetries: 0, fetch: async (_url, init) => {
      wire = JSON.parse(String(init?.body));
      return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    assert.equal((await stream.result()).stopReason, 'stop');
    assert.deepEqual(wire.tools, [{ type: 'function', ...tools[0], ...(official ? { strict: false } : {}) }]);
  }
});

test('automatic output uses declared model capacity, preserves manual settings and invalidates changed connections', async t => {
  const app = await setup(t, []);
  const catalog = app.router.inference;
  await catalog.saveModel({ ...catalog.models().find(model => model.id === 'test')!, maxOutputTokens: undefined });
  assert.equal(catalog.models().find(model => model.id === 'test')!.maxOutputTokens, undefined);
  assert.equal(catalog.resolve('test').maxOutputTokens, defaultOutputTokens);
  let capacity = 262144;
  app.router.backends.set('api', Object.assign(new FakeBackend(), { listModels: async () =>
    readModelListing([{ id: 'synthetic', max_output_tokens: capacity, supported_reasoning_efforts: ['high'] }]) }));
  await catalog.discover(catalog.resolve('test'), true);
  const automatic = catalog.resolve('test');
  assert.equal(automatic.maxOutputTokens, 262144);
  assert.equal(automatic.automaticOutputTokens, true);
  assert.equal((await modelProtocol(automatic)).model.maxTokens, 262144);
  await catalog.saveModel({ ...catalog.models().find(model => model.id === 'test')!, maxOutputTokens: 128000 });
  assert.equal(catalog.resolve('test').maxOutputTokens, 128000);
  capacity = 64000;
  await catalog.discover(catalog.resolve('test'), true);
  assert.equal(catalog.resolve('test').maxOutputTokens, 64000);
  assert.equal(catalog.models().find(model => model.id === 'test')!.maxOutputTokens, 128000);
  const prepared = await catalog.prepare({ ...automatic, maxOutputTokens: 32000, automaticOutputTokens: false }, 'high');
  assert.equal(prepared.maxOutputTokens, 32000);
  assert.equal((await catalog.prepare({ ...automatic, reasoning: 'inherit', maxOutputTokens: 128000, automaticOutputTokens: false })).maxOutputTokens, 64000);
  await catalog.saveModel({ ...catalog.models().find(model => model.id === 'test')!, maxOutputTokens: undefined });
  const connection = catalog.connections().find(row => row.id === 'test')!;
  await catalog.saveConnection({ ...connection, config: { ...connection.config, endpoint: 'http://127.0.0.1:2/v1' } });
  assert.equal(catalog.resolve('test').maxOutputTokens, defaultOutputTokens);
});

test('model output metadata requires a positive numeric output capacity rather than context size', () => {
  const rows = readModelListing([{ id: 'context', context_length: 1000000 },
    { id: 'invalid', max_output_tokens: -1 }, { id: 'string', max_output_tokens: '128000' },
    { id: 'declared', top_provider: { max_completion_tokens: 262144 } }]);
  assert.deepEqual(rows.map(row => row.maxOutputTokens), [undefined, undefined, undefined, 262144]);
});

test('a catalog refresh failure retains known capabilities only for the same connection identity', async t => {
  const app = await setup(t, []), caller = { kind: 'ui' as const, permissions: new Set(['*']) };
  let fail = false;
  app.router.backends.set('api', Object.assign(new FakeBackend(), { listModels: async () => {
    if (fail) throw new Error('Synthetic catalog outage');
    return readModelListing([{ id: 'synthetic', supported_reasoning_efforts: ['low', 'high'] }]);
  } }));
  const known = await app.registry.call('profiles.reasoning', { profileId: 'test' }, caller);
  assert.deepEqual(known.reasoning?.levels, ['low', 'high']);
  fail = true;
  const cached = await app.registry.call('profiles.reasoning', { profileId: 'test', refresh: true }, caller);
  assert.equal(cached.cached, true);
  assert.match(cached.issue, /Synthetic catalog outage/);
  assert.deepEqual(cached.reasoning?.levels, ['low', 'high']);
  const connection = app.router.inference.connections().find(row => row.id === 'test')!;
  await app.router.inference.saveConnection({ ...connection, config: { ...connection.config, endpoint: 'http://127.0.0.1:2/v1' } });
  const changed = await app.registry.call('profiles.reasoning', { profileId: 'test', refresh: true }, caller);
  assert.equal(changed.status, 'unavailable');
  assert.equal(changed.reasoning, null);
  assert.equal(changed.cached, false);
});

test('catalog transport errors identify the network failure without disclosing endpoint or credentials', async () => {
  const backend = new ApiBackend(async () => 'fixture-secret', async () => {
    throw new TypeError('fetch failed at private endpoint', { cause: { code: 'ECONNRESET', address: 'private endpoint' } });
  });
  await assert.rejects(backend.listModels(profileSchema.parse({ id: 'fixture', name: 'Fixture', kind: 'api',
    endpoint: 'https://example.invalid/v1' })), error => {
    assert.match((error as Error).message, /ECONNRESET/);
    assert.doesNotMatch((error as Error).message, /private|fixture-secret|example.invalid/);
    return true;
  });
});

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
  assert.deepEqual(thinking({ ...profile, reasoningSupport: undefined }), { reasoning_effort: 'high' });
  assert.deepEqual(thinking({ ...profile, reasoningSupport: undefined }, 'off'), { reasoning_effort: 'none' });
  assert.deepEqual(thinking({ ...profile, reasoningSupport: undefined, reasoning: 'inherit' }), {});
});

test('native protocols retain explicit reasoning without inventing capability metadata', async () => {
  const profile = profileSchema.parse({ id: 'fixture', name: 'Fixture', kind: 'pi',
    endpoint: 'http://127.0.0.1:1/v1', model: 'synthetic', protocol: 'openai-responses', reasoning: 'high' });
  const enabled = await modelProtocol(profile);
  assert.equal(enabled.reasoning, 'high');
  assert.equal(enabled.model.reasoning, true);
  const disabled = await modelProtocol(profile, 'off');
  const payload = await disabled.onPayload!({ model: 'synthetic' }, disabled.model);
  assert.deepEqual(payload, { model: 'synthetic', reasoning: { effort: 'none' } });
  assert.equal((await modelProtocol({ ...profile, reasoning: 'inherit' })).reasoning, undefined);
  assert.equal(profile.reasoningSupport, undefined);
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

test('draft reasoning declarations match saved settings and apply without catalog metadata', async (t) => {
  const app = await setup(t, []), caller = { kind: 'ui' as const, permissions: new Set(['*']) };
  const backend = Object.assign(new FakeBackend(), { listModels: async () => [{ id: 'synthetic', label: 'Synthetic' }] });
  app.router.backends.set('api', backend);
  const draft = { connectionId: 'test', model: 'synthetic', style: 'effort', reasoningLevels: ['low', 'high'] };
  const result = await app.registry.call('profiles.reasoning', draft, caller);
  assert.equal(result.status, 'known');
  assert.equal(result.reasoning?.source, 'manual');
  assert.deepEqual(result.reasoning?.levels, ['low', 'high']);
  await app.router.inference.saveModel({ ...app.router.inference.models().find(p => p.id === 'test')!,
    reasoningStyle: 'effort', reasoningLevels: ['low', 'high'], reasoning: 'high' });
  const saved = await app.registry.call('profiles.reasoning', { profileId: 'test' }, caller);
  assert.deepEqual(saved.reasoning, result.reasoning);
  assert.deepEqual(thinking(app.router.profile('test')), { reasoning_effort: 'high' });
  const unknown = await app.registry.call('profiles.reasoning', { ...draft, style: 'auto', reasoningLevels: undefined }, caller);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reasoning, null);
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
