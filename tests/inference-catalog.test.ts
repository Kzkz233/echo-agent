import { listenBrowserHttp } from '../packages/kernel/http-listener.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { z } from 'zod';
import { setup, until } from './helpers.ts';
import { inferenceTasks, adapterSchema, taskSchema } from '../packages/contracts/inference.ts';
import type { ModelInput } from '../packages/contracts/index.ts';
import { CodexBackend } from '../packages/backends/codex.ts';
const ui = { kind: 'ui' as const, permissions: new Set(['*']) };

test('inference task contributors must declare application or character route scope', () => {
  assert.throws(
    () =>
      taskSchema.parse({
        id: 'fixture.task',
        label: 'Fixture task',
        operation: 'generate',
        inputs: ['text'],
        description: '',
      }),
    /scope/,
  );
});

test('connection checks use a configured model and its reasoning instead of an empty model ID', async (t) => {
  const app = await setup(t);
  let received: any;
  app.router.backends.set('dsh', {
    kind: 'dsh',
    generate: async () => {
      throw Error('No generation allowed');
    },
    checkConnection: async (profile) => {
      received = profile;
      return { ok: true };
    },
  });
  await app.router.inference.saveConnection({
    id: 'official-check',
    name: 'Fixture',
    adapterId: 'worker-dsh.provider',
    deployment: 'harness',
    config: { provider: 'deepseek-official' },
  });
  await app.router.inference.saveModel({
    id: 'configured-check',
    name: 'Fixture model',
    connectionId: 'official-check',
    model: 'deepseek-flash',
    reasoning: 'xhigh',
  });
  await app.registry.call('connections.test', { id: 'official-check' }, ui);
  assert.equal(received.model, 'deepseek-flash');
  assert.equal(received.reasoning, 'xhigh');
});

