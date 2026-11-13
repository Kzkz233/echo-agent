import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { PiBackend } from '../packages/backends/pi.ts';
import { ApiBackend } from '../packages/backends/api.ts';
import { generationProtocol, observationSilence, profileSchema } from '../packages/contracts/index.ts';
import { responsesInputPayload } from '../packages/backends/protocol.ts';
import { setup } from './helpers.ts';

const event = (value: any) => (value.type ? 'event: ' + value.type + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n';
function answer(protocol: string, name?: string, args: unknown = {}, text = 'Synthetic internal text') {
  if (protocol === 'openai-completions') return event({ choices: [{ index: 0,
    delta: { role: 'assistant', ...(name ? { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] } : { content: text }) },
    finish_reason: name ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n';
  if (protocol === 'openai-responses') {
    const item = name ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name, arguments: JSON.stringify(args) }
      : { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    return event({ type: 'response.output_item.added', output_index: 0,
      item: name ? { ...item, arguments: '' } : { ...item, content: [] } }) +
      event({ type: 'response.output_item.done', output_index: 0, item }) +
      event({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
  }
  return [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant',
      model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: name
      ? { type: 'tool_use', id: 'toolu_fixture', name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: name
      ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ].map(event).join('');
}
async function fixture(t: TestContext, protocol: string, next: (body: any, step: number) => string) {
  const app = await setup(t, []), requests: any[] = [];
  let serverError: unknown;
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const part of req) text += part;
      const body = JSON.parse(text); requests.push(body);
      const output = next(body, requests.length);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(output);
    } catch (error) { serverError = error; res.writeHead(400); res.end('{"error":{"message":"Fixture rejected request"}}'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  t.after(() => { if (serverError) throw serverError; });
  const profile = profileSchema.parse({ id: 'fixture', kind: 'pi', name: 'Synthetic model', model: 'fixture',
    protocol, reasoningStyle: 'none', endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` });
  return { app, requests, profile };
}

for (const protocol of generationProtocol.options) {
  test(protocol + ' requires delivery tools before generation, including optional silence and working tool loops', async t => {
    const deliveries: any[] = [];
    const f = await fixture(t, protocol, (body, step) => {
      assert.deepEqual(body.tool_choice, protocol === 'anthropic-messages' ? undefined : 'required');
      const names = body.tools.map((tool: any) => tool.function?.name ?? tool.name);
      assert(names.includes('echo_respond') && names.includes('echo_silence') && names.includes('fixture_read'));
      if (step === 1) return answer(protocol, 'fixture_read');
      if (step === 2) {
        const transcript = JSON.stringify(body.input ?? body.messages);
        assert(transcript.includes('Synthetic read result'));
        assert(!transcript.includes('"annotations":[]'), 'Empty response-only metadata must not reach the gateway');
      }
      return answer(protocol, 'echo_respond', { targetId: step === 2 ? 'core.chat' : 'avatar.bubble',
        phase: 'final', messages: [step === 2 ? 'Synthetic detailed chat' : 'Synthetic short bubble'] });
    });
    f.app.registry.register({ name: 'fixture.read', owner: 'core', description: 'Synthetic read',
      permission: 'fixture.read', mcp: true, input: z.object({}), output: z.string(), run: () => 'Synthetic read result' });
    const pi = new PiBackend(f.app.registry, async () => 'fixture-key', () => new Set(['fixture.read']));
    await pi.generate({ profile: f.profile, requestId: 'multi-target', signal: AbortSignal.timeout(6000),
      messages: [{ role: 'system', text: 'Synthetic persona' },
        { role: 'assistant', text: 'Earlier assistant text with a program-added channel header' },
        { role: 'user', text: 'Read then deliver to both targets' }],
      replyTargets: ['core.chat', 'avatar.bubble'], allowSilence: true,
      respond: input => { deliveries.push(input); return { accepted: true }; } });
    assert.equal(f.requests.length, 3, 'Only normal tool steps; no corrective model calls');
    assert.deepEqual(deliveries.map(input => input.targetId), ['core.chat', 'avatar.bubble']);
  });

  test(protocol + ' can explicitly stay silent without delivery or supplemental generation', async t => {
    const f = await fixture(t, protocol, () => answer(protocol, 'echo_silence'));
    const pi = new PiBackend(f.app.registry, async () => 'fixture-key');
    let delivered = 0;
    const result = await pi.generate({ profile: f.profile, requestId: 'silent', signal: AbortSignal.timeout(6000),
      messages: [{ role: 'user', text: 'Remain quiet if there is nothing to deliver' }],
      replyTargets: ['core.chat', 'avatar.bubble'], allowSilence: true,
      respond: () => { delivered++; return { accepted: true }; } });
    assert.equal(result.text, observationSilence);
    assert.equal(delivered, 0);
    assert.equal(f.requests.length, 1);
  });
}

test('Responses compatibility cleanup covers pure API history and preserves nonempty citations and tool payloads', async t => {
  const f = await fixture(t, 'openai-responses', body => {
    assert(body.input.some((item: any) => item.role === 'assistant'));
    assert(!JSON.stringify(body.input).includes('"annotations":[]'));
    assert.equal(body.tool_choice, undefined, 'Pure model tasks have no delivery obligation');
    return answer('openai-responses');
  });
  const api = new ApiBackend(async () => 'fixture-key');
  const result = await api.generate({ profile: f.profile, requestId: 'api-history', signal: AbortSignal.timeout(6000),
    messages: [{ role: 'assistant', text: 'Prior answer' }, { role: 'user', text: 'Continue' }] });
  assert.equal(result.text, 'Synthetic internal text');
  const payload = { input: [
    { type: 'message', content: [{ type: 'output_text', text: 'cited', annotations: [{ type: 'url_citation', url: 'https://example.org' }] }] },
    { type: 'function_call', arguments: '{"annotations":[]}' },
    { type: 'function_call_output', output: '{"annotations":[]}' },
  ] };
  assert.deepEqual(responsesInputPayload(payload), payload);
});

test('A task without delivery targets keeps normal text output; required replies have no silence tool', async t => {
  const f = await fixture(t, 'openai-completions', (body, step) => {
    const tools = (body.tools ?? []).map((tool: any) => tool.function.name);
    assert(!tools.includes('echo_silence'));
    if (step === 1) assert.equal(body.tool_choice, undefined);
    else assert.equal(body.tool_choice, 'required');
    return answer('openai-completions');
  });
  const pi = new PiBackend(f.app.registry, async () => 'fixture-key');
  const request = { profile: f.profile, requestId: 'no-delivery', signal: AbortSignal.timeout(6000),
    messages: [{ role: 'user' as const, text: 'Synthetic worker task' }] };
  assert.equal((await pi.generate(request)).text, 'Synthetic internal text');
  let delivered = 0;
  await pi.generate({ ...request, replyTargets: ['core.chat'], respond: () => { delivered++; return { accepted: true }; } });
  assert.equal(delivered, 0, 'Even a noncompliant provider must never have ordinary text auto-forwarded');
  assert.equal(f.requests.length, 2, 'No retry or compensation request');
});

test('Silence cannot discard a reply that has already started', async t => {
  const f = await fixture(t, 'openai-completions', (body, step) => {
    if (step === 2) return answer('openai-completions', 'echo_silence');
    if (step === 3) assert(JSON.stringify(body.messages).includes('已经开始回复'));
    return answer('openai-completions', 'echo_respond', { targetId: 'core.chat',
      phase: step === 1 ? 'progress' : 'final', messages: [step === 1 ? 'Working' : 'Complete'] });
  });
  const pi = new PiBackend(f.app.registry, async () => 'fixture-key'), deliveries: string[] = [];
  const result = await pi.generate({ profile: f.profile, requestId: 'started', signal: AbortSignal.timeout(6000),
    messages: [{ role: 'user', text: 'Synthetic task' }], replyTargets: ['core.chat'], allowSilence: true,
    respond: input => { deliveries.push(input.phase); return { accepted: true }; } });
  assert.notEqual(result.text, observationSilence);
  assert.deepEqual(deliveries, ['progress', 'final']);
  assert.equal(f.requests.length, 3);
});
