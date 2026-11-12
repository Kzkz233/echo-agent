import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, conversation, FakeBackend, temporary, until } from './helpers.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';
import { EchoError, profileSchema, observationConfigSchema } from '../packages/contracts/index.ts';
import { conversationPermissions } from '../packages/contracts/interaction.ts';
import { nativePiTools } from '../packages/backends/pi-tools.ts';
import { contributeSourceReader } from '../plugins/observation/source-readers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { StdioRpc } from '../packages/backends/rpc.ts';
import { Application } from '../apps/server/application.ts';
import { inferenceTasks } from '../packages/contracts/inference.ts';
import { project as sourceProject } from './helpers.ts';
import { PiBackend } from '../packages/backends/pi.ts';
import { createServer } from 'node:http';
import { z } from 'zod';

test('Pi publishes one progress message and can finish with a structured reply tool', async (t) => {
  const app = await setup(t, []);
  const chat = conversation(app, { kind: 'main' });
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    requests.push(payload);
    const call = requests.length;
    response.setHeader('Content-Type', 'text/event-stream');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {
      role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-reply-' + call, type: 'function', function: {
        name: 'echo_respond', arguments: JSON.stringify({ targetId: 'core.chat', phase: call === 1 ? 'progress' : 'final', messages: call === 1 ? ['Checking the sources.'] : ['Sources confirmed.', 'No archive operation was committed.'] }),
      } }],
    } }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  seedProfile(app, profileSchema.parse({ id: 'test', kind: 'api', name: 'Loopback', model: 'fixture', endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` }));
  const run = await app.router.send({ conversationId: chat.id, text: 'Check the sources', requestId: 'fixture-reply-tool' });
  assert.equal(run.state, 'succeeded', run.error ?? 'Synthetic run did not complete');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools.find((tool: any) => tool.function.name === 'echo_respond').function.parameters.properties.targetId.enum, ['core.chat']);
  assert.equal(run.result, 'Sources confirmed.\n\nNo archive operation was committed.');
  assert.deepEqual(app.store.allMessages(chat.id).filter(m => m.role === 'assistant').map(m => [m.meta.replyPhase, m.text]),
    [['progress', 'Checking the sources.'], ['final', 'Sources confirmed.\n\nNo archive operation was committed.']]);
  assert.deepEqual(app.store.allMessages(chat.id).find(m => m.meta.replyPhase === 'final')?.meta.replyParts,
    ['Sources confirmed.', 'No archive operation was committed.']);
  await until(() => app.deliveries.rows().filter(row => row.state === 'delivered').length === 2);
});

test('Pi receives explicit remaining channel targets after each final submission', async t => {
  const app = await setup(t, []), chat = conversation(app, { kind: 'main' });
  await app.plugins.enable('notifications');
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    if (requests.length === 2) {
      const receipt = JSON.parse(payload.messages.filter((message: any) => message.role === 'tool').at(-1).content);
      assert.deepEqual(receipt.completedTargets, ['core.chat']);
      assert.deepEqual(receipt.remainingTargets, ['notifications.inbox']);
    }
    const targetId = requests.length === 1 ? 'core.chat' : 'notifications.inbox';
    response.setHeader('Content-Type', 'text/event-stream');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {
      role: 'assistant', tool_calls: [{ index: 0, id: 'channel-' + requests.length, type: 'function', function: {
        name: 'echo_respond', arguments: JSON.stringify({ targetId, phase: 'final', messages: ['Fixture ' + targetId] }),
      } }],
    } }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  seedProfile(app, profileSchema.parse({ id: 'test', name: 'Loopback', kind: 'api', model: 'fixture',
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` }));
  const delivery = await app.deliveries.plan(chat.id, 'human', ['core.chat', 'notifications.inbox']);
  const run = await app.router.send({ conversationId: chat.id, requestId: 'multi-channel-receipts', text: 'Report to both selected targets.', delivery });
  assert.equal(run.state, 'succeeded', run.error ?? 'Synthetic run failed');
  assert.equal(requests.length, 2);
  await until(() => app.deliveries.rows().filter(row => row.state === 'delivered').length === 2);
});

