import { fakeDshPolicyAck } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, conversation, FakeBackend, until, temporary } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { EchoError, profileSchema } from '../packages/contracts/index.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';
import { codexEvent, dshEvent, piEvent } from '../packages/backends/execution-events.ts';
import { CodexBackend } from '../packages/backends/codex.ts';
import { PiBackend } from '../packages/backends/pi.ts';
import { DshBackend } from '../packages/backends/dsh.ts';
import { createServer } from 'node:http';

test('subtask authorization exports without local grants and rejects injected resource bindings', async (t) => {
  const app = await setup(t),
    project = await temporary(t);
  seedProfile(app, profileSchema.parse({ id: 'worker-model', name: 'Worker', kind: 'codex' }));
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  await call('persona.character.commit', {
    requestId: 'portable-role',
    draft: characterDraft.parse({
      persona: { id: 'portable', name: 'Portable', prompt: 'Synthetic' },
      features: ['delegation'],
      configurations: {
        delegation: {
          allowFullAccess: true,
          approvalReviewer: 'main',
          templates: [
            {
              id: 'reader',
              name: 'Reader',
              profileId: 'worker-model',
              projectDirectory: project,
              prompt: 'Read carefully',
            },
          ],
        },
      },
    }),
  });
  const pack = await call('persona.package.export', {
    personaId: 'portable',
    packageId: 'portable-pack',
    version: '1',
  });
  const feature = pack.features.find((f: any) => f.id === 'delegation');
  assert.equal(feature.version, 3);
  assert.equal(feature.configuration.templates, undefined);
  assert.equal(feature.configuration.allowedProfileIds, undefined);
  assert.equal(feature.configuration.workspaces, undefined);
  assert.equal(feature.configuration.allowFullAccess, undefined);
  assert.equal(feature.configuration.approvalReviewer, undefined);
  const imported = await call('persona.package.import', pack);
  assert.deepEqual(imported.missing, []);
  feature.configuration.workspaces = [{path:project,write:true}];
  await assert.rejects(call('persona.package.import', pack), /资源配置/);
  delete feature.configuration.workspaces;
  feature.configuration.allowFullAccess = true;
  await assert.rejects(call('persona.package.import', pack), /资源配置/);
});

