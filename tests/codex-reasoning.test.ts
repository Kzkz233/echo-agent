import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectCodexReasoning, codexFailure } from '../packages/backends/codex-reasoning.ts';
import { CodexBackend } from '../packages/backends/codex.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { setup } from './helpers.ts';
const models = [
  {
    id: 'synthetic',
    model: 'synthetic',
    isDefault: true,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
    ],
  },
];
test('Codex effort uses the model catalog, maps off to the lowest supported level and restores inherited default', () => {
  assert.equal(selectCodexReasoning(models, undefined, 'off', 'inherit').effort, 'low');
  assert.equal(selectCodexReasoning(models, undefined, 'inherit', 'inherit').effort, 'medium');
  assert.equal(selectCodexReasoning(models, 'synthetic', 'inherit', 'high').effort, 'high');
  assert.throws(() => selectCodexReasoning(models, 'synthetic', 'xhigh', 'inherit'), /不支持/);
  assert.throws(() => selectCodexReasoning([], undefined, 'off', 'inherit'), /思考选项/);
  assert.equal(
    codexFailure({ message: JSON.stringify({ error: { message: 'unsupported effort' } }) }),
    'unsupported effort',
  );
  assert.equal(codexFailure({ message: 'Bearer secret sk-synthetic' }), '[redacted] [redacted]');
});
test('off/inherit controls each native turn without replay, and failed turns preserve the provider reason', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'reasoning.mjs'),
    log = join(app.runtime, 'wire.jsonl');
  await writeFile(
    script,
    `import readline from 'node:readline';import fs from 'node:fs';let n=0;for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');let result={};if(m.method==='thread/start')result={thread:{id:'native',model:'synthetic'}};if(m.method==='model/list')result={data:${JSON.stringify(models)},nextCursor:null};if(m.method==='turn/start')result={turn:{id:'turn-'+(++n)}};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start'){const failed=n===3;console.log(JSON.stringify({method:'turn/completed',params:{threadId:'native',turn:{id:'turn-'+n,status:failed?'failed':'completed',error:failed?{message:JSON.stringify({error:{message:'synthetic model rejected parameter'}})}:null}}}));}}`,
  );
  const backend = new CodexBackend(app.runtime, app.store);
  app.router.backends.set('codex', backend);
  t.after(() => backend.close());
  const profile = profileSchema.parse({
    id: 'c',
    name: 'Synthetic',
    kind: 'codex',
    command: process.execPath,
    args: [script],
  });
  const sessionId = await backend.createSession(profile, [], new AbortController().signal);
  const request = {
    profile,
    sessionId,
    messages: [{ role: 'user' as const, text: 'Synthetic' }],
    requestId: '1',
    signal: new AbortController().signal,
  };
  const first = await backend.generate({ ...request, reasoning: 'off' });
  assert.equal(first.execution?.effort, 'low');
  assert.equal(
    (await backend.generate({ ...request, requestId: '2', reasoning: 'inherit' })).execution
      ?.effort,
    'medium',
  );
  await assert.rejects(
    backend.generate({ ...request, requestId: '3' }),
    /synthetic model rejected parameter/,
  );
  const wire = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    wire.filter((m) => m.method === 'turn/start').map((m) => m.params.effort),
    ['low', 'medium', 'medium'],
  );
  assert.equal(wire.filter((m) => m.method === 'model/list').length, 1);
});
