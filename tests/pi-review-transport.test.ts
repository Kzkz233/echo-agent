import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import { PiBackend } from '../packages/backends/pi.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { conversationPermissions } from '../packages/contracts/interaction.ts';
import { setup } from './helpers.ts';

const event = (value: object) => 'data: ' + JSON.stringify(value) + '\n\n';
function output(items: any[]) {
  return items.map((item, output_index) => event({ type: 'response.output_item.added', output_index,
    item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } }) +
    event({ type: 'response.output_item.done', output_index, item })).join('') +
    event({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: items,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
}

test('Responses review-sized tool loops retain valid pairs before and after compaction; upstream failure is not retried', async t => {
  const app = await setup(t, []);
  let tools = 0, summaries = 0;
  app.registry.register({ owner: 'core', name: 'fixture.read', description: 'Synthetic read',
    permission: 'fixture.read', mcp: true, input: z.object({ part: z.number() }), output: z.unknown(),
    run: ({ part }) => { tools++; return part === 1 ? 'a'.repeat(32000) : part === 2 ? 'b'.repeat(156000) : { staged: true }; } });
  const requests: any[] = [], items: any[] = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = JSON.parse(text); requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'fixture-request' });
    if (body.reasoning?.effort === 'none') {
      summaries++;
      res.end(output([{ id: 'summary_fixture', type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'Earlier material was read. Continue the current task.' }] }]));
    } else if (requests.length === 1) {
      res.end(output([1, 2].map(part => ({ id: 'item_fixture_' + part, type: 'function_call',
        call_id: 'call_fixture_' + part, name: 'fixture_read', arguments: JSON.stringify({ part }) }))));
    } else if (tools === 2) {
      res.end(output([{ id: 'item_fixture_3', type: 'function_call', call_id: 'call_fixture_3',
        name: 'fixture_read', arguments: '{"part":3}' }]));
    } else {
      res.end(event({ type: 'response.failed', response: { id: 'resp_failure', status: 'failed',
        error: { code: 'upstream_error', message: 'Upstream request failed' } } }));
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const pi = new PiBackend(app.registry, async () => 'fixture-secret', () => new Set(['fixture.read']));
  const profile = profileSchema.parse({ id: 'fixture', kind: 'pi', name: 'Fixture', model: 'synthetic',
    protocol: 'openai-responses', reasoningStyle: 'deepseek', reasoning: 'inherit', maxOutputTokens: 128000,
    contextChars: 256000, endpoint: `http://127.0.0.1:${(server.address() as any).port}` });
  await assert.rejects(pi.generate({ profile, requestId: 'review-transport-fixture',
    messages: [{ role: 'system', text: 'Stable fixture role' }, { role: 'user', text: 'Earlier material '.repeat(10000) }],
    compaction: { triggerTokens: 256000, keepRecentPercent: 10 },
    permissions: conversationPermissions.parse({ pi: { tools: 'none', echoTools: 'granted' } }),
    onItem: item => items.push(item), signal: AbortSignal.timeout(10000) }), /upstream_error: Upstream request failed/);
  assert.equal(tools, 3);
  assert.equal(summaries, 1);
  assert.equal(requests.length, 4);
  assert(items.some(item => item.id === 'context-compaction' && item.state === 'completed'));
  const diagnostic = JSON.parse(items.find(item => item.id === 'provider-request-failure').detail);
  assert.equal(diagnostic.protocol, 'openai-responses');
  assert.equal(diagnostic.step, 3);
  assert.equal(diagnostic.httpStatus, 200);
  assert.equal(diagnostic.errorCode, 'upstream_error');
  assert.equal(diagnostic.terminalEvent, 'response.failed');
  assert.equal(diagnostic.maxOutputTokens, 128000);
  assert.equal(diagnostic.responseHeaders['x-request-id'], 'fixture-request');
  assert.equal(diagnostic.bytes, Buffer.byteLength(JSON.stringify(requests.at(-1))));
  assert(!JSON.stringify(diagnostic).includes('fixture-secret'));
  assert(!JSON.stringify(diagnostic).includes('Earlier material'));
  for (const body of requests) {
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.max_output_tokens, body.reasoning?.effort === 'none' ? 2048 : 128000);
    assert(!body.input.some((item: any) => item.role === 'developer'));
    const calls = body.input.filter((item: any) => item.type === 'function_call').map((item: any) => item.call_id).sort();
    const results = body.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.call_id).sort();
    assert.deepEqual(calls, results);
    assert.equal(new Set(calls).size, calls.length);
  }
});

test('HTTP gateway failure records status without retaining error HTML, credentials or retrying', async t => {
  const app = await setup(t, []);
  let requests = 0;
  const items: any[] = [];
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(504, { 'Content-Type': 'text/html', 'x-request-id': 'gateway-fixture',
      'set-cookie': 'fixture-private-cookie', 'authorization': 'fixture-private-key' });
    res.end('<html>Gateway timeout</html>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const pi = new PiBackend(app.registry, async () => 'fixture-private-key');
  await assert.rejects(pi.generate({ profile: profileSchema.parse({ id: 'fixture', name: 'Fixture', kind: 'pi',
    protocol: 'openai-responses', model: 'fixture', endpoint: `http://127.0.0.1:${(server.address() as any).port}` }),
    messages: [{ role: 'user', text: 'Private synthetic message' }], toolPolicy: 'none',
    requestId: 'gateway-fixture', onItem: item => items.push(item), signal: AbortSignal.timeout(5000) }), /504/);
  assert.equal(requests, 1);
  const diagnostic = JSON.parse(items.find(item => item.id === 'provider-request-failure').detail);
  assert.equal(diagnostic.httpStatus, 504);
  assert.equal(diagnostic.responseHeaders['x-request-id'], 'gateway-fixture');
  assert(!JSON.stringify(diagnostic).match(/Private synthetic|private-key|private-cookie|<html>/));
});