test('external hosts are optional worker plugins and cannot bind a main role', async (t) => {
  const app = await setup(t, []);
  assert(!app.router.backends.has('dsh'));
  assert(!app.router.backends.has('codex'));
  await app.plugins.enable('worker-dsh');
  await app.router.inference.refresh();
  seedProfile(app, profileSchema.parse({ id: 'external', name: 'External', kind: 'dsh' }));
  assert(app.router.inference.adapter('worker-dsh.provider').workerOnly);
  const main = conversation(app, { kind: 'main' });
  await assert.rejects(
    app.router.bind(main.id, 'external', new AbortController().signal),
    /子任务/,
  );
  assert(!app.store.binding(main.id));
  await app.plugins.disable('worker-dsh');
  await app.router.inference.refresh();
  assert(!app.router.backends.has('dsh'));
  assert.throws(() => app.router.profile('external'));
});

test('embedding-only model availability does not depend on a generation backend', async (t) => {
  const app = await setup(t, ['local-models']);
  seedProfile(
    app,
    profileSchema.parse({
      id: 'embedding-only',
      name: 'Local embedding',
      kind: 'onnx',
      model: 'synthetic',
    }),
  );
  const profile = app.router.profiles().find((profile) => profile.id === 'embedding-only')!;
  assert.equal(profile.available, true);
  assert('kind' in profile);
  assert.equal(profile.kind, 'onnx');
  assert.equal(app.localModels.status().loaded, 0);
});

test('Pi separates file permissions from approved or explicitly granted Echo mutations', async (t) => {
  const app = await setup(t, []),
    calls = new Map<string, number>(), writes: string[] = [];
  for (const access of ['read', 'write', 'ungranted'])
    app.registry.register({
      name: 'fixture.' + access,
      owner: 'core',
      description: 'Synthetic ' + access,
      permission: 'fixture.' + access,
      mcp: true,
      input: z.object({ marker: z.literal('ok').optional(), uncertain: z.boolean().optional() }),
      output: z.object({ done: z.boolean() }),
      run: (input) => {
        if (access !== 'read') writes.push(access);
        if (input.uncertain) throw new EchoError('fixture_uncertain', 'Synthetic uncertain mutation', true);
        return { done: true };
      },
    });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const input = JSON.parse(raw),
      count = (calls.get(input.model) ?? 0) + 1;
    calls.set(input.model, count);
    if (count > 1) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"Synthetic provider interruption"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call',
                    type: 'function',
                    function: {
                      name: 'fixture_' + (input.model === 'readonly' ? 'read' : 'write'),
                      arguments: input.model === 'invalid' ? '{"marker":"bad"}' : input.model === 'uncertain' ? '{"uncertain":true}' : '{}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((done) => server.close(() => done()));
  });
  const pi = new PiBackend(
    app.registry,
    async () => undefined,
    () => new Set(['fixture.read', 'fixture.write']),
  );
  for (const model of ['readonly', 'write', 'granted', 'invalid', 'uncertain']) {
    const profile = profileSchema.parse({
      id: model,
      name: model,
      kind: 'pi',
      model,
      reasoningStyle: 'none',
      endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    });
    const projectDirectory = await temporary(t);
    const grants = conversationPermissions.parse({ projectDirectory, pi: {
      tools: model === 'write' ? 'ask' : 'read',
      ...(['granted', 'invalid', 'uncertain'].includes(model) ? { echoTools: 'granted' } : {}),
    } });
    if (model === 'granted') {
      const names = pi.toolCatalog({ permissions: grants }).map((tool) => tool.name);
      assert(names.includes('read') && names.includes('fixture_write'));
      assert(!names.includes('write') && !names.includes('fixture_ungranted'));
    }
    await assert.rejects(
      pi.generate({
        profile,
        messages: [{ role: 'user', text: 'Synthetic operation' }],
        requestId: model,
        signal: AbortSignal.timeout(5000),
        ...(model === 'granted' ? {} : { onInteraction: async () => ({ decision: 'allow' as const }) }),
        permissions: grants,
      }),
      // Both writes returned confirmed tool results before the provider failed.
      // A missing final answer must not label those known effects as uncertain.
      (error: any) => error.code === 'pi_failed' && error.uncertain === (model === 'uncertain'),
    );
  }
  assert.deepEqual(writes, ['write', 'write', 'write']);
});

