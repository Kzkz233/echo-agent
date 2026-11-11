import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from './helpers.ts';
import { CodexBackend } from '../packages/backends/codex.ts';
import { profileSchema, EchoError } from '../packages/contracts/index.ts';

for (const relevant of [true, false])
  test(`Codex inactivity deadline counts only progress from the active thread (${relevant})`, async (t) => {
    const app = await setup(t, []),
      script = join(app.runtime, 'progress.mjs');
    await writeFile(
      script,
      `import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;let result=m.method==='model/list'?{data:[]}:m.method==='thread/start'?{thread:{id:'native'}}:m.method==='turn/start'?{turn:{id:'turn'}}:{};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){const timer=setInterval(()=>console.log(JSON.stringify({method:'item/reasoning/summaryTextDelta',params:{threadId:${JSON.stringify(relevant ? 'native' : 'other')},turnId:'turn',delta:'working'}})),150);setTimeout(()=>{clearInterval(timer);console.log(JSON.stringify({method:'item/completed',params:{threadId:'native',turnId:'turn',item:{type:'agentMessage',text:'done'}}}));console.log(JSON.stringify({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'completed'}}}));},1600);}}`,
    );
    const backend = new CodexBackend(app.runtime, app.store);
    const profile = profileSchema.parse({
      id: 'fixture',
      name: 'Fixture',
      kind: 'codex',
      command: process.execPath,
      args: [script],
      timeoutMs: 1000,
    });
    try {
      const run = backend.generate({
        profile,
        messages: [{ role: 'user', text: 'synthetic' }],
        requestId: 'progress',
        signal: AbortSignal.timeout(6000),
      });
      if (relevant) assert.equal((await run).text, 'done');
      else
        await assert.rejects(
          run,
          (error) =>
            error instanceof EchoError && error.code === 'codex_timeout' && error.uncertain,
        );
    } finally {
      await backend.close();
    }
  });