test('worker resumption cannot race a new writer in the same project', async (t) => {
  const app = await setup(t),
    project = await temporary(t),
    backend = new FakeBackend();
  app.router.backends.set('codex', backend);
  seedProfile(app, profileSchema.parse({ id: 'worker-model', name: 'Worker', kind: 'codex' }));
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  const role = await call('persona.character.commit', {
    requestId: 'write-role',
    draft: characterDraft.parse({
      persona: { id: 'writer', name: 'Writer', prompt: 'Synthetic' },
      features: ['delegation'],
      configurations: {
        delegation: {
          concurrency: 2,
          reportOnCompletion: false,
          templates: [
            {
              id: 'writer',
              name: 'Writer',
              profileId: 'worker-model',
              projectDirectory: project,
              write: true,
            },
          ],
        },
      },
    }),
  });
  const first = await call('delegation.request', {
    requestId: 'first-writer',
    conversationId: role.mainConversationId,
    goal: 'Write fixture',
    acceptance: 'Return result',
    execution:{write:true},
  });
  await until(() => app.store.document<any>('delegated-tasks', first.id)?.state === 'completed');
  backend.responder = (request) =>
    new Promise((resolve) =>
      request.signal.addEventListener('abort', () => resolve({ text: 'Stopped' }), { once: true }),
    );
  const results = await Promise.allSettled([
    call('delegation.request', {
      requestId: 'second-writer',
      conversationId: role.mainConversationId,
      goal: 'Write another fixture',
      acceptance: 'Return result',
      execution:{write:true},
    }),
    call('delegation.resume', {
      requestId: 'resume-first',
      conversationId: role.mainConversationId,
      taskId: first.id,
      text: 'Revise fixture',
    }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(String((results[1] as PromiseRejectedResult).reason), /已有写入任务/);
  assert.equal(app.store.receipt('delegation.resume.resume-first'), undefined);
});

test('group cursor does not consume a shared notification arriving during generation', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  await call('persona.character.commit', {
    requestId: 'group-role',
    draft: characterDraft.parse({
      persona: { id: 'reader', name: 'Reader', prompt: 'Synthetic' },
      features: [],
      profileId: 'test',
    }),
  });
  await call('groups.save', { id: 'late-group', name: 'Group', members: ['reader'] });
  backend.responder = async (request) => {
    const conversationId = app.store.run(request.requestId)!.conversationId;
    const message = app.store.append(
      conversationId,
      'system',
      'notification',
      'LATE_SHARED_RESULT',
    );
    app.events.emit('message.posted', {
      conversationId,
      messageId: message.id,
    });
    return { text: 'First response' };
  };
  await call('groups.send', {
    groupId: 'late-group',
    text: 'First',
    speakers: ['reader'],
    requestId: 'late-first',
  });
  await until(() => app.store.document<any>('group-turns', 'late-first')?.state === 'completed');
  backend.responder = async () => ({ text: 'Second response' });
  await call('groups.send', {
    groupId: 'late-group',
    text: 'Second',
    speakers: ['reader'],
    requestId: 'late-second',
  });
  await until(() => app.store.document<any>('group-turns', 'late-second')?.state === 'completed');
  const input = backend.calls[1].messages.at(-1)!.text;
  assert(input.includes('LATE_SHARED_RESULT'));
  assert(!input.includes('First response'));
});

test('execution items survive reload, coalesce deltas and stay out of model and Review messages', async (t) => {
  const app = await setup(t),
    chat = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  backend.responder = async (request) => {
    request.onItem?.({
      id: 'cmd',
      kind: 'command',
      title: 'Fixture',
      state: 'running',
      detail: '{"exitCode":0}',
    });
    for (let i = 0; i < 100; i++)
      request.onItem?.({ id: 'cmd', kind: 'command', delta: 'TRACE_PRIVATE_' + '.'.repeat(1000) });
    request.onItem?.({ id: 'cmd', kind: 'command', state: 'completed' });
    return { text: 'Done' };
  };
  const run = await app.router.send({
    conversationId: chat.id,
    text: 'Run fixture',
    requestId: 'trace',
  });
  const items = app.router.execution.list(run.id);
  assert.equal(items.length, 1);
  assert(items[0].truncated);
  assert(items[0].text!.length <= 65536);
  assert.equal(items[0].state, 'completed');
  assert.equal(app.store.documents('execution.' + run.id).length, 1);
  assert(!JSON.stringify(app.store.allMessages(chat.id)).includes('TRACE_PRIVATE_'));
  backend.responder = async (request) => {
    assert(!JSON.stringify(request.messages).includes('TRACE_PRIVATE_'));
    return { text: 'Next' };
  };
  await app.router.send({ conversationId: chat.id, text: 'Next', requestId: 'trace-next' });
});

test('steering is admitted once to the active native run and queue cancellation never starts another turn', async (t) => {
  const app = await setup(t),
    chat = conversation(app);
  let release: (v: any) => void = () => {},
    steers = 0;
  const backend = new FakeBackend() as any;
  backend.capabilities = () => ({ events: true, steer: true, images: true, projectTools: true });
  backend.responder = async (request: any) =>
    new Promise((resolve) => {
      release = resolve;
      request.signal.addEventListener('abort', () => resolve({ text: 'Stopped' }), { once: true });
      request.onNativeRun?.('native-turn');
    });
  backend.steer = async () => {
    steers++;
  };
  app.router.backends.set('api', backend);
  const promise = app.router.send({ conversationId: chat.id, text: 'Start', requestId: 'first' });
  await until(() => backend.calls.length === 1);
  const run = app.store.run('first')!;
  const input = {
    conversationId: chat.id,
    runId: run.id,
    requestId: 'steer-one',
    text: 'Use this requirement',
  };
  assert.equal((await app.router.steer(input)).state, 'accepted');
  await app.router.steer(input);
  assert.equal(steers, 1);
  assert.equal(app.store.allMessages(chat.id).filter((m) => m.meta.steer).length, 1);
  app.router.enqueue({ conversationId: chat.id, text: 'Queued', requestId: 'queued' });
  app.router.cancelInput('queued', chat.id);
  release({ text: 'Finished with requirement' });
  await promise;
  assert.equal(backend.calls.length, 1);
  await assert.rejects(app.router.steer({ ...input, requestId: 'too-late' }), /已结束/);
});

test('uncertain steering cannot be silently retried', async (t) => {
  const app = await setup(t),
    chat = conversation(app);
  let release: (v: any) => void = () => {},
    calls = 0;
  const backend = new FakeBackend() as any;
  backend.capabilities = () => ({ steer: true });
  backend.steer = async () => {
    calls++;
    throw new EchoError('rpc_timeout', 'Timed out', true);
  };
  backend.responder = () => new Promise((resolve) => (release = resolve));
  app.router.backends.set('api', backend);
  const promise = app.router.send({ conversationId: chat.id, text: 'Start', requestId: 'start' });
  await until(() => backend.calls.length === 1);
  const input = {
    conversationId: chat.id,
    runId: app.store.run('start')!.id,
    requestId: 'uncertain',
    text: 'Update',
  };
  await assert.rejects(app.router.steer(input), /Timed out/);
  assert.equal((await app.router.steer(input)).state, 'unknown');
  assert.equal(calls, 1);
  release({ text: 'Done' });
  await promise;
});

test('attachments are scoped and hydrated without putting base64 in conversation history', async (t) => {
  const app = await setup(t),
    chat = conversation(app),
    other = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const text = await app.router.attachments.add(
    chat.id,
    'reference.enw',
    'application/octet-stream',
    Buffer.from('%0 Journal Article\n%T REFERENCE_FACT\n%J Synthetic Journal\n').toString('base64'),
  );
  assert.equal(text.kind, 'text');
  await assert.rejects(
    app.router.send({
      conversationId: other.id,
      text: 'Read',
      requestId: 'foreign',
      attachmentIds: [text.id],
    }),
    /不属于/,
  );
  backend.responder = async (request) => {
    assert(JSON.stringify(request.messages).includes('REFERENCE_FACT'));
    return { text: 'Read notes' };
  };
  await app.router.send({
    conversationId: chat.id,
    text: 'Read this',
    requestId: 'attachment',
    attachmentIds: [text.id],
  });
  const stored = app.store.allMessages(chat.id).find((m) => m.role === 'user')!;
  assert.equal(stored.text, 'Read this');
  assert.equal((stored.meta.attachments as any)[0].id, text.id);
  const png = await readFile(join(app.project, 'apps/workbench/public/assets/cute-girl/atlas.png'));
  const image = await app.router.attachments.add(
    chat.id,
    'image.png',
    'image/png',
    png.toString('base64'),
  );
  assert.equal(image.kind, 'image');
});

test('workers return one event-driven handoff and only the parent can accept verified deliverables', async (t) => {
  const app = await setup(t),
    project = await temporary(t),
    worker = new FakeBackend(),
    parent = new FakeBackend();
  app.router.backends.set('codex', worker);
  app.router.backends.set('api', parent);
  seedProfile(app, profileSchema.parse({ id: 'worker', kind: 'codex', name: 'Worker' }));
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  await writeFile(join(project, 'deliverable.md'), 'A verified file');
  const role: any = await call('persona.character.commit', {
    requestId: 'role',
    draft: characterDraft.parse({
      persona: { id: 'chief', name: 'Chief', prompt: 'Synthetic' },
      profileId: 'test',
      features: ['delegation'],
      configurations: {
        delegation: {
          reportOnCompletion: true,
          templates: [
            { id: 'build', name: 'Build', profileId: 'worker', projectDirectory: project },
          ],
        },
      },
    }),
  });
  worker.responder = async () => {
    const task = app.store.documents<any>('delegated-tasks')[0];
    await call('delegation.submit', {
      conversationId: task.workerConversationId,
      taskId: task.id,
      summary: 'Created file',
      artifacts: ['deliverable.md'],
      verification: 'Fixture wrote file',
      unresolved: '',
    });
    return { text: 'Created deliverable' };
  };
  parent.responder = async (request) => {
    assert(request.messages.some((m) => m.role === 'system' && m.text.includes('待核对资料')));
    return { text: 'I will review the evidence' };
  };
  const task: any = await call('delegation.request', {
    requestId: 'work',
    conversationId: role.mainConversationId,
    execution:{profileId:'worker',projectDirectory:project},
    goal: 'Build a file',
    acceptance: 'File exists',
  });
  await until(() => parent.calls.length === 1);
  await until(() =>
    app.store.runs().some((run) => run.source === 'handoff' && run.state === 'succeeded'),
  );
  const completed = app.store.document<any>('delegated-tasks', task.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.acceptanceStatus, 'pending');
  assert.equal(completed.evidence[0].state, 'verified');
  assert(completed.evidence[0].sha256);
  await assert.rejects(
    call('delegation.review', {
      conversationId: task.workerConversationId,
      taskId: task.id,
      attempt: 1,
      decision: 'accepted',
      text: 'Self approve',
    }),
    /发起会话/,
  );
  await call('delegation.review', {
    conversationId: role.mainConversationId,
    taskId: task.id,
    attempt: 1,
    decision: 'accepted',
    text: 'Checked file and evidence',
  });
  assert.equal(app.store.document<any>('delegated-tasks', task.id).acceptanceStatus, 'accepted');
  assert.equal(parent.calls.length, 1);
});

test('native event mappings retain commands, diffs, DSH settlements and Pi tool progress', () => {
  assert.equal(
    codexEvent('item/completed', {
      item: {
        id: 'c',
        type: 'commandExecution',
        command: 'test',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'PASS',
      },
    })?.kind,
    'command',
  );
  assert.equal(codexEvent('turn/diff/updated', { diff: 'diff content' })?.text, 'diff content');
  assert.equal(
    dshEvent({
      type: 'assistant/message',
      seq: 2,
      data: { message: { content: [{ type: 'text', text: 'Settled' }] } },
    })?.text,
    'Settled',
  );
  assert.equal(
    piEvent({
      type: 'tool_execution_end',
      toolCallId: 'x',
      toolName: 'read',
      result: { content: [] },
    })?.state,
    'completed',
  );
});

test('Codex wire accepts steering on the active turn and streams native command and diff items', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'codex-execution.mjs');
  await writeFile(
    script,
    `import readline from 'node:readline';const send=v=>console.log(JSON.stringify(v));for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;let result={};if(m.method==='model/list')result={data:[{id:'test',model:'test',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};if(m.method==='thread/start')result={thread:{id:'native'}};if(m.method==='turn/start')result={turn:{id:'active'}};send({id:m.id,result});if(m.method==='turn/start'){send({method:'item/started',params:{threadId:'native',turnId:'active',item:{id:'cmd',type:'commandExecution',command:'fixture'}}});}if(m.method==='turn/steer'){if(m.params.expectedTurnId!=='active')throw Error('Wrong turn');send({method:'item/completed',params:{threadId:'native',turnId:'active',item:{id:'cmd',type:'commandExecution',command:'fixture',status:'completed',exitCode:0,aggregatedOutput:'PASS'}}});send({method:'turn/diff/updated',params:{threadId:'native',turnId:'active',diff:'sample diff'}});send({method:'item/completed',params:{threadId:'native',turnId:'active',item:{id:'answer',type:'agentMessage',text:'Steered answer'}}});send({method:'turn/completed',params:{threadId:'native',turn:{id:'active',status:'completed'}}});}}`,
  );
  const backend = new CodexBackend(app.runtime, app.store);
  app.router.backends.set('codex', backend);
  const profile = profileSchema.parse({
    id: 'wire',
    name: 'Wire',
    kind: 'codex',
    command: process.execPath,
    args: [script],
  });
  const sessionId = await backend.createSession(profile, [], new AbortController().signal);
  let ready = false;
  const items: any[] = [];
  const pending = backend.generate({
    profile,
    sessionId,
    messages: [{ role: 'user', text: 'Start' }],
    requestId: 'wire-run',
    signal: AbortSignal.timeout(8000),
    onNativeRun: () => (ready = true),
    onItem: (item) => items.push(item),
  });
  void pending.catch(() => {});
  await until(() => ready);
  await backend.steer({ requestId: 'wire-run', text: 'New instruction' });
  assert.equal((await pending).text, 'Steered answer');
  assert(items.some((item) => item.kind === 'command' && item.text === 'PASS'));
  assert(items.some((item) => item.kind === 'files'));
});

