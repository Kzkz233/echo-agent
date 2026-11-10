import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StdioRpc } from '../packages/backends/rpc.ts';
import { Application } from '../apps/server/application.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { verifyHostApplication } from './host-application-steps.ts';
import { CodexBackend } from '../packages/backends/codex.ts';
import { serve } from '../apps/server/http.ts';
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const home = await mkdtemp(join(base, 'codex-native-'));
let calls = 0;
let captured: any;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  if (!req.url?.endsWith('/responses')) {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"data":[]}');
    return;
  }
  calls++;
  captured = JSON.parse(body);
  const output = body.includes('角色记忆整理')
    ? '{"notes":"Native Codex Review read the complete material.","memories":[]}'
    : 'Native Codex fixture response.';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let sequence = 0;
  const emit = (type: string, value: any) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
    );
  const item = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: output, annotations: [] }],
  };
  emit('response.created', {
    response: {
      id: 'resp_fixture',
      object: 'response',
      created_at: 1,
      status: 'in_progress',
      output: [],
    },
  });
  emit('response.output_item.added', {
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  emit('response.content_part.added', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  emit('response.output_text.delta', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: output,
  });
  emit('response.output_text.done', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text: output,
  });
  emit('response.content_part.done', {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: item.content[0],
  });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', {
    response: {
      id: 'resp_fixture',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'synthetic',
      output: [item],
      usage: {
        input_tokens: 20,
        output_tokens: 6,
        total_tokens: 26,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  });
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port;
await writeFile(
  join(home, 'config.toml'),
  `model = "synthetic"\nmodel_provider = "synthetic"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.synthetic]\nname = "Echo test only"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "ECHO_SYNTHETIC_KEY"\n`,
);
const connect = () =>
  new StdioRpc(process.env.ECHO_CODEX_BINARY ?? 'codex', ['app-server'], home, {
    ...process.env,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    ECHO_SYNTHETIC_KEY: 'local-fixture-only',
  });
let rpc = connect();
try {
  await rpc.call('initialize', {
    clientInfo: { name: 'echo_verification', title: 'Echo isolated test', version: '0.2.0' },
    capabilities: { experimentalApi: true },
  });
  rpc.notify('initialized');
  const catalog=await rpc.call('model/list',{includeHidden:true,limit:100});
  const fixtureModel=catalog.data?.find((m:any)=>m.supportedReasoningEfforts?.length)?.model;
  if(!fixtureModel)throw Error('Native fixture has no model capability catalog');
  const response = await rpc.call('thread/start', {
    cwd: home,
    model: fixtureModel,
    modelProvider: 'synthetic',
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  const threadId = response.thread.id;
  await rpc.call('thread/inject_items', {
    threadId,
    items: [
      {
        type: 'message',
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: 'PERSONA_SENTINEL: A fictional companion. MEMORY_SENTINEL: Fictional cat named Cloud.',
          },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Imported fictional assistant message.' }],
      },
    ],
  });
  let text = '';
  const done = new Promise<void>((resolve, reject) => {
    const off = rpc.subscribe((method, params) => {
      if (params?.threadId !== threadId) return;
      if (method === 'item/completed' && params.item?.type === 'agentMessage')
        text = params.item.text;
      if (method === 'turn/completed') {
        off();
        params.turn?.status === 'completed'
          ? resolve()
          : reject(Error('Native turn ' + params.turn?.status));
      }
    });
  });
  await rpc.call('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Reply with the fixture sentence.' }],
    effort: 'none',
  });
  await Promise.race([
    done,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('Native turn timeout')), 30000).unref(),
    ),
  ]);
  const serialized = JSON.stringify(captured);
  if (
    !serialized.includes('PERSONA_SENTINEL') ||
    !serialized.includes('MEMORY_SENTINEL') ||
    !serialized.includes('Imported fictional assistant')
  )
    throw Error('Native prompt lost context');
  if (!text.includes('Native Codex fixture response')) throw Error('Native response missing');
  const eventDone = new Promise<void>((resolve, reject) => {
    const off = rpc.subscribe((method, params) => {
      if (params?.threadId !== threadId || method !== 'turn/completed') return;
      off();
      params.turn?.status === 'completed'
        ? resolve()
        : reject(Error('Native application turn ' + params.turn?.status));
    });
  });
  await rpc.call('turn/start', {
    threadId,
    input: [],
    toolOutput: { name: 'echo_application_event', output: 'APPLICATION_EVENT_SENTINEL' },
    effort: 'none',
  });
  await Promise.race([
    eventDone,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('Native application turn timeout')), 30000).unref(),
    ),
  ]);
  const eventInput = captured.input.find((item: any) =>
    JSON.stringify(item).includes('APPLICATION_EVENT_SENTINEL'),
  );
  if (eventInput?.type !== 'function_call_output' || eventInput?.role === 'user')
    throw Error(
      'Application event lost its non-human protocol author: ' + JSON.stringify(eventInput),
    );
  await rpc.close();
  rpc = connect();
  await rpc.call('initialize', {
    clientInfo: { name: 'echo_verification', title: 'Echo isolated test', version: '0.2.0' },
    capabilities: { experimentalApi: true },
  });
  rpc.notify('initialized');
  await rpc.call('thread/resume', { threadId });
  const resumed = await rpc.call('thread/read', { threadId, includeTurns: true });
  if ((resumed.thread?.turns?.length ?? 0) < 2)
    throw Error('Native thread did not survive host release');
  await rpc.call('thread/archive', { threadId });
  const runtime = join(home, 'echo-runtime'),
    nativeHome = join(runtime, 'harnesses/codex/native-codex');
  await mkdir(nativeHome, { recursive: true });
  await copyFile(join(home, 'config.toml'), join(nativeHome, 'config.toml'));
  const previousKey = process.env.ECHO_SYNTHETIC_KEY;
  process.env.ECHO_SYNTHETIC_KEY = 'local-fixture-only';
  const app = await Application.create({
    runtime,
    project: resolve(import.meta.dirname, '..'),
    plugins: [],
  });
  let application;
  const http = await serve(app, { webRoot: join(app.knowledge.project, 'dist/web') });
  const mcpRequests: string[] = [];
  http.server.on('request', (req, res) => {
    if (req.url === '/mcp') res.on('finish', () => mcpRequests.push(req.method + ' ' + res.statusCode));
  });
  try {
    application = await verifyHostApplication(
      app,
      profileSchema.parse({
        id: 'native-codex',
        name: 'Native fixture',
        kind: 'codex',
        command: process.env.ECHO_CODEX_BINARY || 'codex',
        args: ['app-server'],
        model: fixtureModel,
        reasoning: 'off',
        timeoutMs: 30000,
      }),
      () => captured,
      async () => {
        await (app.router.backends.get('codex') as CodexBackend).releaseConnection('native-codex');
      },
    );
    const tools = await app.registry.call('conversations.tools', { id: 'host-native-codex' }, { kind: 'ui', permissions: new Set(['*']) });
    if (!tools.includes('memory_recall')) throw Error('Native tool catalog did not discover Echo dynamic tools.');
    const binding = app.store.binding('host-native-codex')!;
    const native = app.store.document<{ nativeId: string; toolsHash?: string }>('codex-sessions', binding.sessionId!)!;
    if (!native.nativeId || !native.toolsHash)
      throw Error('Codex thread did not store its session-scoped Echo tool catalog.');
  } finally {
    await http.close();
    await app.close();
    if (previousKey === undefined) delete process.env.ECHO_SYNTHETIC_KEY;
    else process.env.ECHO_SYNTHETIC_KEY = previousKey;
  }
  console.log(
    JSON.stringify({
      nativeHandshake: true,
      historyImport: true,
      personaAndMemoryReachedModel: true,
      completedAssistant: true,
      nativeApplicationEvent: 'function_call_output, not a user message',
      resumedAfterHostRestart: true,
      ...application,
      echoDynamicToolsInNativeCatalog: true,
      calls,
      paidCalls: 0,
      isolatedHome: home,
    }),
  );
} finally {
  await rpc.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
