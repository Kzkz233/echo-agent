import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { PiBackend } from '../packages/backends/pi.ts';
import { profileSchema, type GenerateRequest } from '../packages/contracts/index.ts';
import { Registry } from '../packages/kernel/registry.ts';
import { listenBrowserHttp } from '../packages/kernel/http-listener.ts';

const delta = (text: string, finish = false) => 'data: ' + JSON.stringify({
  id: 'fixture', model: 'synthetic', choices: [{ index: 0,
    delta: { role: 'assistant', content: text }, finish_reason: finish ? 'stop' : null }],
  ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } } : {}),
}) + '\n\n' + (finish ? 'data: [DONE]\n\n' : '');

async function fixture(t: TestContext, summary: (response: ServerResponse, first: boolean) => void) {
  let summaries = 0, replies = 0;
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const part of request) text += part;
    const body = JSON.parse(text);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    if (JSON.stringify(body.messages?.[0]).includes('摘要正文不超过')) summary(response, ++summaries === 1);
    else { replies++; response.end(delta('Finished synthetic task.', true)); }
  });
  const port = await listenBrowserHttp(server);
  t.after(() => new Promise<void>(done => {
    server.closeAllConnections(); server.close(() => done());
  }));
  const profile = profileSchema.parse({ id: 'fixture', name: 'Synthetic', kind: 'pi',
    model: 'synthetic', reasoning: 'off', endpoint: `http://127.0.0.1:${port}/v1`,
    timeoutMs: 1000, contextChars: 40000, maxOutputTokens: 4096,
    modelOptions: { contextWindowTokens: 512000 } });
  const request: GenerateRequest = { profile, requestId: 'compaction-timeout',
    signal: new AbortController().signal,
    compaction: { triggerTokens: 1024, keepRecentPercent: 20 },
    messages: [{ role: 'system', text: 'Synthetic role.' },
      { id: 'old', role: 'user', text: 'Past history. '.repeat(400) },
      { role: 'user', text: 'Finish the task.' }] };
  return { request, backend: new PiBackend(new Registry(), async () => undefined),
    calls: () => ({ summaries, replies }) };
}

test('active compaction can outlast the parent timeout and its own total duration budget', async t => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const timers: NodeJS.Timeout[] = [];
  t.after(() => timers.forEach(clearTimeout));
  const { backend, request, calls } = await fixture(t, (response, first) => {
    if (!first) { response.end(delta('Safe summary.', true)); return; }
    for (let i = 0; i < 12; i++) timers.push(setTimeout(() => {
      // Continuous activity spans eighteen virtual minutes. This must not be
      // interpreted as a total task or compression deadline.
      elapsed += 90000;
      response.write(delta('Summary progress. '));
    }, 100 + i * 140));
    timers.push(setTimeout(() => response.end(delta('Complete.', true)), 1800));
  });
  let compacted = false;
  const result = await backend.generate({ ...request,
    onCompaction: () => { compacted = true; } });
  assert.match(result.text, /Finished synthetic task/);
  assert(compacted);
  assert(calls().summaries > 1, 'The parent must also tolerate multiple summary requests');
  assert.equal(calls().replies, 1);
  assert.equal(request.profile.timeoutMs, 1000, 'Saved model settings must not be mutated');
});

test('stalled compaction still times out without committing a summary or sending the next model request', async t => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  let shift: NodeJS.Timeout | undefined;
  t.after(() => clearTimeout(shift));
  const { backend, request, calls } = await fixture(t, () => {
    shift = setTimeout(() => { elapsed += 600001; }, 100);
  });
  let compacted = false;
  await assert.rejects(backend.generate({ ...request, onCompaction: () => { compacted = true; } }),
    { code: 'pi_failed', message: /上下文压缩失败：Pi 等待执行进展超时/ });
  assert.equal(compacted, false);
  assert.equal(calls().summaries, 1);
  assert.equal(calls().replies, 0);
  assert.equal(request.signal.aborted, false);
});

test('quiet compaction waits beyond ordinary response inactivity without an early abort', async t => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const timers: NodeJS.Timeout[] = [];
  t.after(() => timers.forEach(clearTimeout));
  const { backend, request, calls } = await fixture(t, (response, first) => {
    if (!first) { response.end(delta('Safe summary.', true)); return; }
    timers.push(setTimeout(() => { elapsed += 5 * 60000; }, 100));
    timers.push(setTimeout(() => response.end(delta('Summary after quiet prefill.', true)), 1700));
  });
  const result = await backend.generate(request);
  assert.match(result.text, /Finished synthetic task/);
  assert.equal(calls().replies, 1);
});

test('caller cancellation interrupts an active compaction despite its longer wait allowance', async t => {
  const controller = new AbortController();
  let cancel: NodeJS.Timeout | undefined;
  t.after(() => clearTimeout(cancel));
  const { backend, request, calls } = await fixture(t, () => {
    cancel = setTimeout(() => controller.abort(), 80);
  });
  let compacted = false;
  await assert.rejects(backend.generate({ ...request, signal: controller.signal,
    onCompaction: () => { compacted = true; } }));
  assert.equal(compacted, false);
  assert.equal(calls().summaries, 1);
  assert.equal(calls().replies, 0);
});

test('a whitespace-only stop is corrected inside the Pi compactor before the real turn executes', async t => {
  const { backend, request, calls } = await fixture(t, (response, first) =>
    response.end(delta(first ? '  ' : '完成', true)));
  const items: string[] = [];
  const saved: string[] = [];
  const result = await backend.generate({ ...request, onItem: item => items.push(item.id),
    onCompaction: snapshot => saved.push(snapshot.summary) });
  assert.equal(items.filter(id => id === 'compaction-summary-retry').length, 1);
  assert(saved.length > 0 && saved.every(summary => summary.trim()));
  assert.equal(calls().replies, 1);
  assert.match(result.text, /Finished synthetic task/);
});

test('twice-empty compaction preserves the checkpoint and never starts the real turn', async t => {
  const { backend, request, calls } = await fixture(t, response => response.end(delta('  ', true)));
  let committed = false;
  await assert.rejects(backend.generate({ ...request, onCompaction: () => { committed = true; } }),
    { message: /重新生成摘要后/ });
  assert.equal(committed, false);
  assert.deepEqual(calls(), { summaries: 2, replies: 0 });
});