test('memory and knowledge use the shared embedding route, ignoring legacy role overrides', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  await app.plugins.enable('embeddings');
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    calls.push(input.model);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: input.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const catalog = app.router.inference;
  const tasks = await catalog.tasks();
  assert.equal(tasks.find((task) => task.id === inferenceTasks.query)?.scope, 'character');
  assert.equal(tasks.find((task) => task.id === inferenceTasks.embedding)?.scope, 'shared');
  await catalog.saveConnection({
    id: 'vector-fixture',
    name: 'Fixture',
    adapterId: 'core.api',
    deployment: 'local',
    config: { endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` },
  });
  for (const id of ['shared', 'first', 'second'])
    await catalog.saveModel({
      id,
      name: id,
      connectionId: 'vector-fixture',
      model: id,
      generation: { enabled: false, inputs: ['text'] },
      embedding: { enabled: true, inputs: ['text'], dimensions: 2 },
    });
  await app.registry.call('routes.save', { [inferenceTasks.embedding]: 'shared' }, ui);
  for (const id of ['first', 'second', 'fallback']) {
    app.store.put('characters', id, {
      id,
      features: ['memory'],
      routes: id === 'fallback' ? {} : { [inferenceTasks.embedding]: id },
    });
    await app.memories.save({
      personaId: id,
      title: 'Tea',
      text: 'Enjoys tea',
      core: false,
      tags: [],
      sources: [],
    });
    calls.length = 0;
    const hits = await app.memories.recall(id, 'tea', [], new AbortController().signal);
    assert.equal(hits.length, 1);
    assert.notEqual(hits[0].method, 'keyword');
    assert.deepEqual(calls, ['shared', 'shared']);
    assert.equal(app.router.route(inferenceTasks.embedding, id).id, 'shared');
  }
  calls.length = 0;
  await app.knowledge.save('local', 'Tea', 'Enjoys tea');
  const job = await app.semantic.startIndex(
    { vaultId: 'local' },
    'shared-index',
    new AbortController().signal,
  );
  await until(() => app.store.document<any>('semantic-jobs', job.id)?.state !== 'running');
  const hits = await app.retrieval.rank(
    'knowledge',
    'tea',
    await app.knowledge.records({ vaultId: 'local' }),
    new AbortController().signal,
    true,
    true,
  );
  assert(hits.length > 0);
  assert(calls.every((model) => model === 'shared'));
  await app.plugins.disable('semantic');
  const lexical = await app.memories.recall('first', 'tea', [], new AbortController().signal);
  assert.equal(lexical[0].method, 'keyword');
});

test('a contributed generation adapter receives message order, reference identity and turn scope', async (t) => {
  const app = await setup(t);
  let received: ModelInput[] | undefined;
  app.plugins.add({
    manifest: {
      id: 'text-fixture',
      name: 'Fixture inference',
      version: '1',
      description: 'Fixture',
      dependencies: [],
      permissions: ['inference.contribute', 'inference.provide'],
      settings: [],
    },
    activate(ctx) {
      ctx.capabilities.provide('core.inference.adapters@1', 'text-fixture.api', 'Fixture', () => ({
        id: 'text-fixture.api',
        engine: 'text-fixture',
        family: 'api',
        label: 'Fixture',
        connectionSchema: z.toJSONSchema(z.object({ endpoint: z.string() }).strict()),
        modelSchema: z.toJSONSchema(z.object({}).strict()),
        connectionFields: [],
        modelFields: [],
        generation: ['text'],
        embedding: [],
        generationProvider: 'text-fixture.api',
      }));
      ctx.capabilities.provide('core.inference.generate@1', 'text-fixture.api', 'Fixture', (v) => {
        received = v.messages;
        return { text: 'Fixture reply' };
      });
    },
  });
  await app.plugins.enable('text-fixture');
  await app.router.inference.refresh();
  await app.router.inference.saveConnection({
    id: 'text-fixture',
    name: 'Fixture',
    adapterId: 'text-fixture.api',
    config: { endpoint: 'http://127.0.0.1:1/v1' },
  });
  await app.router.inference.saveModel({
    id: 'text-fixture',
    name: 'Fixture',
    connectionId: 'text-fixture',
    model: 'synthetic',
  });
  const profile = app.router.profile('text-fixture');
  const messages: ModelInput[] = [
    { role: 'system', text: 'Stable context' },
    { id: 'earlier-answer', role: 'assistant', text: 'History' },
    { id: 'memory-reference', role: 'system', text: 'Fresh memory', context: 'turn' },
    { id: 'current', role: 'user', text: 'Hello' },
  ];
  const result = await app.router.backend(profile).generate({
    profile,
    messages,
    requestId: 'contributed-generation',
    signal: new AbortController().signal,
  });
  assert.equal(result.text, 'Fixture reply');
  assert.deepEqual(received, messages);
});
test('API connections hold multiple models with independent capabilities and route eligibility', async (t) => {
  const app = await setup(t),
    catalog = app.router.inference;
  await catalog.saveConnection({
    id: 'shared',
    name: 'Shared service',
    adapterId: 'core.api',
    deployment: 'local',
    config: { endpoint: 'http://127.0.0.1:1/v1' },
  });
  const chat = await catalog.saveModel({
    id: 'chat-model',
    name: 'Language',
    connectionId: 'shared',
    model: 'language',
  });
  assert(!(await catalog.kinds()).some(kind=>kind.capability==='embedding'));
  await app.plugins.enable('semantic');
  await app.plugins.enable('embeddings');
  const embed = await catalog.saveModel({
    id: 'embedding-model',
    name: 'Vectors',
    connectionId: 'shared',
    model: 'embedding',
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'] },
  });
  assert.equal(catalog.resolve(chat.id).endpoint, catalog.resolve(embed.id).endpoint);
  await app.registry.call('routes.save', { [inferenceTasks.embedding]: embed.id }, ui);
  await assert.rejects(
    app.registry.call('routes.save', { [inferenceTasks.chat]: chat.id }, ui),
    /角色级推理任务/,
  );
  await assert.rejects(
    app.registry.call('routes.save', { [inferenceTasks.vision]: chat.id }, ui),
    /角色级推理任务/,
  );
  await assert.rejects(
    catalog.saveModel({ ...chat, generation: { enabled: true, inputs: ['text', 'audio'] } }),
    /未实现/,
  );
  await assert.rejects(app.registry.call('connections.delete', { id: 'shared' }, ui), /仍有模型/);
  await app.plugins.disable('semantic');
  assert(app.plugins.active.has('memory'));
  assert(!app.plugins.active.has('semantic')); // Optional retrieval leaves basic memory alive.
  assert(!(await catalog.kinds()).some((kind) => kind.capability === 'embedding'));
  assert.equal(catalog.models().find((m) => m.id === embed.id)?.embedding.enabled, true);
  await catalog.saveModel({ ...chat, name: 'Still editable' });
  await app.plugins.enable('embeddings');
  assert((await catalog.tasks()).some((task) => task.operation === 'embed'));
  await app.registry.call('routes.save', { [inferenceTasks.embedding]: null }, ui);
  assert.equal(app.store.get<any>('routes', {})[inferenceTasks.embedding], undefined);
});

test('optional plugins register task choices without changing the consumer or losing saved routes', async (t) => {
  const app = await setup(t),
    catalog = app.router.inference;
  app.plugins.add({
    manifest: {
      id: 'translation',
      name: 'Synthetic translation',
      version: '1',
      description: 'Fixture',
      dependencies: [],
      permissions: ['inference.contribute'],
      settings: [],
    },
    activate: (ctx) => {
      ctx.capabilities.provide(
        'core.inference.tasks@1',
        'translation.translate',
        'Translation',
        () => ({
          id: 'translation.translate',
          label: 'Translation',
          scope: 'shared',
          operation: 'generate',
          inputs: ['text'],
          description: '',
        }),
      );
    },
  });
  assert(!(await catalog.tasks()).some((task) => task.id === 'translation.translate'));
  await app.plugins.enable('translation');
  await app.registry.call('routes.save', { 'translation.translate': 'test' }, ui);
  assert.equal(app.router.route('translation.translate').id, 'test');
  await app.plugins.disable('translation');
  assert.throws(() => app.router.route('translation.translate'), /未注册/);
  assert.equal(app.store.get<any>('routes', {})['translation.translate'], 'test');
  await app.plugins.enable('translation');
  assert.equal(app.router.route('translation.translate').id, 'test');
});

test('a contributed multimodal embedding adapter accepts structured inputs and rejects late results on unload', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('embeddings');
  let waiting = false,
    started!: () => void;
  let hold = false;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  app.plugins.add({
    manifest: {
      id: 'media-vector',
      name: 'Synthetic media vectors',
      version: '1',
      description: 'Fixture',
      dependencies: [],
      permissions: ['inference.contribute', 'embeddings.provide'],
      settings: [],
    },
    activate: (ctx) => {
      const descriptor = adapterSchema.parse({
        id: 'media-vector.fake',
        engine: 'media-vector',
        family: 'local-runtime',
        label: 'Synthetic media vectors',
        connectionSchema: z.toJSONSchema(z.object({}).strict()),
        modelSchema: z.toJSONSchema(z.object({}).strict()),
        connectionFields: [],
        modelFields: [],
        generation: [],
        embedding: ['text', 'image', 'audio', 'video'],
        embeddingProvider: 'media-vector.fake',
      });
      ctx.capabilities.provide(
        'core.inference.adapters@1',
        descriptor.id,
        descriptor.label,
        () => descriptor,
      );
      ctx.capabilities.provide(
        'embeddings.encode@1',
        descriptor.id,
        descriptor.label,
        async (v, signal) => {
          if (hold) {
            waiting = true;
            started();
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          }
          return { vectors: v.inputs.map((i: any) => [i.content.length, 1]) };
        },
      );
    },
  });
  await app.plugins.enable('media-vector');
  await app.router.inference.refresh();
  await app.router.inference.saveConnection({
    id: 'media',
    name: 'Media',
    adapterId: 'media-vector.fake',
    deployment: 'local',
    config: {},
  });
  await app.router.inference.saveModel({
    id: 'media',
    name: 'Media',
    connectionId: 'media',
    model: 'fake',
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text', 'image', 'audio', 'video'], dimensions: 2 },
  });
  const inputs: any[] = [
    {
      content: [
        { type: 'text', text: 'A scene' },
        { type: 'image', mimeType: 'image/png', data: 'AA==' },
      ],
    },
    {
      content: [
        { type: 'audio', mimeType: 'audio/wav', data: 'AA==' },
        { type: 'video', mimeType: 'video/mp4', data: 'AA==' },
      ],
    },
  ];
  assert.deepEqual(
    await app.embeddings.encode('media', inputs, 'document', new AbortController().signal),
    [
      [2, 1],
      [2, 1],
    ],
  );
  hold = true;
  const work = app.embeddings.encode('media', inputs, 'query', new AbortController().signal),
    rejected = assert.rejects(work);
  await ready;
  assert(waiting);
  await app.plugins.disable('media-vector');
  await rejected;
  assert(app.router.inference.models().some((m) => m.id === 'media'));
  assert.throws(() => app.router.profile('media'), /当前不可用/);
});

test('API embeddings use the selected model, reorder indices, validate dimensions and invalidate space identity', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  await app.plugins.enable('embeddings');
  let received: any,
    dimension = 2;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    received = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: received.input
          .map((_s: string, i: number) => ({ index: i, embedding: Array(dimension).fill(i + 1) }))
          .reverse(),
      }),
    );
  });
  await listenBrowserHttp(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const catalog = app.router.inference;
  await catalog.saveConnection({
    id: 'vectors',
    name: 'Vectors',
    adapterId: 'core.api',
    deployment: 'local',
    config: { endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` },
  });
  const m = await catalog.saveModel({
    id: 'vectors',
    name: 'Vectors',
    connectionId: 'vectors',
    model: 'model-a',
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'], dimensions: 2 },
  });
  await app.registry.call('routes.save', { [inferenceTasks.embedding]: m.id }, ui);
  assert.deepEqual(await app.embeddings.texts(['first', 'second'], new AbortController().signal), [
    [1, 1],
    [2, 2],
  ]);
  assert.equal(received.model, 'model-a');
  assert.equal(received.dimensions, 2);
  const fingerprint = catalog.fingerprint(m.id);
  await catalog.saveModel({ ...m, model: 'model-b' });
  assert.notEqual(catalog.fingerprint(m.id), fingerprint);
  dimension = 3;
  await assert.rejects(app.embeddings.texts(['bad'], new AbortController().signal), /维度/);
  assert.equal(app.store.documents('vectors').length, 0);
});

