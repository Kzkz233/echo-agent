import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/kernel/store.ts';
import { DshBackend } from '../packages/backends/dsh.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { conversationPermissions } from '../packages/contracts/interaction.ts';

const entry = process.env.ECHO_DSH_ENTRY;
if (!entry) throw Error('Set ECHO_DSH_ENTRY to the official DSH SDK CLI.');
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, 'dsh-permissions-'));
const workspace = root + '-workspaces';
await mkdir(workspace);
const file = join(workspace, 'sample.txt');
await writeFile(file, 'original');
const forbidden = join(workspace, 'forbidden.txt');
let posts = 0,
  approvals = 0;
const requests: any[] = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.method !== 'POST') {
    res.end('{"data":[]}');
    return;
  }
  const request = JSON.parse(body);
  requests.push(request);
  posts++;
  const tool = posts < 4;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = (type: string, data: any) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  frame('message_start', {
    message: {
      id: 'fixture-' + posts,
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  });
  frame('content_block_start', {
    index: 0,
    content_block: tool
      ? {
          type: 'tool_use',
          id: 'call-' + posts,
          name: posts === 1 ? 'read' : posts === 2 ? 'write' : 'pwsh',
          input: {},
        }
      : { type: 'text', text: '' },
  });
  frame('content_block_delta', {
    index: 0,
    delta: tool
      ? {
          type: 'input_json_delta',
          partial_json: JSON.stringify(
            posts === 1
              ? { file_path: file }
              : posts === 2
                ? { file_path: forbidden, content: 'must not exist' }
                : { command: `Set-Content -LiteralPath '${forbidden}' -Value 'must not exist'` },
          ),
        }
      : { type: 'text_delta', text: 'Read-only policy fixture complete.' },
  });
  frame('content_block_stop', { index: 0 });
  frame('message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  frame('message_stop', {});
  res.end();
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const store = new Store(join(root, 'echo.sqlite'));
const backend = new DshBackend(root, store, async () => 'synthetic-key');
try {
  const profile = profileSchema.parse({
    id: 'fixture',
    name: 'Fixture',
    kind: 'dsh',
    provider: 'deepseek-official',
    command: process.env.ECHO_DSH_COMMAND ?? process.execPath,
    args: [entry, '--profile', 'sdk-minimal'],
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/anthropic`,
    model: 'deepseek-flash',
    apiKeyRef: 'fixture',
    timeoutMs: 60000,
  });
  const result = await backend.generate({
    profile,
    requestId: 'policy-fixture',
    messages: [{ role: 'user', text: 'Read the fixture, then try the synthetic tool requests.' }],
    signal: AbortSignal.timeout(90000),
    permissions: conversationPermissions.parse({
      projectDirectory: workspace,
      pi: { projectWrite: false, terminal: false },
      dsh: { approvals: 'ask' },
    }),
    onInteraction: async () => {
      approvals++;
      return { decision: 'allow' };
    },
  });
  assert.match(result.text, /fixture complete/);
  assert.equal(posts, 4);
  assert.equal(approvals, 0);
  assert.equal(await readFile(file, 'utf8'), 'original');
  await assert.rejects(access(forbidden));
  const messages = JSON.stringify(requests.at(-1).messages);
  assert.match(messages, /original/);
  assert.match(messages, /read.only|not authorized|denied/i);
  assert.match(
    messages,
    /Terminal execution is not authorized|not available|not found|Unknown tool/i,
  );
  console.log(
    JSON.stringify({
      ok: true,
      root,
      inference: 'loopback fixture only',
      posts,
      approvals,
      originalPreserved: true,
      writeDenied: true,
      terminalDenied: true,
    }),
  );
} finally {
  await backend.close();
  store.close();
  await new Promise<void>((done) => server.close(() => done()));
}