test('Pi retains transport causes and never silently retries a submitted HTTP request', async (t) => {
  const app = await setup(t, []);
  let calls = 0;
  const server = createServer((request) => {
    calls++;
    request.socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((done) => server.close(() => done()));
  });
  const pi = new PiBackend(
    app.registry,
    async () => undefined,
    () => new Set(),
  );
  await assert.rejects(
    pi.generate({
      profile: profileSchema.parse({
        id: 'transport',
        name: 'Transport',
        kind: 'pi',
        model: 'synthetic',
        endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      }),
      messages: [{ role: 'user', text: 'Synthetic' }],
      requestId: 'transport',
      signal: AbortSignal.timeout(5000),
    }),
    (error: any) => !error.uncertain && /UND_ERR_SOCKET|ECONNRESET/.test(error.message),
  );
  assert.equal(calls, 1);
});

test('Pi compatible APIs use max_tokens without OpenAI storage parameters and allow an explicit wire override', async (t) => {
  const app = await setup(t, []),
    bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    bodies.push(JSON.parse(raw));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Compatible' },
              finish_reason: 'stop',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((done) => server.close(() => done()));
  });
  const pi = new PiBackend(
    app.registry,
    async () => undefined,
    () => new Set(),
  );
  for (const maxTokensField of ['auto', 'max_completion_tokens'])
    await pi.generate({
      profile: profileSchema.parse({
        id: 'wire',
        name: 'Wire',
        kind: 'pi',
        model: 'synthetic',
        endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        modelOptions: { maxTokensField },
      }),
      messages: [{ role: 'user', text: 'Synthetic' }],
      requestId: 'wire',
      signal: AbortSignal.timeout(5000),
      toolPolicy: 'none',
    });
  assert.equal(bodies[0].max_tokens, 65536);
  assert.equal(bodies[0].max_completion_tokens, undefined);
  assert.equal(bodies[1].max_completion_tokens, 65536);
  assert.equal(bodies[1].max_tokens, undefined);
  assert(bodies.every((body) => !('store' in body)));
});

test('Pi rejects exhausted thinking budgets and empty completions without treating them as successful JSON', async (t) => {
  const app = await setup(t, []);
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
    }
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', reasoning_content: 'Synthetic reasoning' },
              finish_reason: calls === 1 ? 'length' : 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 2048, total_tokens: 2060 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((done) => server.close(() => done()));
  });
  const pi = new PiBackend(
    app.registry,
    async () => undefined,
    () => new Set(),
  );
  for (const code of ['pi_output_limit', 'pi_empty'])
    await assert.rejects(
      pi.generate({
        profile: profileSchema.parse({
          id: 'budget',
          name: 'Budget',
          kind: 'pi',
          model: 'synthetic',
          endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        }),
        messages: [{ role: 'user', text: 'Synthetic task' }],
        requestId: code,
        toolPolicy: 'none',
        signal: AbortSignal.timeout(5000),
      }),
      (error: any) => {
        assert.equal(error.code, code);
        assert.equal(error.uncertain, false);
        assert.match(error.message, /2048/);
        assert.doesNotMatch(error.message, /Synthetic reasoning/);
        return true;
      },
    );
  assert.equal(calls, 2);
});

