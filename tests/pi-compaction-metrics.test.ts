import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PiBackend } from '../packages/backends/pi.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { Registry } from '../packages/kernel/registry.ts';

test('Pi counts in-run compaction usage and replaces obsolete history detail', async (t) => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the synthetic request. */ }
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'synthetic', model: 'synthetic',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Compact synthetic result.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 10 },
    }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  let compacted = false;
  const result = await new PiBackend(new Registry(), async () => undefined).generate({
    profile: profileSchema.parse({ id: 'fixture', name: 'Synthetic', kind: 'pi', model: 'synthetic',
      endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`, reasoning: 'off',
      contextChars: 40000, maxOutputTokens: 512 }),
    requestId: 'compaction-metrics', signal: new AbortController().signal,
    compaction: { triggerTokens: 1800, keepRecentPercent: 40 },
    messages: [{ role: 'system', text: 'Synthetic role.' },
      { id: 'old', role: 'user', text: 'Obsolete history. '.repeat(1800) },
      { role: 'user', text: 'Give the result.' }],
    contextDetails: [{ group: 'prefix', source: 'fixture', tokens: 5 },
      { group: 'history', source: 'obsolete', tokens: 9000 }],
    onItem: (item) => { if (item.id === 'context-compaction' && item.state === 'completed') compacted = true; },
  });
  assert(compacted);
  assert(calls > 1);
  assert.equal(result.metrics?.modelSteps, calls);
  assert.deepEqual(result.metrics?.totalUsage, { input: calls * 100, output: calls * 5, cacheRead: calls * 10, cacheWrite: 0 });
  assert.equal(result.metrics?.cacheHitPercent, 10);
  assert(result.metrics?.details?.some((item) => item.group === 'prefix' && item.source === 'fixture'));
  assert(result.metrics?.details?.some((item) => item.group === 'history' && item.source === 'summary'));
  assert(!result.metrics?.details?.some((item) => item.source === 'obsolete'));
  const actual = Object.values(result.metrics!.context!).reduce((sum, tokens) => sum + tokens, 0);
  const detailed = result.metrics!.details!.reduce((sum, item) => sum + item.tokens, 0);
  assert.equal(detailed, actual);
});
