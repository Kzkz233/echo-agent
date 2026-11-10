import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Application } from '../apps/server/application.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { DshBackend } from '../packages/backends/dsh.ts';
import { verifyHostApplication } from './host-application-steps.ts';
import { serve } from '../apps/server/http.ts';
const bin = process.env.ECHO_DSH_ENTRY;
if (!bin) throw Error('Set ECHO_DSH_ENTRY to the official DSH SDK CLI lib/bin.js.');
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'dsh-native-'));
const app = await Application.create({
  runtime,
  project: resolve(import.meta.dirname, '..'),
  plugins: [],
});
let calls = 0,
  captured: any;
const protocol = process.env.ECHO_DSH_API ?? 'openai-responses';
const efforts: (string | undefined)[] = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"data":[]}');
    return;
  }
  calls++;
  captured = JSON.parse(body);
  efforts.push(captured.reasoning?.effort ?? captured.reasoning_effort);
  const output = body.includes('角色记忆整理')
    ? '{"notes":"Native DSH Review read the complete material.","memories":[]}'
    : 'Native DSH fixture response.';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = (type: string, data: any) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  if (req.url?.endsWith('/responses')) {
    const item = {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: output, annotations: [] }],
    };
    const response = {
      id: 'resp_fixture',
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: 'synthetic',
      output: [item],
      usage: { input_tokens: 20, output_tokens: 6, total_tokens: 26 },
    };
    frame('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    frame('response.output_item.added', {
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    });
    frame('response.output_text.delta', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: output,
    });
    frame('response.output_item.done', { output_index: 0, item });
    frame('response.completed', { response });
    res.end();
    return;
  }
  if (req.url?.endsWith('/chat/completions')) {
    const chunk = {
      id: 'chatcmpl_fixture',
      object: 'chat.completion.chunk',
      model: 'synthetic',
      created: Math.floor(Date.now() / 1000),
    };
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
    return;
  }
  frame('message_start', {
    message: {
      id: 'fixture',
      type: 'message',
      role: 'assistant',
      model: 'synthetic',
      content: [],
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  });
  frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  frame('content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: output },
  });
  frame('content_block_stop', { index: 0 });
  frame('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 6 },
  });
  frame('message_stop', {});
  res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port;
const backend = new DshBackend(runtime, app.store, async () => 'local-fixture-only');
app.router.backends.set('dsh', backend);
const http = await serve(app, { webRoot: join(app.knowledge.project, 'dist/web') });
try {
  const profile = profileSchema.parse({
    id: 'native-dsh',
    name: 'test',
    kind: 'dsh',
    command: process.env.ECHO_DSH_COMMAND || process.execPath,
    args: [
      ...JSON.parse(process.env.ECHO_DSH_RUNTIME_ARGS || '[]'),
      bin,
      '--profile',
      'sdk-minimal',
    ],
    provider: process.env.ECHO_DSH_PROVIDER ?? 'custom',
    api: protocol,
    endpoint: `http://127.0.0.1:${port}/v1`,
    model: 'synthetic',
    apiKeyRef: 'fixture',
    reasoning: 'xhigh',
    timeoutMs: 120000,
  });
  const sessionId = await backend.createSession(profile, [
    { role: 'assistant', text: 'Imported fictional reply.' },
  ]);
  const result = await backend.generate({
    profile,
    sessionId,
    requestId: 'native-one',
    messages: [
      {
        role: 'system',
        text: 'PERSONA_SENTINEL: fictional companion. MEMORY_SENTINEL: fictional cat Cloud.',
      },
      { role: 'user', text: 'Return the fixture sentence.' },
    ],
    reasoning: 'off',
    signal: new AbortController().signal,
  });
  if (!result.text.includes('Native DSH fixture response.'))
    throw Error('Native DSH response missing');
  const text = JSON.stringify(captured);
  if (
    !text.includes('PERSONA_SENTINEL') ||
    !text.includes('MEMORY_SENTINEL') ||
    !text.includes('Imported fictional')
  )
    throw Error('DSH prompt missing context');
  const application = await verifyHostApplication(app, profile, () => {
    if (!JSON.stringify(captured?.tools).includes('memory_recall'))
      throw Error('Echo MCP tools missing from native DSH request');
    return captured;
  });
  if (
    protocol !== 'anthropic-messages' &&
    (efforts[0] === 'high' || !efforts.slice(1).every((value) => value === 'high'))
  )
    throw Error('DSH did not apply off / xhigh-to-high reasoning per turn');
  console.log(
    JSON.stringify({
      protocol,
      provider: profile.provider,
      perTurnReasoning:
        protocol === 'anthropic-messages' ? 'not inspected' : 'off / xhigh mapped to high',
      nativeHandshake: true,
      personaAndMemoryReachedModel: true,
      nativeAssistant: true,
      ...application,
      echoMcpToolsReachedModel: true,
      calls,
      paidCalls: 0,
      isolatedHome: runtime,
    }),
  );
} finally {
  await backend.close();
  await http.close();
  await new Promise<void>((r) => server.close(() => r()));
  await app.close();
}