test('Review uses Pi or an explicit Worker while observation keeps its plain API transport', async (t) => {
  const app = await setup(t),
    pi = new FakeBackend();
  app.router.useConversationRuntime(app.api, pi);
  let plainCalls = 0;
  app.api.generate = async () => {
    plainCalls++;
    return { text: 'plain observation' };
  };
  const messages = [{ role: 'user' as const, text: 'Synthetic packet' }],
    signal = new AbortController().signal;
  await app.router.infer(inferenceTasks.review, messages, signal);
  assert.equal(pi.calls.length, 1);
  assert.equal(pi.calls[0].toolPolicy, 'none');
  await app.router.infer(inferenceTasks.vision, messages, signal);
  assert.equal(plainCalls, 1);
  const worker = new FakeBackend();
  app.router.backends.set('dsh', worker);
  seedProfile(
    app,
    profileSchema.parse({ id: 'review-worker', name: 'Review Worker', kind: 'dsh' }),
  );
  await app.router.infer(
    inferenceTasks.review,
    messages,
    signal,
    undefined,
    'companion',
    'review-worker',
  );
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].principal, undefined);
  await assert.rejects(
    app.router.infer(
      inferenceTasks.vision,
      messages,
      signal,
      undefined,
      'companion',
      'review-worker',
    ),
    /仅用于 Worker/,
  );
});

test('Review preserves model output budgets independently of thinking and honors task overrides', async (t) => {
  const app = await setup(t), pi = new FakeBackend();
  app.router.useConversationRuntime(app.api, pi);
  seedProfile(app, profileSchema.parse({
    ...app.router.profile('test'), id: 'deepseek', reasoningStyle: 'deepseek',
  }));
  const messages = [{ role: 'user' as const, text: 'Synthetic packet' }];
  const signal = AbortSignal.timeout(5000);
  await app.router.infer(inferenceTasks.review, messages, signal, 'inherit', undefined, 'deepseek');
  await app.router.infer(inferenceTasks.review, messages, signal, 'off', undefined, 'deepseek');
  await app.router.infer(inferenceTasks.review, messages, signal, 'max', undefined, 'deepseek');
  await app.router.infer(inferenceTasks.review, messages, signal, 'inherit', undefined, 'deepseek', {
    maxOutputTokens: 16384,
  });
  assert.deepEqual(pi.calls.map(({ profile }) => profile.maxOutputTokens), [65536, 65536, 65536, 16384]);
  assert.deepEqual(pi.calls.map(({ reasoning }) => reasoning), ['inherit', 'off', 'max', 'inherit']);
});

test('worker adapter migration retains disabled intent across restarts', async (t) => {
  const original = await setup(t, []);
  original.store.set('plugins.intent', { 'worker-dsh': false });
  for (const kind of ['codex', 'dsh'])
    original.store.put('connections', kind, {
      id: kind,
      name: kind,
      adapterId: 'core.' + kind,
      config: {},
      deployment: 'harness',
    });
  await original.close();
  for (let pass = 0; pass < 2; pass++) {
    const app = await Application.create({ runtime: original.runtime, project: sourceProject });
    try {
      assert.equal(
        app.router.inference.connections().find((c) => c.id === 'dsh')?.adapterId,
        'worker-dsh.provider',
      );
      assert.equal(
        app.router.inference.connections().find((c) => c.id === 'codex')?.adapterId,
        'worker-codex.provider',
      );
      assert.equal(app.plugins.intent.get('worker-dsh'), false);
      assert(app.router.backends.has('codex'));
      assert(!app.router.backends.has('dsh'));
    } finally {
      await app.close();
    }
  }
});

