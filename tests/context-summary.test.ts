import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeContext } from '../packages/backends/context-summary.ts';
import { EchoError, profileSchema } from '../packages/contracts/index.ts';
import { setup, conversation } from './helpers.ts';

test('summary uses configured output allowance and rejects incomplete results without replay', async () => {
  const profile = profileSchema.parse({
    id: 'fixture',
    name: 'Fixture',
    kind: 'pi',
    maxOutputTokens: 128000,
  });
  let calls = 0;
  const summary = {
    profile,
    prompt: 'Summarize history.',
    text: 'Synthetic history',
    maxChars: 8000,
    signal: new AbortController().signal,
  };
  const result = await summarizeContext({
    ...summary,
    generate: async (request) => {
      calls++;
      assert.equal(request.profile.maxOutputTokens, 128000);
      assert.equal(request.toolPolicy, 'none');
      assert.equal(request.reasoning, 'inherit');
      assert.match(request.messages[0].text, /8000/);
      return { text: 's'.repeat(3000) };
    },
  });
  assert.equal(result.text.length, 3000);
  await assert.rejects(
    summarizeContext({
      ...summary,
      generate: async () => {
        calls++;
        throw new EchoError('pi_output_limit', 'Synthetic output limit');
      },
    }),
    { code: 'context_compaction_failed', message: '上下文压缩失败：Synthetic output limit' },
  );
  const longer = await summarizeContext({ ...summary, generate: async () => {
    calls++; return { text: 's'.repeat(8001) };
  } });
  assert.equal(longer.text.length, 8001);
  await assert.rejects(summarizeContext({ ...summary, generate: async () => {
    calls++; return { text: ' ' };
  } }), { code: 'context_compaction_failed' });
  assert.equal(calls, 4);
});

test('generation settings can be saved for the next run while execution identity stays protected', async (t) => {
  const app = await setup(t, []);
  const c = conversation(app);
  app.store.createRun({
    id: 'pending',
    requestId: 'pending',
    conversationId: c.id,
    profileId: 'test',
    epoch: 1,
    state: 'unknown',
    input: 'Synthetic',
    source: 'human',
    createdAt: new Date().toISOString(),
    meta: {},
  });
  const previous = app.router.inference.models().find((p) => p.id === 'test')!;
  const saved = await app.router.inference.saveModel({
    ...previous,
    maxOutputTokens: 128000,
    reasoningStyle: 'effort',
    reasoningLevels: ['low', 'high'],
    reasoning: 'high',
  });
  assert.equal(saved.maxOutputTokens, 128000);
  assert.equal(saved.reasoning, 'high');
  assert.equal(app.store.run('pending')?.state, 'unknown');
  await assert.rejects(app.router.inference.saveModel({ ...saved, model: 'different' }), {
    code: 'backend_busy',
  });
  assert.equal(app.router.profile('test').maxOutputTokens, 128000);
});