test('Pi official terminal tool executes only after its exact workbench approval', {timeout:45000}, async (t) => {
  const app = await setup(t),
    project = await temporary(t);
  let calls = 0,
    approved = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (choice: any) =>
      res.write(
        'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, ...choice }] }) + '\n\n',
      );
    if (calls === 1) {
      assert(request.tools.some((tool: any) => tool.function.name === 'powershell'));
      frame({
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'shell',
              type: 'function',
              function: {
                name: 'powershell',
                arguments: JSON.stringify({ command: "Write-Output 'ECHO_TERMINAL_OK'" }),
              },
            },
          ],
        },
        finish_reason: null,
      });
      frame({ delta: {}, finish_reason: 'tool_calls' });
    } else {
      assert(JSON.stringify(request.messages).includes('ECHO_TERMINAL_OK'));
      frame({ delta: { role: 'assistant', content: 'Terminal verified' }, finish_reason: 'stop' });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const profile = profileSchema.parse({
    id: 'pi-terminal',
    name: 'Fixture',
    kind: 'pi',
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    model: 'synthetic',
    reasoning: 'off',
  });
  const backend = new PiBackend(
      app.registry,
      async () => undefined,
      () => new Set(),
      app.runtime,
    ),
    items: any[] = [];
  const result = await backend.generate({
    profile,
    messages: [{ role: 'user', text: 'Run the fixture' }],
    requestId: 'terminal',
    signal: AbortSignal.timeout(30000),
    permissions: {
      projectDirectory: project,
      codex: { sandbox: 'read-only', approvals: 'deny' },
      dsh: { approvals: 'deny' },
      pi: { tools: 'ask', projectWrite: true, terminal: true },
    },
    onInteraction: async (request) => {
      assert(request.kind === 'approval');
      assert(request.detail?.includes('ECHO_TERMINAL_OK'));
      approved++;
      return { decision: 'allow' };
    },
    onItem: (item) => items.push(item),
  });
  assert.equal(result.text, 'Terminal verified');
  assert.equal(approved, 1);
  assert.equal(calls, 2);
  assert(items.some((item) => item.title === 'powershell' && item.state === 'completed'));
});