test('host waits retain scoped progress and still time out without progress', async (t) => {
  const runtime = await temporary(t, false),
    entry = join(runtime, 'host.mjs');
  await writeFile(
    entry,
    `import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
      const reply=()=>console.log(JSON.stringify({id:r.id,result:{done:true}}));
      if(r.method==='init')return reply(); if(r.method==='stalled')return;
      const timer=setInterval(()=>console.log(JSON.stringify({method:'progress',params:{sessionId:'owned'}})),20);
      setTimeout(()=>{clearInterval(timer);reply()},220);
    });`,
  );
  const host = new StdioRpc(process.execPath, [entry], runtime);
  t.after(async () => {
    await host.close();
    assert(runtime.includes('EchoTests') && /case-[\w-]+$/.test(runtime));
    await rm(runtime, { recursive: true, force: true });
  });
  await host.call('init', {}, 2000);
  let last = Date.now();
  host.subscribe((_method, value) => {
    if (value.sessionId === 'owned') last = Date.now();
  });
  assert((await host.call('working', {}, 100, () => last)).done);
  last = Date.now();
  await assert.rejects(
    host.call('stalled', {}, 100, () => last),
    /未取得回执/,
  );
});

test(
  'native Pi tools execute canonical project paths and reject interpreter aliases and hardlinks',
  { timeout: 45000 },
  async (t) => {
    const root = await temporary(t),
      project = join(root, 'project'),
      data = join(root, 'data');
    await mkdir(project);
    await mkdir(data);
    const native = await nativePiTools(
      {
        profile: profileSchema.parse({ id: 'p', name: 'p', kind: 'pi' }),
        requestId: 'fixture',
        messages: [],
        signal: new AbortController().signal,
        permissions: {
          projectDirectory: project,
          pi: { tools: 'read', terminal: false, projectWrite: false },
        } as any,
      },
      data,
    );
    await writeFile(join(project, 'hello.txt'), 'Hello native Pi');
    const args = { path: 'hello.txt' };
    await native.validate('read', args);
    assert.equal(args.path, join(project, 'hello.txt'));
    const read = native.tools.find((tool) => tool.name === 'read')! as any;
    const result = await read.execute('read1', args, new AbortController().signal);
    assert(JSON.stringify(result).includes('Hello native Pi'));
    for (const path of ['../data', '~/.ssh', '@../data', '.Git/config'])
      await assert.rejects(native.validate('read', { path }));
    await writeFile(join(data, 'private.txt'), 'Private');
    await link(join(data, 'private.txt'), join(project, 'linked.txt'));
    await assert.rejects(native.validate('read', { path: 'linked.txt' }), /硬链接/);
    const full = await nativePiTools({
      profile: profileSchema.parse({ id: 'p', name: 'p', kind: 'pi' }), requestId: 'full',
      messages: [], signal: AbortSignal.timeout(5000),
      permissions: conversationPermissions.parse({ projectDirectory: project, pi: { fullAccess: true } }),
      onInteraction: async () => ({ decision: 'deny' }),
    }, data);
    assert(!full.tools.some((tool) => ['powershell', 'bash'].includes(tool.name)));
    const outside = { path: join(data, 'private.txt') };
    await full.validate('read', outside);
    const fullReader = full.tools.find((tool) => tool.name === 'read')! as any;
    assert(JSON.stringify(await fullReader.execute('full-read', outside, AbortSignal.timeout(5000))).includes('Private'));
  },
);

test('source readers are registered by plugins, remain opt-in and disappear on unload', async (t) => {
  const app = await setup(t);
  app.plugins.add({
    manifest: {
      id: 'custom-browser',
      name: 'Custom browser',
      description: '',
      version: '1',
      dependencies: ['observation'],
      permissions: ['observation.source.provide'],
      settings: [],
    },
    activate(ctx) {
      contributeSourceReader(ctx, 'custom-browser.reader', {
        label: 'Custom UIA browser',
        kind: 'browser',
        strategy: 'uia-document',
        presets: [{ id: 'custom', name: 'Custom', value: 'custom.exe' }],
      });
    },
  });
  await app.plugins.enable('custom-browser');
  const cfg = observationConfigSchema.parse({
    browserAllowlist: [
      { id: 'selected', name: 'Selected', value: 'custom.exe', readerId: 'custom-browser.reader' },
    ],
  });
  const resolved = await app.observations.resolveSourceReaders(cfg);
  assert.equal(resolved.browserAllowlist[0].value, 'custom.exe');
  assert.equal(cfg.allowlist.length, 0);
  assert.equal(
    (await app.observations.resolveSourceReaders(observationConfigSchema.parse({})))
      .browserAllowlist.length,
    0,
  );
  const catalog = await app.automation.catalog(new AbortController().signal);
  assert(JSON.stringify(catalog).includes('custom-browser.reader'));
  await app.plugins.disable('custom-browser');
  assert.notEqual(resolved.revision, app.observations.sourceRevision());
  await assert.rejects(app.observations.resolveSourceReaders(cfg), /未启用/);
});