test('local models load only on demand, obey residency limits, and release their worker when disabled', async (t) => {
  const app = await setup(t),
    root = join(app.runtime, 'local-fixture');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(
    join(root, 'dist/embedding-worker.mjs'),
    "import{parentPort}from'node:worker_threads';parentPort.on('message',m=>parentPort.postMessage({id:m.id,vectors:m.texts.map(()=>[1,0])}));",
  );
  Object.defineProperty(app.localModels, 'root', { value: root });
  await app.plugins.enable('local-models');
  await app.router.inference.refresh();
  const catalog = app.router.inference;
  await catalog.saveConnection({
    id: 'local',
    name: 'Local',
    adapterId: 'local-models.onnx',
    deployment: 'local',
    config: {},
  });
  for (const id of ['one', 'two'])
    await catalog.saveModel({
      id,
      name: id,
      connectionId: 'local',
      model: id,
      generation: { enabled: false, inputs: ['text'] },
      embedding: { enabled: true, inputs: ['text'] },
      options: { keepLoaded: true },
    });
  assert.equal(app.localModels.status().loaded, 0);
  await app.embeddings.encode(
    'one',
    [{ content: [{ type: 'text', text: 'first' }] }],
    'query',
    new AbortController().signal,
  );
  assert.equal(app.localModels.status().loaded, 1);
  await app.embeddings.encode(
    'two',
    [{ content: [{ type: 'text', text: 'second' }] }],
    'query',
    new AbortController().signal,
  );
  assert.equal(app.localModels.status().loaded, 1);
  assert.equal(app.localModels.status().models[0].model, 'two');
  await app.localModels.close();
  assert.equal(app.localModels.status().loaded, 0);
  assert(app.plugins.active.has('memory'));
  assert.equal(catalog.models().filter((m) => ['one', 'two'].includes(m.id)).length, 2);
});