test('DSH child events and approvals belong to the announced parent without replacing its final reply', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'dsh-children.mjs');
  await writeFile(
    script,
    `${fakeDshPolicyAck}import readline from 'node:readline';const send=v=>console.log(JSON.stringify(v));let session,waitId,approved=false,foreign=false;const finish=()=>{if(!waitId||!approved||!foreign)return;send({method:'subagent.finished',params:{parentSessionId:session,childSessionId:'child',status:'completed'}});send({method:'session.event',params:{sessionId:session,event:{type:'assistant/message',seq:9,data:{message:{content:[{type:'text',text:'Parent answer'}]}}}}});send({id:waitId,result:{}});waitId=undefined;};for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(!m.method){if(m.id===77)approved=m.result?.outcome==='allowed-once';if(m.id===88)foreign=Boolean(m.error);finish();continue;}if(m.method==='initialize')send({id:m.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});else if(m.method==='session/query'){session=m.params.sessionId;send({id:m.id,result:{kind:'prompt',messageId:'message'}});send({method:'subagent.started',params:{parentSessionId:session,childSessionId:'child'}});send({method:'session.event',params:{sessionId:'child',event:{type:'tool/call',seq:1,data:{callId:'read',toolName:'read',input:{path:'fixture'}}}}});send({id:77,method:'approval/request',params:{sessionId:'child',toolName:'read',reason:'Fixture child'}});send({id:88,method:'approval/request',params:{sessionId:'foreign',toolName:'read'}});}else if(m.method==='session/wait'){waitId=m.id;finish();}else{send({id:m.id,result:{}});if(m.method==='shutdown')process.exit(0);}}`,
  );
  const backend = new DshBackend(app.runtime, app.store, async () => undefined);
  app.router.backends.set('dsh', backend);
  const profile = profileSchema.parse({
    id: 'dsh-child',
    name: 'Fixture',
    kind: 'dsh',
    provider: 'deepseek-official',
    command: process.execPath,
    args: [script],
  });
  let approvals = 0;
  const items: any[] = [];
  const result = await backend.generate({
    profile,
    messages: [{ role: 'user', text: 'Run child' }],
    requestId: 'dsh-child',
    signal: AbortSignal.timeout(10000),
    permissions: {
      projectDirectory: '',
      codex: { sandbox: 'read-only', approvals: 'deny' },
      dsh: { approvals: 'ask' },
      pi: { tools: 'read', projectWrite: false },
    },
    onInteraction: async () => {
      approvals++;
      return { decision: 'allow' };
    },
    onItem: (item) => items.push(item),
  });
  assert.equal(result.text, 'Parent answer');
  assert.equal(approvals, 1);
  assert(items.some((item) => item.kind === 'tool' && item.parentId === 'child-child'));
  assert(items.some((item) => item.kind === 'subagent' && item.state === 'completed'));
});
