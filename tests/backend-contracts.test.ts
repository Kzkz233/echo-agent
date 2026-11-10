import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { parse } from 'yaml';
import { EchoError, profileSchema } from '../packages/contracts/index.ts';
import { CodexBackend } from '../packages/backends/codex.ts';
import {
  DshBackend,
  dshPluginCommandArgs,
  dshProviderId,
  dshProfileName,
  dshReasoningEffort,
  resolveDshBaseUrl,
} from '../packages/backends/dsh.ts';
import { PiBackend } from '../packages/backends/pi.ts';
import { setup } from './helpers.ts';

test('Codex uses initialize, native history import, run completion and deduplicated context', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'fake-codex.mjs'),
    log = join(app.runtime, 'wire.jsonl');
  await writeFile(
    script,
    `import readline from 'node:readline';import fs from 'node:fs';const log=${JSON.stringify(log)};let n=0;for await(const l of readline.createInterface({input:process.stdin})){const m=JSON.parse(l);fs.appendFileSync(log,JSON.stringify(m)+'\\n');if(m.id===undefined)continue;let result={};if(m.method==='model/list')result={data:[{id:'synthetic',model:'synthetic',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'none'},{reasoningEffort:'medium'}]}]};if(m.method==='initialize')result={userAgent:'synthetic'};if(m.method==='thread/start')result={thread:{id:'native'}};if(m.method==='turn/start')result={turn:{id:'turn-'+(++n)}};if(m.method==='thread/read')result={thread:{turns:[{id:'turn-1',status:'completed',items:[{type:'agentMessage',text:'native answer'}]}]}};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){console.log(JSON.stringify({method:'item/completed',params:{threadId:'native',turnId:'turn-'+n,item:{type:'agentMessage',text:'native answer'}}}));console.log(JSON.stringify({method:'turn/completed',params:{threadId:'native',turn:{id:'turn-'+n,status:'completed'}}}));}}`,
  );
  const backend = new CodexBackend(app.runtime, app.store);
  app.router.backends.set('codex', backend);
  const profile = profileSchema.parse({
    id: 'c',
    name: 'test',
    kind: 'codex',
    command: process.execPath,
    args: [script],
    modelOptions: { contextWindowTokens: 128000 },
  });
  assert.equal((await backend.availableModels(profile))[0].id, 'synthetic');
  const sessionId = await backend.createSession(
    profile,
    [{ id: 'old-a', role: 'assistant', text: '真实旧助手记录' }],
    new AbortController().signal,
  );
  const account = await backend.authenticate(profile, 'status');
  assert.deepEqual(account, {});
  const messages = [
    { role: 'system' as const, text: '人格说明' },
    { id: 'memory-one', role: 'system' as const, text: '检索到的记忆' },
    { id: 'u1', role: 'user' as const, text: 'hello' },
  ];
  const first = await backend.generate({
    profile,
    messages: [
      ...messages.slice(0, 2),
      { role: 'system', context: 'turn', text: 'ONE_USE_ONLY' },
      messages[2],
    ],
    sessionId,
    requestId: 'one',
    signal: new AbortController().signal,
  });
  assert.equal(first.text, 'native answer');
  await backend.generate({
    profile,
    messages: [...messages.slice(0, 2), { id: 'event-one', role: 'system', text: '应用观察信号' }],
    sessionId,
    requestId: 'two',
    reasoning: 'off',
    signal: new AbortController().signal,
  });
  await backend.generate({
    profile,
    sessionId,
    requestId: 'three',
    signal: new AbortController().signal,
    messages: [
      ...messages,
      { id: 'event-one', role: 'system', text: '应用观察信号' },
      { id: 'u2', role: 'user', text: 'next question' },
    ],
  });
  const fs = await import('node:fs/promises');
  const wire = (await fs.readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(wire.find((m) => m.method === 'account/read').params, { refreshToken: false });
  assert.equal(
    wire.find((m) => m.method === 'thread/start').params.config.model_context_window,
    128000,
  );
  const injected = wire
    .filter((m) => m.method === 'thread/inject_items')
    .flatMap((m) => m.params.items);
  assert.equal(
    injected.filter((i) => i.content.some((c: any) => c.text === '检索到的记忆')).length,
    1,
  );
  assert.equal(injected[0].role, 'assistant');
  assert.equal(
    injected.filter((i) => i.content.some((c: any) => c.text.includes('人格说明'))).length,
    1,
  );
  assert(!JSON.stringify(injected).includes('ONE_USE_ONLY'));
  assert(!JSON.stringify(injected).includes('应用观察信号'));
  const [firstStart, start, nextStart] = wire.filter((m) => m.method === 'turn/start');
  assert.match(firstStart.params.input[0].text, /ONE_USE_ONLY[\s\S]*hello/);
  assert.equal(nextStart.params.input[0].text, 'next question');
  assert.deepEqual(start.params.input, []);
  assert.equal(start.params.toolOutput.output, '应用观察信号');
  assert.equal(start.params.effort, 'none');
  assert.equal((await backend.inspect(profile, sessionId, 'turn-1')).state, 'succeeded');
});

