import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { PiBackend } from '../packages/backends/pi.ts';
import { ApiBackend } from '../packages/backends/api.ts';
import { generationProtocol, observationSilence, profileSchema } from '../packages/contracts/index.ts';
import { responsesInputPayload } from '../packages/backends/protocol.ts';
import { setup } from './helpers.ts';
import { listenBrowserHttp } from '../packages/kernel/http-listener.ts';

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
function toolBatch(protocol: string, calls: { name: string; args: unknown }[]) {
  if (protocol === 'openai-completions') return event({ choices: [{ index: 0,
    delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index,
      id: 'call_batch_' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) },
    finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  if (protocol === 'openai-responses') {
    const items = calls.map((call, index) => ({ type: 'function_call', id: 'fc_batch_' + index,
      call_id: 'call_batch_' + index, name: call.name, arguments: JSON.stringify(call.args) }));
    return items.map((item, output_index) =>
      event({ type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } }) +
      event({ type: 'response.output_item.done', output_index, item })).join('') +
      event({ type: 'response.completed', response: { id: 'resp_batch', status: 'completed', output: items,
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
  }
  return [
    { type: 'message_start', message: { id: 'msg_batch', type: 'message', role: 'assistant',
      model: 'fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
    ...calls.flatMap((call, index) => [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call_batch_' + index,
        name: call.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ].map(event).join('');
}
const finalReply = (targetId: string) => ({ name: 'echo_respond',
  args: { targetId, phase: 'final', messages: ['Synthetic final for ' + targetId] } });
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
  await listenBrowserHttp(server);
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  t.after(() => { if (serverError) throw serverError; });
  const profile = profileSchema.parse({ id: 'fixture', kind: 'pi', name: 'Synthetic model', model: 'fixture',
    protocol, reasoningStyle: 'none', endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` });
  return { app, requests, profile };
}

for (const protocol of generationProtocol.options) {
  test(protocol + ' ends once all same-turn channel replies and mixed plugin work are durably recorded', async t => {
    let readCompleted = false;
    const transcript: any[] = [], submissions: string[] = [];
    const f = await fixture(t, protocol, (_body, step) => {
      assert.equal(step, 1, 'Completed channel replies must not start another model request');
      return toolBatch(protocol, [finalReply('core.chat'), finalReply('avatar.bubble'),
        { name: 'fixture_read', args: {} }]);
    });
    f.app.registry.register({ name: 'fixture.read', owner: 'core', description: 'Synthetic plugin read',
      permission: 'fixture.read', mcp: true, input: z.object({}), output: z.string(),
      run: async () => { await new Promise(resolve => setTimeout(resolve, 10)); readCompleted = true; return 'Read completed'; } });
    const pi = new PiBackend(f.app.registry, async () => 'fixture-key', () => new Set(['fixture.read']));
    await pi.generate({ profile: f.profile, requestId: 'batched-finals', signal: AbortSignal.timeout(6000),
      messages: [{ role: 'user', text: 'Complete both replies and plugin work' }],
      replyTargets: ['core.chat', 'avatar.bubble'], respond: input => {
        submissions.push(input.targetId); return { accepted: true };
      }, onTranscript: message => { transcript.push(message); return 'fixture-' + transcript.length; } });
    assert.equal(f.requests.length, 1);
    assert(readCompleted, 'Completion waits for the entire tool batch');
    assert.deepEqual(submissions, ['core.chat', 'avatar.bubble']);
    const calls = transcript.filter(message => message.role === 'assistant')
      .flatMap(message => message.content.filter((part: any) => part.type === 'toolCall').map((part: any) => part.id));
    const results = transcript.filter(message => message.role === 'toolResult');
    assert.equal(results.length, 3);
    assert(results.every(result => !result.isError));
    assert.deepEqual(results.map(result => result.toolCallId).sort(), calls.sort());
  });

  test(protocol + ' keeps running for a remaining target after batched progress and final replies', async t => {
    const submissions: any[] = [];
    const f = await fixture(t, protocol, (body, step) => {
      assert(step <= 2);
      if (step === 1) return toolBatch(protocol, [finalReply('core.chat'), { name: 'echo_respond',
        args: { targetId: 'avatar.bubble', phase: 'progress', messages: ['Still working'] } }]);
      assert(JSON.stringify(body.input ?? body.messages).includes('Still working'));
      return answer(protocol, 'echo_respond', finalReply('avatar.bubble').args);
    });
    const pi = new PiBackend(f.app.registry, async () => 'fixture-key');
    await pi.generate({ profile: f.profile, requestId: 'remaining-target', signal: AbortSignal.timeout(6000),
      messages: [{ role: 'user', text: 'Finish each selected target' }], replyTargets: ['core.chat', 'avatar.bubble'],
      respond: input => { submissions.push([input.targetId, input.phase]); return { accepted: true }; } });
    assert.equal(f.requests.length, 2);
    assert.deepEqual(submissions, [['core.chat', 'final'], ['avatar.bubble', 'progress'], ['avatar.bubble', 'final']]);
  });

  test(protocol + ' does not hide a mixed plugin failure when all channel replies are complete', async t => {
    let attempts = 0;
    const transcript: any[] = [], submissions: string[] = [];
    const f = await fixture(t, protocol, (body, step) => {
      assert(step <= 2);
      if (step === 1) return toolBatch(protocol, [finalReply('core.chat'), finalReply('avatar.bubble'),
        { name: 'fixture_read', args: {} }]);
      assert(JSON.stringify(body.input ?? body.messages).includes('Synthetic read failed'));
      return answer(protocol, 'fixture_read');
    });
    f.app.registry.register({ name: 'fixture.read', owner: 'core', description: 'Synthetic plugin read',
      permission: 'fixture.read', mcp: true, input: z.object({}), output: z.string(),
      run: () => { if (++attempts === 1) throw new Error('Synthetic read failed'); return 'Read recovered'; } });
    const pi = new PiBackend(f.app.registry, async () => 'fixture-key', () => new Set(['fixture.read']));
    await pi.generate({ profile: f.profile, requestId: 'failed-mixed-work', signal: AbortSignal.timeout(6000),
      messages: [{ role: 'user', text: 'Complete work and both replies' }], replyTargets: ['core.chat', 'avatar.bubble'],
      respond: input => { submissions.push(input.targetId); return { accepted: true }; },
      onTranscript: message => { transcript.push(message); return 'fixture-' + transcript.length; } });
    assert.equal(f.requests.length, 2);
    assert.equal(attempts, 2);
    assert.deepEqual(submissions, ['core.chat', 'avatar.bubble']);
    assert.equal(transcript.filter(message => message.role === 'toolResult' && message.isError).length, 1);
  });

  test(protocol + ' replays verified deliveries as past tool calls without sending them again', async t => {
    const f = await fixture(t, protocol, body => {
      const input = body.input ?? body.messages;
      const history = JSON.stringify(input);
      assert(history.includes('historical'));
      assert(history.includes('2026-01-02T03:04:05Z'));
      assert(history.includes('Unverified ordinary reply'));
      const calls = protocol === 'openai-responses' ? input.filter((i: any) => i.type === 'function_call')
        : protocol === 'openai-completions' ? input.flatMap((i: any) => i.tool_calls ?? [])
        : input.flatMap((i: any) => Array.isArray(i.content) ? i.content.filter((p: any) => p.type === 'tool_use') : []);
      assert.equal(calls.length, 1);
      const args = protocol === 'anthropic-messages' ? calls[0].input
        : JSON.parse(calls[0].arguments ?? calls[0].function.arguments);
      assert.deepEqual(args, { targetId: 'core.chat', phase: 'final', messages: ['Earlier rendered reply'] });
      return answer(protocol, 'echo_respond', { targetId: 'core.chat', phase: 'final', messages: ['Current reply'] });
    });
    const pi = new PiBackend(f.app.registry, async () => 'fixture-key');
    let deliveries = 0;
    await pi.generate({ profile: f.profile, requestId: 'history', signal: AbortSignal.timeout(6000),
      replyTargets: ['core.chat'], respond: input => { deliveries++; assert.equal(input.messages[0], 'Current reply'); return { accepted: true }; },
      messages: [{ role: 'system', text: 'Stable persona' },
        { id: 'historical-delivery', role: 'assistant', text: 'Earlier rendered reply',
          messageContext: { time: '2026-01-02T03:04:05Z', timezone: 'Asia/Shanghai', sender: 'Synthetic role', channel: 'Chat' },
          reply: { targetId: 'core.chat', phase: 'final', messages: ['Earlier rendered reply'] } },
        { id: 'ordinary', role: 'assistant', text: 'Unverified ordinary reply' },
        { role: 'user', text: 'Current request' }] });
    assert.equal(deliveries, 1);
    assert.equal(f.requests.length, 1);
  });

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

test('Pi replays a native trailing newline through Responses and delivers both new finals', async t => {
  const f = await fixture(t, 'openai-responses', body => {
    const index = body.input.findIndex((item:any) => item.type === 'function_call' && item.call_id === 'call_old');
    assert(index >= 0);
    assert.equal(body.input[index+1]?.type,'function_call_output');
    assert.equal(body.input[index+1]?.call_id,'call_old');
    return toolBatch('openai-responses',[finalReply('core.chat'),finalReply('fixture.mobile')]);
  });
  const stored = {role:'assistant' as const, api:'openai-responses' as const, provider:'echo-'+f.profile.id,
    model:f.profile.model, timestamp:1, stopReason:'toolUse' as const,
    usage:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
    content:[{type:'toolCall' as const,id:'call_old|fc_old',name:'echo_respond',arguments:finalReply('core.chat').args},
      {type:'text' as const, text:'\n'}]};
  const pi = new PiBackend(f.app.registry,async ()=>'fixture-key');
  const delivered:string[]=[];
  await pi.generate({profile:f.profile, requestId:'after-restart', signal:AbortSignal.timeout(6000),
    messages:[{role:'assistant',text:'',native:stored},{role:'tool',text:'',native:{role:'toolResult',
      toolCallId:'call_old|fc_old',toolName:'echo_respond',content:[{type:'text',text:'accepted'}],isError:false,timestamp:2}},
      {role:'user',text:'Report to both destinations'}],
    replyTargets:['core.chat','fixture.mobile'],respond:r=>{delivered.push(r.targetId);return {accepted:true};}});
  assert.deepEqual(delivered,['core.chat','fixture.mobile']);
  assert.equal(f.requests.length,1);
  assert.equal(stored.content.length,2);
});

test('Responses replay keeps parallel outputs adjacent across empty assistant text without changing stored history', () => {
  const call = (id:string) => ({type:'function_call',call_id:id,name:'fixture',arguments:'{}'});
  const result = (id:string) => ({type:'function_call_output',call_id:id,output:'  '});
  const message = (text:string, annotations:unknown[] = []) => ({type:'message',role:'assistant',content:[{type:'output_text',text,annotations}]});
  const stored = {input:[call('a'),call('b'),message('\n'),result('b'),message(' '),result('a')]};
  assert.deepEqual(responsesInputPayload(stored),{input:[call('a'),call('b'),result('b'),result('a')]});
  assert.equal(stored.input.length,6);
  for (const m of [message('actual text'), message(' ',[{type:'url_citation'}])]) {
    const value = responsesInputPayload({input:[call('a'),m,result('a')]}) as typeof stored;
    assert.equal(value.input.length,3);
  }
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
    messages: [{ id: 'old-delivery', role: 'assistant' as const, text: 'Prior channel reply',
      reply: { targetId: 'core.chat', phase: 'final' as const, messages: ['Prior channel reply'] } },
      { role: 'user' as const, text: 'Synthetic worker task' }] };
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
