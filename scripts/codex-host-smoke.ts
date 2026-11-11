/** Optional native-host acceptance: installed Codex, isolated home, loopback-only model fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CodexBackend } from '../packages/backends/codex.ts';
import { Store } from '../packages/kernel/store.ts';
import { profileSchema } from '../packages/contracts/index.ts';

const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'codex-native-'));
const store = new Store(join(runtime, 'echo.sqlite'));
let requests = 0,
  toolCalls = 0,
  toolVisible = false,
  toolResultVisible = false;
const routes: string[] = [];
const server = createServer(async (req, res) => {
  const route = req.url ?? '';
  routes.push(route);
  if (!route.endsWith('/responses')) {
    req.resume();
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests++;
  toolVisible ||= JSON.stringify(
    body.tools ?? body.input?.filter((item: any) => item.type === 'additional_tools') ?? [],
  ).includes('fixture_read');
  toolResultVisible ||= JSON.stringify(body.input).includes('SYNTHETIC_TOOL_RESULT');
  const call = requests === 1;
  const item = call
    ? {
        id: 'fc_fixture',
        type: 'function_call',
        call_id: 'call_fixture',
        name: 'fixture_read',
        arguments: '{}',
      }
    : {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'SYNTHETIC_HOST_OK', annotations: [] }],
      };
  const response = {
    id: 'resp_fixture_' + requests,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: body.model,
    output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, ...(call ? { arguments: '' } : { content: [] }) },
    },
    ...(call
      ? [
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            item_id: item.id,
            delta: '{}',
          },
        ]
      : [
          {
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: 'SYNTHETIC_HOST_OK',
          },
        ]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    events
      .map((event) => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
      .join(''),
  );
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const backend = new CodexBackend(runtime, store, {
  list: () => [
    {
      name: 'fixture.read',
      owner: 'core',
      description: 'Synthetic read-only acceptance tool',
      permission: 'fixture.read',
      mcp: true,
      input: z.object({}),
      output: z.unknown(),
      run: () => ({}),
    },
  ],
  call: async (_principal, name) => {
    assert.equal(name, 'fixture.read');
    toolCalls++;
    return { value: 'SYNTHETIC_TOOL_RESULT' };
  },
});
try {
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const profile = profileSchema.parse({
    id: 'native-fixture',
    name: 'Native fixture',
    kind: 'codex',
    command: 'codex',
    args: [
      '-c',
      'model_provider="echo_fixture"',
      '-c',
      `model_providers.echo_fixture={name="Echo fixture",base_url="${baseUrl}",wire_api="responses",requires_openai_auth=false}`,
      '-c',
      'web_search="disabled"',
      'app-server',
    ],
    model: 'gpt-6.1-sol',
    timeoutMs: 15000,
  });
  const result = await backend.generate({
    profile,
    messages: [{ role: 'user', text: 'Read the synthetic fixture and report its result.' }],
    requestId: 'native-fixture',
    principal: { conversationId: 'fixture', personaId: 'fixture' },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(result.text, 'SYNTHETIC_HOST_OK');
  assert.equal(toolCalls, 1);
  assert.equal(requests, 2);
  assert(toolVisible && toolResultVisible);
  const report = {
    passed: true,
    installedHost: true,
    isolatedHome: true,
    modelEndpoint: 'loopback fixture',
    toolCalls,
    requests,
  };
  await writeFile('test-results/codex-host-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(
    JSON.stringify({
      routes,
      requests,
      toolCalls,
      toolVisible,
      toolResultVisible,
      error: String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await backend.close();
  store.db.close();
  server.closeAllConnections();
  server.close();
}