test('idle Codex releases its host but never terminates an active turn; native sessions can resume in a new host', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'idle-codex.mjs');
  await writeFile(
    script,
    `import readline from 'node:readline';for await (const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='account/read'?{account:{type:'synthetic'},pid:process.pid}:m.method==='thread/start'?{thread:{id:'session'}}:m.method==='turn/start'?{turn:{id:'delayed'}}:{};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start')setTimeout(()=>{console.log(JSON.stringify({method:'item/completed',params:{threadId:'session',item:{type:'agentMessage',text:'finished'}}}));console.log(JSON.stringify({method:'turn/completed',params:{threadId:'session',turn:{id:'delayed',status:'completed'}}}));},250);}`,
  );
  const backend = new CodexBackend(app.runtime, app.store, undefined, 60);
  app.router.backends.set('codex', backend);
  const profile = profileSchema.parse({
    id: 'idle',
    name: 'Idle fixture',
    kind: 'codex',
    command: process.execPath,
    args: [script],
  });
  const sessionId = await backend.createSession(profile, [], new AbortController().signal);
  const initial = await backend.authenticate(profile, 'status');
  await new Promise((r) => setTimeout(r, 180));
  const first = await backend.authenticate(profile, 'status');
  assert.notEqual(
    initial.pid,
    first.pid,
    'A not-yet-started Echo binding must not pin a native host',
  );
  const result = await backend.generate({
    profile,
    sessionId,
    requestId: 'slow',
    messages: [{ role: 'user', text: 'fixture' }],
    signal: new AbortController().signal,
  });
  assert.equal(result.text, 'finished');
  assert.equal((await backend.authenticate(profile, 'status')).pid, first.pid);
  await new Promise((r) => setTimeout(r, 180));
  assert.notEqual((await backend.authenticate(profile, 'status')).pid, first.pid);
  assert.throws(() => process.kill(first.pid, 0));
});
test('DSH uses official assistant/message events and per-run reasoning with isolated session home', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'fake-dsh.mjs'),
    log = join(app.runtime, 'dsh-wire.jsonl');
  await writeFile(
    script,
    `import readline from 'node:readline';import fs from 'node:fs';const log=${JSON.stringify(log)};for await(const l of readline.createInterface({input:process.stdin})){const m=JSON.parse(l);fs.appendFileSync(log,JSON.stringify({...m,home:process.env.DSH_HOME})+'\\n');let result={};if(m.method==='initialize')result={serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.2.2'}};if(m.method==='session/query'){result={kind:'prompt',messageId:'native-input'};console.log(JSON.stringify({method:'session.event',params:{sessionId:m.params.sessionId,event:{type:'assistant/message',data:{message:{content:[{type:'text',text:'DSH native answer'}]}}}}}));}console.log(JSON.stringify({id:m.id,result}));if(m.method==='shutdown')break;}`,
  );
  const backend = new DshBackend(app.runtime, app.store, async () => undefined);
  t.after(() => backend.close());
  const profile = profileSchema.parse({
    id: 'd',
    name: 'test',
    kind: 'dsh',
    command: process.execPath,
    args: [script],
    model: 'synthetic',
    provider: 'deepseek-official',
  });
  const sessionId = await backend.createSession(profile, []);
  const result = await backend.generate({
    profile,
    sessionId,
    requestId: 'dsh-one',
    messages: [
      { role: 'system', text: 'DSH_STABLE' },
      { role: 'system', id: 'reference', context: 'turn', text: 'DSH_TURN_ONE' },
      { role: 'user', text: 'hello' },
    ],
    reasoning: 'off',
    signal: new AbortController().signal,
  });
  assert.equal(result.text, 'DSH native answer');
  await backend.generate({
    profile,
    sessionId,
    requestId: 'dsh-two',
    signal: new AbortController().signal,
    messages: [
      { role: 'system', text: 'DSH_STABLE' },
      { role: 'system', id: 'reference', text: 'DSH_TURN_ONE' },
      { role: 'system', context: 'turn', text: 'DSH_TURN_TWO' },
      { role: 'user', text: 'next' },
    ],
  });
  const fs = await import('node:fs/promises');
  const wire = (await fs.readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(wire[0].params.reasoningEffort, 'off');
  assert(wire[0].home.startsWith(app.runtime));
  assert(wire.some((m) => m.method === 'session/wait'));
  assert(wire.some((m) => m.method === 'shutdown'));
  const [firstQuery, secondQuery] = wire.filter((m) => m.method === 'session/query');
  assert.match(firstQuery.params.contentBlocks[0].text, /DSH_STABLE[\s\S]*DSH_TURN_ONE/);
  assert.doesNotMatch(secondQuery.params.contentBlocks[0].text, /DSH_STABLE|DSH_TURN_ONE/);
  assert.match(secondQuery.params.contentBlocks[0].text, /DSH_TURN_TWO/);
});
test('DSH custom providers patch llm-pi-ai as YAML and retain dynamic MCP authorization', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'custom-provider-dsh.mjs'),
    log = join(app.runtime, 'custom-provider-wire.jsonl');
  await writeFile(
    script,
    `import readline from 'node:readline';import fs from 'node:fs';const log=${JSON.stringify(log)};for await(const l of readline.createInterface({input:process.stdin})){const m=JSON.parse(l);fs.appendFileSync(log,JSON.stringify({...m,patchPath:process.argv[process.argv.indexOf('--patch')+1],apiKeyPresent:Boolean(process.env.ECHO_DSH_API_KEY)})+'\\n');let result={};if(m.method==='initialize')result={serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.2.2'}};if(m.method==='session/query'){console.log(JSON.stringify({method:'session.event',params:{sessionId:m.params.sessionId,event:{type:'assistant/message',data:{message:{content:[{type:'text',text:'custom provider fixture'}]}}}}}));}console.log(JSON.stringify({id:m.id,result}));if(m.method==='shutdown')break;}`,
  );
  const backend = new DshBackend(app.runtime, app.store, async () => 'fixture-secret');
  backend.setEchoMcp(() => ({ url: 'http://127.0.0.1:8765/mcp', token: 'fixture-mcp-token' }));
  t.after(() => backend.close());
  const profile = profileSchema.parse({
    id: 'custom-dsh',
    connectionId: 'custom-connection',
    name: 'Custom relay',
    kind: 'dsh',
    command: process.execPath,
    args: [script, '--profile', 'sdk'],
    provider: 'custom',
    api: 'openai-responses',
    endpoint: 'https://gateway.example/v1',
    model: 'deepseek-v4.1-flash',
    apiKeyRef: 'custom-key',
    reasoning: 'high',
  });
  const sessionId = await backend.createSession(profile, []);
  const result = await backend.generate({
    profile,
    sessionId,
    requestId: 'custom-provider-run',
    principal: { conversationId: 'custom-provider-chat', personaId: 'companion' },
    messages: [{ role: 'user', text: 'fixture' }],
    signal: new AbortController().signal,
  });
  assert.equal(result.text, 'custom provider fixture');
  const wire = await import('node:fs/promises');
  const rows = (await wire.readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows[0].params.provider, 'custom');
  assert.equal(rows[0].params.reasoningEffort, 'high');
  assert.equal(rows[0].apiKeyPresent, true);
  const patchPath = rows[0].patchPath as string;
  assert.match(patchPath, /echo\.patch\.yml$/);
  const patchText = await wire.readFile(patchPath, 'utf8');
  assert(
    patchText.includes('Authorization: !!js "\'Bearer \' + process.env.ECHO_HARNESS_MCP_TOKEN"'),
  );
  assert.doesNotMatch(patchText, /fixture-secret|fixture-mcp-token/);
  const parsed = parse(
    patchText.replace(/!!js "([^"]*)"/g, (_tag, expression) => JSON.stringify(expression)),
  );
  const providerPatch = parsed
    .flatMap((entry: any) => entry.insert ?? [])
    .find((entry: any) => entry.id === 'echo-llm-pi-ai');
  assert(parsed.some((entry: any) => entry.id === 'llm-pi-ai' && entry.disabled === true));
  assert.equal(providerPatch.name, '@deepseek-ai/dsh-llm-pi-ai');
  assert.equal(providerPatch.config.providers.custom.api, 'openai-responses');
  assert.equal(providerPatch.config.providers.custom.baseURL, 'https://gateway.example/v1');
  assert.equal(providerPatch.config.providers.custom.models[0].id, 'deepseek-v4.1-flash');
  assert.equal(
    parsed.some((entry: any) => entry.id === 'ui-chat'),
    false,
  );
  assert.equal(dshReasoningEffort('high'), 'high');
  assert.equal(dshReasoningEffort('xhigh'), 'high');
});
test('DSH profile helpers retain the selected profile when using the official plugin manager', () => {
  for (const provider of ['custom', 'custom-relay', 'openai', 'deepseek-official'])
    assert.equal(
      dshProviderId(
        profileSchema.parse({ id: 'route-test', name: 'Fixture', kind: 'dsh', provider }),
      ),
      provider,
    );
  const entry =
      'C:\\Program Files\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    profileName = dshProfileName(['--profile', 'sdk-minimal']);
  assert.equal(profileName, 'sdk-minimal');
  assert.deepEqual(
    dshPluginCommandArgs([entry, '--profile', 'sdk-minimal'], profileName, [
      'add',
      '@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.1',
      '--save-exact',
    ]),
    [
      entry,
      'plugin',
      '--profile',
      'sdk-minimal',
      'add',
      '@deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.1',
      '--save-exact',
    ],
  );
});
test('DSH custom model discovery and connection checks use authenticated GET only', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'dsh-connection-check.mjs'),
    runtimeLog = join(app.runtime, 'dsh-connection-check.jsonl');
  await writeFile(
    script,
    `import readline from 'node:readline';import fs from 'node:fs';const log=${JSON.stringify(runtimeLog)};for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({method:m.method,params:m.params,home:process.env.DSH_HOME,apiKeyPresent:Boolean(process.env.ECHO_DSH_API_KEY),patchPath:process.argv[process.argv.indexOf('--patch')+1]})+'\\n');const result=m.method==='initialize'?{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.2.2'}}:{};console.log(JSON.stringify({id:m.id,result}));if(m.method==='shutdown')break;}`,
  );
  const requests: any[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'relay-model', name: 'Relay Model' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const backend = new DshBackend(app.runtime, app.store, async () => 'catalog-key');
  t.after(() => backend.close());
  const profile = profileSchema.parse({
    id: 'dsh-catalog',
    name: 'Local API fixture',
    kind: 'dsh',
    provider: 'custom',
    api: 'openai-responses',
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    apiKeyRef: 'catalog-key',
    command: process.execPath,
    args: [script, '--profile', 'sdk'],
  });
  assert.deepEqual(await backend.listModels(profile), [
    { id: 'relay-model', label: 'Relay Model' },
  ]);
  const check = await backend.checkConnection(profile);
  assert.equal(check.ok, true);
  assert.equal(check.verified, 'upstream+runtime');
  assert.equal(check.modelCount, 1);
  assert.equal(check.note, '上游模型目录和 DSH SDK 初始化均正常；未发送推理请求。');
  const runtimeCalls = (await import('node:fs/promises'))
    .readFile(runtimeLog, 'utf8')
    .then((text) =>
      text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
  const calls = await runtimeCalls;
  assert.deepEqual(
    calls.map((call: any) => call.method),
    ['initialize', 'shutdown'],
  );
  assert.equal(calls[0].params.provider, 'custom');
  assert.equal(calls[0].params.model, 'relay-model');
  assert.equal(calls[0].apiKeyPresent, true);
  assert(calls[0].home.startsWith(join(app.runtime, 'harnesses', 'dsh', 'checks')));
  assert.match(calls[0].patchPath, /echo\.patch\.yml$/);
  assert.deepEqual(requests, [
    { method: 'GET', url: '/v1/models', authorization: 'Bearer catalog-key' },
    { method: 'GET', url: '/v1/models', authorization: 'Bearer catalog-key' },
  ]);
  const official = await backend.checkConnection({
    ...profile,
    provider: 'deepseek-official',
    reasoning: 'xhigh',
  });
  assert.equal(official.ok, true);
  const officialCalls = (await readFile(runtimeLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(officialCalls.at(-2).params.model, 'deepseek-flash');
  assert.equal(officialCalls.at(-2).params.reasoningEffort, 'high');
  assert.equal(requests.length, 2, 'official connection check does not generate or query upstream');
});
test('DSH maps the official DeepSeek OpenAI base URL to Messages and classifies explicit provider errors', async (t) => {
  assert.equal(
    resolveDshBaseUrl('deepseek-official', 'https://api.deepseek.com/v1'),
    'https://api.deepseek.com/anthropic',
  );
  assert.equal(
    resolveDshBaseUrl('deepseek-official', undefined, undefined),
    'https://api.deepseek.com/anthropic',
  );
  assert.equal(
    resolveDshBaseUrl('custom-provider', 'https://gateway.example/v1'),
    'https://gateway.example/v1',
  );

  const app = await setup(t),
    script = join(app.runtime, 'failed-dsh.mjs'),
    log = join(app.runtime, 'failed-dsh-wire.jsonl');
  await writeFile(
    script,
    `import readline from 'node:readline';import fs from 'node:fs';const log=${JSON.stringify(log)};for await(const l of readline.createInterface({input:process.stdin})){const m=JSON.parse(l);fs.appendFileSync(log,JSON.stringify({...m,baseURL:process.env.DEEPSEEK_BASE_URL})+'\\n');let result={};if(m.method==='initialize')result={serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.2.2'}};if(m.method==='session/query'){result={kind:'prompt',messageId:'native-input'};console.log(JSON.stringify({method:'session.event',params:{sessionId:m.params.sessionId,event:{type:'turn/end',data:{reason:{kind:'error',error:{message:'DeepSeek Messages request failed (404)',code:'HTTP_404',status:404}}}}}}));}console.log(JSON.stringify({id:m.id,result}));if(m.method==='shutdown')break;}`,
  );
  const backend = new DshBackend(app.runtime, app.store, async () => undefined);
  t.after(() => backend.close());
  const profile = profileSchema.parse({
    id: 'dsh-failed',
    name: 'test',
    kind: 'dsh',
    command: process.execPath,
    args: [script],
    model: 'synthetic',
    provider: 'deepseek-official',
    endpoint: 'https://api.deepseek.com/v1',
  });
  const sessionId = await backend.createSession(profile, []);
  await assert.rejects(
    backend.generate({
      profile,
      sessionId,
      requestId: 'dsh-explicit-404',
      messages: [{ role: 'user', text: 'fixture' }],
      signal: new AbortController().signal,
    }),
    (error) =>
      error instanceof EchoError &&
      error.code === 'dsh_provider_failed' &&
      !error.uncertain &&
      /404/.test(error.message),
  );
  const wire = await import('node:fs/promises');
  const rows = (await wire.readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows[0].baseURL, 'https://api.deepseek.com/anthropic');
});
test('DSH keeps a query timeout unknown after request submission', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'timeout-dsh.mjs');
  await writeFile(
    script,
    `import readline from 'node:readline';for await(const l of readline.createInterface({input:process.stdin})){const m=JSON.parse(l);if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.2.2'}}}));continue;}if(m.method==='session/query')continue;console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='shutdown')break;}`,
  );
  const backend = new DshBackend(app.runtime, app.store, async () => undefined);
  t.after(() => backend.close());
  const profile = profileSchema.parse({
    id: 'dsh-timeout',
    name: 'test',
    kind: 'dsh',
    command: process.execPath,
    args: [script],
    model: 'synthetic',
    provider: 'deepseek-official',
    endpoint: 'https://api.deepseek.com/anthropic',
    timeoutMs: 1000,
  });
  const sessionId = await backend.createSession(profile, []);
  await assert.rejects(
    backend.generate({
      profile,
      sessionId,
      requestId: 'dsh-timeout',
      messages: [{ role: 'user', text: 'fixture' }],
      signal: new AbortController().signal,
    }),
    (error) => error instanceof EchoError && error.uncertain,
  );
});
test('embedded pi completes a genuine tool loop against a local synthetic model', async (t) => {
  const app = await setup(t);
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (data: any) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'local',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'synthetic',
            choices: [{ index: 0, ...data }],
          }) +
          '\n\n',
      );
    if (calls === 1) {
      assert(request.tools.some((tool: any) => tool.function.name === 'system_status'));
      frame({
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-one',
              type: 'function',
              function: { name: 'system_status', arguments: '{}' },
            },
          ],
        },
        finish_reason: null,
      });
      frame({ delta: {}, finish_reason: 'tool_calls' });
    } else {
      assert(request.messages.some((m: any) => m.role === 'tool'));
      frame({
        delta: { role: 'assistant', content: 'pi tool loop completed' },
        finish_reason: null,
      });
      frame({ delta: {}, finish_reason: 'stop' });
    }
    const promptTokens = calls === 1 ? 80 : 120;
    const completionTokens = calls === 1 ? 7 : 11;
    res.write('data: ' + JSON.stringify({ choices: [], usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_cache_hit_tokens: calls === 1 ? 0 : 64,
    } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const profile = profileSchema.parse({
    id: 'pi',
    name: 'local',
    kind: 'pi',
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    model: 'synthetic',
    reasoning: 'off',
  });
  const result = await new PiBackend(app.registry, async () => undefined).generate({
    profile,
    messages: [
      { role: 'system', text: 'Test safely using the available read tools.' },
      { role: 'user', text: 'Check system status.' },
    ],
    requestId: 'pi-one',
    contextDetails: [{ group: 'prefix', source: 'fixture', tokens: 10 }],
    signal: new AbortController().signal,
  });
  assert.equal(result.text, 'pi tool loop completed');
  assert.equal(calls, 2);
  assert.equal(result.metrics?.modelSteps, 2);
  assert.equal(result.metrics?.inputTokens, 120);
  assert.equal(result.metrics?.cacheHitPercent, 32);
  assert((result.metrics?.tokensPerSecond ?? 0) > 0);
  assert(Object.values(result.metrics?.context ?? {}).every((count) => count > 0));
  assert(result.metrics?.details?.some((item) => item.group === 'tools' && item.source === 'system_status'));
  assert(result.metrics?.details?.some((item) => item.group === 'turn' && item.source === 'execution'));
});

