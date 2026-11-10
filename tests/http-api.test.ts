import { listenBrowserHttp, blockedBrowserPorts } from '../packages/kernel/http-listener.ts';
import { version } from '../packages/contracts/version.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ApiBackend } from '../packages/backends/api.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { serve } from '../apps/server/http.ts';
import { setup, project } from './helpers.ts';
import { join } from 'node:path';

test('API streaming accepts fragmented SSE and sends configured reasoning', async (t) => {
  let received: any;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    received = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你');
    res.write('好"},"finish_reason":null}]}\n\n');
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const profile = profileSchema.parse({
    id: 'api',
    name: 'test',
    kind: 'api',
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    model: 'test',
    reasoningStyle: 'enable_thinking',
  });
  let deltas = '';
  const result = await new ApiBackend(async () => undefined).generate({
    profile,
    messages: [{ role: 'user', text: 'hello' }],
    requestId: 'test',
    reasoning: 'off',
    signal: new AbortController().signal,
    onDelta: (d) => (deltas += d),
  });
  assert.equal(result.text, '你好');
  assert.equal(deltas, '你好');
  assert.equal(received.enable_thinking, false);
});
test('API does not blindly retry HTTP errors or an incomplete stream', async () => {
  let calls = 0;
  const profile = profileSchema.parse({
    id: 'api',
    name: 'test',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'test',
  });
  const api = new ApiBackend(async () => undefined, (async () => {
    calls++;
    return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as any);
  await assert.rejects(
    api.generate({
      profile,
      messages: [{ role: 'user', text: 'x' }],
      requestId: 'test',
      signal: new AbortController().signal,
    }),
    /提前结束/,
  );
  assert.equal(calls, 1);
});
test('HTTP requires token and rejects foreign origins and rebinding hosts', async (t) => {
  const app = await setup(t, []);
  const http = await serve(app, { webRoot: join(project, 'dist/web') });
  t.after(() => http.close());
  const url = `http://127.0.0.1:${http.port}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.status', params: {} });
  assert.equal((await fetch(url + '/rpc', { method: 'POST', body })).status, 401);
  assert.equal(
    (
      await fetch(url + '/rpc', {
        method: 'POST',
        body,
        headers: { Authorization: 'Bearer ' + http.token, Origin: 'https://evil.test' },
      })
    ).status,
    403,
  );
  const response = await fetch(url + '/rpc', {
    method: 'POST',
    body,
    headers: { Authorization: 'Bearer ' + http.token },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.version, version);
});
test('MCP exposes only selected operation permissions', async (t) => {
  const app = await setup(t);
  const http = await serve(app, { webRoot: join(project, 'dist/web') });
  t.after(() => http.close());
  const response = await fetch(`http://127.0.0.1:${http.port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + http.token,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(response.status, 200);
  const data: any = await response.json();
  assert(data.result.tools.some((t: any) => t.name === 'memory_recall'));
  assert(!data.result.tools.some((t: any) => t.name === 'memory_save'));
  assert(!data.result.tools.some((t: any) => t.name === 'conversations_send'));
});

test('local HTTP refuses browser-blocked configured ports before binding',async()=>{const server=createServer();await assert.rejects(listenBrowserHttp(server,6667),/浏览器/);assert.equal(server.listening,false);assert(blockedBrowserPorts.has(10080));assert(!blockedBrowserPorts.has(7243));});
