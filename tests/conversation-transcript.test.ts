import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { Application } from '../apps/server/application.ts';
import { PiBackend } from '../packages/backends/pi.ts';
import { Store } from '../packages/kernel/store.ts';
import { historyGroups } from '../packages/kernel/conversation-history.ts';
import { conversation, project, temporary } from './helpers.ts';
import { seedProfile, seedRoutes } from '../scripts/inference-fixture.ts';
import { generationProtocol, profileSchema } from '../packages/contracts/index.ts';
import type { TranscriptMessage } from '../packages/contracts/transcript.ts';

const sse = (value: any) => (value.type ? 'event: ' + value.type + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n';
function deferredCleanup(callbacks: (() => Promise<void>)[]): TestContext {
  return { after: (fn: () => Promise<void>) => { callbacks.push(fn); } } as unknown as TestContext;
}
function answer(protocol: string, step: number, name?: string, args: unknown = {}, text = 'Synthetic final answer') {
  const id = 'call_' + step;
  if (protocol === 'openai-completions') return sse({ choices: [{ index: 0, delta: { role: 'assistant',
    ...(name ? { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
      : { content: text }) }, finish_reason: name ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n';
  if (protocol === 'openai-responses') {
    const item = name ? { type: 'function_call', id: 'fc_' + step, call_id: id, name, arguments: JSON.stringify(args) }
      : { type: 'message', id: 'msg_' + step, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    return sse({ type: 'response.output_item.added', output_index: 0,
      item: name ? { ...item, arguments: '' } : { ...item, content: [] } }) +
      sse({ type: 'response.output_item.done', output_index: 0, item }) +
      sse({ type: 'response.completed', response: { id: 'resp_' + step, status: 'completed', output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
  }
  return [
    { type: 'message_start', message: { id: 'msg_' + step, type: 'message', role: 'assistant', model: 'fixture',
      content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: name ? { type: 'tool_use', id, name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: name ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ].map(sse).join('');
}
function pairs(protocol: string, body: any) {
  const messages = body.input ?? body.messages;
  if (protocol === 'openai-responses') return {
    calls: messages.filter((m: any) => m.type === 'function_call').map((m: any) => m.call_id),
    results: messages.filter((m: any) => m.type === 'function_call_output').map((m: any) => m.call_id),
  };
  if (protocol === 'anthropic-messages') return {
    calls: messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'tool_use').map((p: any) => p.id) : []),
    results: messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'tool_result').map((p: any) => p.tool_use_id) : []),
  };
  return { calls: messages.flatMap((m: any) => (m.tool_calls ?? []).map((p: any) => p.id)),
    results: messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id) };
}

async function fixture(t: TestContext, protocol: string, next: (body: any, step: number) => string,
  options: Record<string, unknown> = {}, readOutput = (_part?: number) => 'EVIDENCE_SENTINEL_7429') {
  const cleanup: (() => Promise<void>)[] = [];
  const runtime = await temporary(deferredCleanup(cleanup)), requests: any[] = [];
  let serverError: unknown, app: Application, reads = 0, committedBeforeExecution = false;
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); requests.push(body);
      const output = next(body, requests.length);
      // Each fixture owns a short-lived loopback server. Do not leave pooled
      // sockets pointing at a port the OS may immediately give another fixture.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' }); res.end(output);
    } catch (error) { serverError = error; res.writeHead(400); res.end('{"error":{"message":"Fixture failed"}}'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  t.after(() => { if (serverError) throw serverError; });
  const open = async () => {
    app = await Application.create({ runtime, project, plugins: [] });
    app.registry.register({ name: 'fixture.read', owner: 'core', description: 'Synthetic plugin tool',
      permission: 'fixture.read', mcp: true, input: z.object({ part: z.number().optional() }), output: z.string(),
      run: ({ part }) => {
        reads++;
        committedBeforeExecution = app.store.modelMessages(chat.id).some(message =>
          (message.meta.native as any)?.content.some((part: any) => part.type === 'toolCall' && part.name === 'fixture_read'));
        return readOutput(part);
      } });
    app.router.backends.set('pi', new PiBackend(app.registry, async () => undefined, () => new Set(['fixture.read'])));
    seedProfile(app, profileSchema.parse({ id: 'fixture', kind: 'pi', name: 'Synthetic model', model: 'fixture', protocol,
      reasoningStyle: 'none', endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`, ...options }));
    seedRoutes(app, { chat: 'fixture' });
  };
  await open();
  const chat = conversation(app!, { kind: 'main' });
  t.after(async () => { await app.close(); for (const fn of cleanup) await fn(); });
  return { get app() { return app; }, requests, chat, get reads() { return reads; },
    get committedBeforeExecution() { return committedBeforeExecution; },
    restart: async () => { await app.close(); await open(); } };
}

for (const protocol of generationProtocol.options) test(protocol + ' restores all plugin tool calls across user turns and process restart', async t => {
  const f = await fixture(t, protocol, (body, step) => {
    if (step > 1) {
      assert(JSON.stringify(body.input ?? body.messages).includes('EVIDENCE_SENTINEL_7429'));
      const history = pairs(protocol, body);
      assert.deepEqual([...history.calls].sort(), [...history.results].sort());
      assert(history.calls.includes('call_1'));
    }
    return answer(protocol, step, step === 1 ? 'fixture_read' : 'echo_respond', step === 1 ? { part: 1 }
      : { targetId: 'core.chat', phase: 'final', messages: ['Synthetic answer without the evidence.'] });
  });
  const send = async (id: string) => {
    const run = await f.app.router.send({ conversationId: f.chat.id, requestId: id, text: id });
    assert.equal(run.state, 'succeeded', JSON.stringify({ error: run.error, requests: f.requests.length,
      diagnostics: f.app.router.execution.list(run.id).filter(item => item.id === 'provider-request-failure') }));
  };
  await send('first'); await send('followup');
  assert.equal(f.reads, 1);
  assert(f.committedBeforeExecution, 'The assistant action must be durable before its tool can run');
  const original = f.app.store.allMessages(f.chat.id);
  await f.restart();
  assert.deepEqual(f.app.store.allMessages(f.chat.id), original);
  await send('after-restart');
  assert.equal(f.reads, 1, 'Reading historical calls must never execute them');
  assert.equal(f.app.store.allMessages(f.chat.id).length, 6, 'Native history does not duplicate visible messages or Review evidence');
  assert(f.app.store.modelMessages(f.chat.id).some(message => message.role === 'tool' && message.text.includes('EVIDENCE_SENTINEL')));
});

for (const mode of ['between runs', 'during execution']) test('automatic compaction ' + mode + ' retains recent tool pairs and survives restart', async t => {
  const protocol = 'openai-completions';
  let steps = 0, summaries = 0;
  const f = await fixture(t, protocol, (body, request) => {
    if (!(body.tools ?? []).some((tool: any) => tool.function.name === 'fixture_read')) {
      summaries++;
      return answer(protocol, request, undefined, {}, 'SUMMARY: older material was read; preserve the task and use the latest confirmed evidence.');
    }
    steps++;
    const history = pairs(protocol, body);
    assert.deepEqual([...history.calls].sort(), [...history.results].sort());
    if (steps >= 4) {
      assert(summaries > 0);
      assert(JSON.stringify(body.messages).includes('SUMMARY:'));
      assert(JSON.stringify(body.messages).includes('EVIDENCE_SENTINEL_7429'));
      assert(history.calls.length > 0, 'Recent native calls must survive alongside the summary');
    }
    return answer(protocol, request, steps <= 2 ? 'fixture_read' : 'echo_respond', steps <= 2 ? { part: steps }
      : { targetId: 'core.chat', phase: 'final', messages: ['Synthetic final reply.'] });
  }, { contextChars: 80000, maxOutputTokens: 512 }, part => part === 1 ? 'old material '.repeat(1200) : 'EVIDENCE_SENTINEL_7429');
  const policy = { triggerTokens: 3000, keepRecentPercent: 20 };
  if (mode === 'during execution') f.app.store.saveConversation({ ...f.chat, compaction: policy });
  const first = await f.app.router.send({ conversationId: f.chat.id, requestId: 'large-first',
    text: 'Initial task '.repeat(mode === 'during execution' ? 100 : 1000) });
  assert.equal(first.state, 'succeeded', first.error ?? 'First run failed');
  const initialSummaries = summaries;
  if (mode === 'during execution') assert(initialSummaries > 0);
  if (mode === 'between runs') f.app.store.saveConversation({ ...f.chat, compaction: policy });
  const next = await f.app.router.send({ conversationId: f.chat.id, requestId: 'after-compaction', text: 'Continue' });
  assert.equal(next.state, 'succeeded', next.error ?? 'Continuation failed');
  if (mode === 'during execution') assert.equal(summaries, initialSummaries,
    'The in-run checkpoint must be reused, not recomputed at the next turn');
  const snapshot = f.app.store.document<any>('conversation-compactions', f.chat.id);
  assert.equal(snapshot.version, 2); assert(snapshot.through > 0);
  assert.equal(f.reads, 2);
  const original = f.app.store.allMessages(f.chat.id);
  await f.restart();
  assert.deepEqual(f.app.store.allMessages(f.chat.id), original);
  const restored = await f.app.router.send({ conversationId: f.chat.id, requestId: 'restored-compaction', text: 'Continue after restart' });
  assert.equal(restored.state, 'succeeded', restored.error ?? 'Restored run failed');
  assert.equal(f.reads, 2);
});

test('Pi child work sessions keep native history while task authority and available tools are recalculated', async t => {
  const protocol = 'openai-completions';
  const f = await fixture(t, protocol, (body, step) => {
    if (step > 1) assert(JSON.stringify(body.messages).includes('EVIDENCE_SENTINEL_7429'));
    if (step === 3) assert(!body.tools.some((tool: any) => tool.function.name === 'fixture_read'));
    return step === 1 ? answer(protocol, step, 'fixture_read') : answer(protocol, step, undefined, {}, 'Task finished');
  });
  const work = f.app.router.workSessions.register({ id: 'synthetic-review', title: 'Synthetic Review worker',
    personaId: f.chat.personaId, parentConversationId: f.chat.id,
    origin: { type: 'automation', owner: 'review', id: 'review-fixture', name: 'Synthetic Review' } });
  const run = await f.app.router.workSessions.run({ id: work.id, profileId: 'fixture', requestId: 'worker-first',
    text: 'Read and update the configured records' }, AbortSignal.timeout(10000));
  assert.equal(run.state, 'succeeded', run.error ?? 'Worker failed');
  // Revoking executable tools must not erase history or re-grant prior access.
  f.app.router.backends.set('pi', new PiBackend(f.app.registry, async () => undefined, () => new Set()));
  const followup = await f.app.router.workSessions.run({ id: work.id, profileId: 'fixture', requestId: 'worker-followup',
    text: 'Continue from the confirmed evidence' }, AbortSignal.timeout(10000));
  assert.equal(followup.state, 'succeeded', followup.error ?? 'Worker continuation failed');
  assert.equal(f.reads, 1);
});

function assistant(id: string): TranscriptMessage {
  return { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 1,
    stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: 'toolCall', id, name: 'fixture_read', arguments: { part: 1 } }] };
}
test('interrupted tool outcomes remain unknown and paired; raw media is not archived; original rows survive migration', async t => {
  const cleanup: (() => Promise<void>)[] = [];
  const runtime = await temporary(deferredCleanup(cleanup)), path = join(runtime, 'history.sqlite');
  let store = new Store(path);
  const c = conversation({ store } as Application);
  const original = store.append(c.id, 'user', 'human', 'Original message');
  store.appendTranscript(c.id, 'interrupted', assistant('unfinished'));
  store.close(); store = new Store(path);
  t.after(async () => { store.close(); for (const fn of cleanup) await fn(); });
  assert.deepEqual(store.allMessages(c.id), [JSON.parse(JSON.stringify(original))]);
  const history = store.modelMessages(c.id);
  const outcome = history.at(-1)!.meta.native as any;
  assert.equal(outcome.role, 'toolResult'); assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /unconfirmed/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM session_entries WHERE data IS NOT NULL').get()!.n, 1,
    'The model projection does not fabricate a durable execution result');
  store.appendTranscript(c.id, 'image', assistant('image-call'));
  store.appendTranscript(c.id, 'image', { role: 'toolResult', toolCallId: 'image-call', toolName: 'fixture_read', isError: false,
    timestamp: 2, content: [{ type: 'image', data: 'PRIVATE_SCREENSHOT_BYTES', mimeType: 'image/png' }] });
  assert(!JSON.stringify(store.db.prepare('SELECT data FROM session_entries').all()).includes('PRIVATE_SCREENSHOT_BYTES'));
  assert.match(JSON.stringify(store.modelMessages(c.id)), /transient/);
  store.appendTranscript(c.id, 'interleaved', assistant('interleaved-call'));
  store.append(c.id, 'user', 'human', 'Input accepted while a tool is running');
  store.appendTranscript(c.id, 'interleaved', { role: 'toolResult', toolCallId: 'interleaved-call',
    toolName: 'fixture_read', isError: false, timestamp: 3, content: [{ type: 'text', text: 'Confirmed result' }] });
  const lastGroup = historyGroups(store.modelMessages(c.id)).at(-1)!;
  assert.equal(lastGroup.length, 3);
  assert.equal((lastGroup[1].meta.native as any).role, 'toolResult');
  assert.equal(lastGroup[2].text, 'Input accepted while a tool is running');
});

test('legacy migration adds history references without rewriting messages, permissions or compaction records', async t => {
  const cleanup: (() => Promise<void>)[] = [];
  const runtime = await temporary(deferredCleanup(cleanup)), path = join(runtime, 'legacy.sqlite');
  let store = new Store(path);
  const c = conversation({ store } as Application, { permissions: { projectDirectory: 'synthetic-readonly' } });
  store.append(c.id, 'user', 'human', 'Original legacy input');
  store.append(c.id, 'assistant', 'chat', 'Original legacy response');
  store.put('conversation-compactions', c.id, { through: 1, text: 'Existing summary' });
  const snapshot = () => ({
    messages: store.db.prepare('SELECT * FROM messages ORDER BY seq').all(),
    conversation: store.db.prepare('SELECT * FROM conversations').all(),
    compaction: store.document('conversation-compactions', c.id),
  });
  const before = snapshot();
  store.db.exec('DROP TRIGGER session_message_insert; DELETE FROM session_entries;');
  store.set('session.transcript.v1', false);
  store.close(); store = new Store(path);
  t.after(async () => { store.close(); for (const fn of cleanup) await fn(); });
  assert.deepEqual(snapshot(), before);
  assert.equal(store.modelMessages(c.id).length, 2);
  assert.equal(store.modelMessages(c.id)[0].text, 'Original legacy input');
  store.append(c.id, 'user', 'human', 'New input after migration');
  assert.equal(store.modelMessages(c.id).length, 3);
});

test('native history retains tool evidence beyond the diagnostic log truncation limit', async t => {
  const protocol = 'openai-completions';
  const f = await fixture(t, protocol, (body, step) => {
    if (step > 1) assert(JSON.stringify(body.messages).includes('BEGIN_EVIDENCE'));
    return answer(protocol, step, step === 1 ? 'fixture_read' : 'echo_respond', step === 1 ? {}
      : { targetId: 'core.chat', phase: 'final', messages: ['Synthetic reply'] });
  }, {}, () => 'BEGIN_EVIDENCE' + 'x'.repeat(70000) + 'END_EVIDENCE');
  const first = await f.app.router.send({ conversationId: f.chat.id, requestId: 'large-result', text: 'Read the fixture' });
  assert.equal(first.state, 'succeeded', first.error ?? 'Large result failed');
  assert(f.app.router.execution.list(first.id).some(item => item.truncated));
  await f.restart();
  const second = await f.app.router.send({ conversationId: f.chat.id, requestId: 'large-restored', text: 'Use the earlier evidence' });
  assert.equal(second.state, 'succeeded', second.error ?? 'Restored evidence failed');
  assert.equal(f.reads, 1);
});
