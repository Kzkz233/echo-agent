import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PiBackend } from '../packages/backends/pi.ts';
import { CodexBackend } from '../packages/backends/codex.ts';
import { DshBackend } from '../packages/backends/dsh.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { Registry } from '../packages/kernel/registry.ts';
import { setup, fakeDshPolicyAck } from './helpers.ts';

for (const kind of ['pi', 'codex', 'dsh'] as const)
  test(`${kind} honors the caller deadline beyond thirty minutes while progress continues`, async (t) => {
    const now = Date.now.bind(Date);
    let elapsed = 0;
    t.mock.method(Date, 'now', () => now() + elapsed);
    const progress = () => {
      elapsed = 31 * 60000;
    };
    const app = await setup(t, []);
    const lifetime = new AbortController();
    t.after(() => lifetime.abort());
    if (kind === 'pi') {
      const timers: NodeJS.Timeout[] = [];
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = () =>
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'fixture',
                model: 'synthetic',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'Progress ' },
                    finish_reason: null,
                  },
                ],
              }) +
              '\n\n',
          );
        for (const delay of [50, 150, 650, 1150]) timers.push(setTimeout(delta, delay));
        timers.push(
          setTimeout(
            () =>
              res.end(
                'data: ' +
                  JSON.stringify({
                    id: 'fixture',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  }) +
                  '\n\ndata: [DONE]\n\n',
              ),
            1500,
          ),
        );
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      t.after(
        () =>
          new Promise<void>((done) => {
            timers.forEach(clearTimeout);
            server.closeAllConnections();
            server.close(() => done());
          }),
      );
      const backend = new PiBackend(new Registry(), async () => undefined);
      const profile = profileSchema.parse({
        id: kind,
        name: 'Fixture',
        kind,
        model: 'synthetic',
        timeoutMs: 2000,
        endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      });
      const result = await backend.generate({
        profile,
        requestId: 'long',
        toolPolicy: 'none',
        messages: [{ role: 'user', text: 'Continue working' }],
        onDelta: progress,
        signal: lifetime.signal,
      });
      assert.match(result.text, /Progress/);
      const cancelled = new AbortController();
      await assert.rejects(
        backend.generate({
          profile,
          requestId: 'cancel',
          toolPolicy: 'none',
          messages: [{ role: 'user', text: 'Fixture' }],
          onDelta: () => cancelled.abort(),
          signal: cancelled.signal,
        }),
      );
      return;
    }
    const script = join(app.runtime, 'fake-host.mjs');
    const host =
      kind === 'codex'
        ? `import readline from 'node:readline';const send=v=>console.log(JSON.stringify(v));
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;
send({id:m.id,result:m.method==='thread/start'?{thread:{id:'native'}}:m.method==='turn/start'?{turn:{id:'turn'}}:{}});
if(m.method==='turn/start'){for(const delay of [50,150,650,1150])setTimeout(()=>send({method:'item/agentMessage/delta',params:{threadId:'native',turnId:'turn',delta:'Progress '}}),delay);
setTimeout(()=>send({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'completed'}}}),1500);}}`
        : `${fakeDshPolicyAck}import readline from 'node:readline';const send=v=>console.log(JSON.stringify(v));let session;
for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;
if(m.method==='session/query')session=m.params.sessionId;
if(m.method==='session/wait'){for(const delay of [50,150,650,1150])setTimeout(()=>send({method:'session.event',params:{sessionId:session,event:{type:'assistant/message',data:{message:{content:[{type:'text',text:'Progress'}]}}}}}),delay);
setTimeout(()=>send({id:m.id,result:{}}),1500);continue;}
send({id:m.id,result:m.method==='initialize'?{serverInfo:{name:'deepseek-harness-sdk-runtime'}}:m.method==='session/query'?{kind:'prompt',messageId:'input'}:{}});if(m.method==='shutdown')break;}`;
    await writeFile(script, host);
    const backend =
      kind === 'codex'
        ? new CodexBackend(app.runtime, app.store)
        : new DshBackend(app.runtime, app.store, async () => undefined);
    app.router.backends.set(kind, backend);
    t.after(() => backend.close());
    const profile = profileSchema.parse({
      id: kind,
      name: 'Fixture',
      kind,
      model: 'synthetic',
      command: process.execPath,
      args: [script],
      timeoutMs: 1000,
      provider: 'deepseek-official',
    });
    const sessionId = await backend.createSession(profile, [], lifetime.signal);
    const result = await backend.generate({
      profile,
      sessionId,
      requestId: 'long',
      onDelta: progress,
      onItem: progress,
      messages: [{ role: 'user', text: 'Continue working' }],
      signal: lifetime.signal,
    });
    assert.match(result.text, /Progress/);
    const cancelled = new AbortController();
    await assert.rejects(
      backend.generate({
        profile,
        sessionId,
        requestId: 'cancel',
        messages: [{ role: 'user', text: 'Cancel fixture' }],
        signal: cancelled.signal,
        onDelta: () => cancelled.abort(),
        onItem: () => cancelled.abort(),
      }),
    );
  });
