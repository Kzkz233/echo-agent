import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeContext } from '../packages/backends/context-summary.ts';
import { EchoError, profileSchema } from '../packages/contracts/index.ts';
import { setup, conversation, FakeBackend } from './helpers.ts';

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
    options: { contextWindowTokens: 512000, maxTokensField: 'max_completion_tokens' },
  });
  assert.equal(saved.maxOutputTokens, 128000);
  assert.equal(saved.reasoning, 'high');
  assert.equal(saved.options.contextWindowTokens, 512000);
  assert.equal(saved.options.maxTokensField, 'max_completion_tokens');
  assert.equal(app.store.run('pending')?.state, 'unknown');
  await assert.rejects(app.router.inference.saveModel({ ...saved, model: 'different' }), {
    code: 'backend_busy',
  });
  assert.equal(app.router.profile('test').maxOutputTokens, 128000);
});

test('compression inherits model reasoning unless a conversation explicitly overrides it', async () => {
  const profile = profileSchema.parse({ id: 'fixture', name: 'Fixture', kind: 'pi', reasoning: 'high',
    reasoningSupport: { source: 'manual', levels: ['off', 'high'] } });
  const captured: any[] = [];
  const input = { profile, prompt: 'Summarize', text: 'History', maxChars: 8000,
    signal: new AbortController().signal, generate: async (request: any) => { captured.push(request); return { text: 'Summary' }; } };
  await summarizeContext(input);
  await summarizeContext({ ...input, reasoning: 'off' });
  assert.equal(captured[0].reasoning, 'inherit');
  assert.equal(captured[0].profile.reasoning, 'high');
  assert.equal(captured[1].reasoning, 'off');
});

test('failed history compression stops the run without silently dropping unsummarized history', async t => {
  const app = await setup(t, []), backend = new FakeBackend();
  app.router.useConversationRuntime(app.api, { kind: 'pi', generate: request => backend.generate(request) });
  const c = conversation(app, { reasoning: 'high', compaction: { triggerTokens: 1024, keepRecentPercent: 10 } });
  await app.router.bind(c.id, 'test', new AbortController().signal);
  for (let i = 0; i < 6; i++) app.store.append(c.id, i % 2 ? 'assistant' : 'user', 'human', 'OLD_HISTORY '.repeat(130), 'old-' + i);
  const before = app.store.allMessages(c.id);
  backend.responder = async request => {
    assert.equal(request.toolPolicy, 'none');
    assert.equal(request.reasoning, 'high');
    throw new EchoError('provider_http_504', 'Synthetic timeout');
  };
  await assert.rejects(app.router.send({ conversationId: c.id, requestId: 'failed-summary', text: 'Continue' }),
    { code: 'context_compaction_failed' });
  assert(!app.store.runs().some(run => run.requestId === 'failed-summary'));
  assert.equal(backend.calls.length, 1);
  assert.equal(app.store.document('conversation-compactions', c.id), undefined);
  assert.deepEqual(app.store.allMessages(c.id).slice(0, before.length), before);
});