test('pi can generate from an application signal without changing its author to human', async (t) => {
  const app = await setup(t);
  let observed = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const ordered = input.messages.map((m: any) => JSON.stringify(m.content));
    observed =
      ordered.length === 4 &&
      ordered.every((text: string, i: number) =>
        text.includes(['PI_STABLE', 'PI_HISTORY', 'PI_PER_TURN', 'APP_EVENT_PI'][i]),
      ) &&
      input.messages.some(
        (m: any) => m.role === 'system' && JSON.stringify(m.content).includes('APP_EVENT_PI'),
      ) &&
      !input.messages.some(
        (m: any) => m.role === 'user' && JSON.stringify(m.content).includes('APP_EVENT_PI'),
      );
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          id: 'one',
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'pi application reply' },
              finish_reason: 'stop',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const profile = profileSchema.parse({
    id: 'pi-event',
    name: 'Fixture',
    kind: 'pi',
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    model: 'synthetic',
    reasoning: 'off',
  });
  const result = await new PiBackend(app.registry, async () => undefined).generate({
    profile,
    messages: [
      { role: 'system', text: 'PI_STABLE' },
      { role: 'assistant', id: 'old', text: 'PI_HISTORY' },
      { role: 'system', context: 'turn', text: 'PI_PER_TURN' },
      { role: 'system', text: 'APP_EVENT_PI: comment briefly on the current observation.' },
    ],
    requestId: 'event',
    signal: new AbortController().signal,
  });
  assert.equal(result.text, 'pi application reply');
  assert.equal(result.metrics?.inputTokens, 20);
  assert.equal(result.metrics?.cacheHitPercent, undefined);
  assert(observed);
});