test('two Codex model profiles share one connection login and native client without sharing conversation identity', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'shared-codex.mjs'),
    log = join(app.runtime, 'shared-wire.jsonl');
  await writeFile(
    script,
    `import readline from'node:readline';import fs from'node:fs';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method,home:process.env.CODEX_HOME})+String.fromCharCode(10));if(m.id===undefined)continue;console.log(JSON.stringify({id:m.id,result:m.method==='account/read'?{account:{type:'synthetic'}}:{}}));}`,
  );
  await app.router.inference.saveConnection({
    id: 'shared-login',
    name: 'Shared login',
    adapterId: 'worker-codex.provider',
    deployment: 'harness',
    config: { command: process.execPath, args: [script] },
  });
  for (const id of ['model-one', 'model-two'])
    await app.router.inference.saveModel({
      id,
      name: id,
      connectionId: 'shared-login',
      model: 'synthetic',
    });
  const backend = new CodexBackend(app.runtime, app.store);
  app.router.backends.set('codex', backend);
  await backend.authenticate(app.router.profile('model-one'), 'status');
  await backend.authenticate(app.router.profile('model-two'), 'status');
  const events = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.method === 'initialize').length, 1);
  assert(events.every((e) => e.home === join(app.runtime, 'harnesses/codex/shared-login')));
});