test('Review backend override resumes the frozen job, preserving completed packets and the original error', async (t) => {
  const app = await setup(t),
    chat = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  seedProfile(app, { ...app.router.profile('test'), id: 'replacement', name: 'Replacement' });
  app.store.append(chat.id, 'user', 'human', 'X'.repeat(18000));
  let count = 0;
  backend.responder = async () => {
    if (++count === 2) throw Error('quota exhausted');
    return { text: '{"notes":"checkpoint","memories":[]}' };
  };
  const job = await app.reviews.start('companion', 'frozen-review');
  await until(() => app.reviews.jobs().find((j) => j.id === job.id)?.state === 'paused');
  const paused = app.reviews.jobs().find((j) => j.id === job.id)!;
  assert.equal(paused.nextPacket, 1);
  // Simulate a paused job written before error-history support existed.
  app.store.put('review-jobs', job.id, { ...paused, errors: undefined });
  backend.responder = async (request) => {
    assert.equal(request.profile.id, 'replacement');
    assert.equal(request.toolPolicy, 'none');
    return { text: '{"notes":"resumed","memories":[]}' };
  };
  await app.registry.call(
    'review.resume',
    { id: job.id, confirmed: true, profileId: 'replacement' },
    internal,
  );
  await until(() => app.reviews.jobs().find((j) => j.id === job.id)?.state === 'completed');
  const completed = app.reviews.jobs().find((j) => j.id === job.id)!;
  assert.deepEqual(completed.packets, paused.packets);
  assert.equal(completed.nextPacket, paused.packets.length);
  assert.equal(completed.errors?.at(-1)?.message, 'quota exhausted');
  assert.equal(backend.calls.length, paused.packets.length + 1);
});

test('Review repairs malformed proposals without inventing sources or rereading a completed response', async (t) => {
  const app = await setup(t),
    chat = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(chat.id, 'user', 'human', 'Synthetic review material');
  let calls = 0;
  backend.responder = async (request) => {
    calls++;
    if (calls === 1)
      return {
        text: '{"notes":"Original notes","memories":[],"actions":[{"title":"Missing source","text":"Unsupported proposal"}]}',
      };
    assert(request.messages[0].text.includes('修复'));
    assert.equal(app.store.documents('memories').length, 0);
    if (calls === 2) throw Error('Synthetic repair interruption');
    return { text: '{"notes":"Original notes","memories":[],"actions":[]}' };
  };
  const job = await app.reviews.start('companion', 'format-repair');
  await until(() => app.reviews.jobs().find((j) => j.id === job.id)?.state === 'paused');
  const paused = app.reviews.jobs().find((j) => j.id === job.id)!;
  assert.equal(paused.nextPacket, 0);
  assert.equal(paused.pending?.repairs, 1);
  assert(paused.pending?.text.includes('Missing source'));
  await app.reviews.execute(job.id);
  const completed = app.reviews.jobs().find((j) => j.id === job.id)!;
  assert.equal(completed.state, 'completed');
  assert.equal(calls, 3);
  assert.equal(completed.pending, undefined);
  assert.equal(completed.repairs?.length, 2);
  assert.equal(app.store.documents('memories').length, 0);
});
