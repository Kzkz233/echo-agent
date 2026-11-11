import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.ts';
import { resolveCodexCommand } from '../packages/backends/codex-command.ts';
import { StdioRpc } from '../packages/backends/rpc.ts';
import { EchoError, profileSchema } from '../packages/contracts/index.ts';
import { modelProfileSchema } from '../packages/contracts/inference.ts';

test('Codex auto lookup follows the current executable and supports npm without shell argument interpolation', async (t) => {
  const root = await temporary(t);
  const storeA = join(root, 'store-a'),
    storeB = join(root, 'store-b');
  for (const directory of [storeA, storeB]) {
    await mkdir(join(directory, 'app/resources'), { recursive: true });
    await writeFile(join(directory, 'app/resources/codex.exe'), 'synthetic', { mode: 0o755 });
  }
  const args = ['app-server', '-c', 'a="value with & spaces"'];
  const resolve = (store: string) =>
    resolveCodexCommand('codex', args, {
      env: { PATH: join(root, 'stale-version') },
      platform: 'win32',
      storeRoots: async () => [store],
    });
  assert.equal((await resolve(storeA)).command, join(storeA, 'app/resources/codex.exe'));
  assert.equal((await resolve(storeB)).command, join(storeB, 'app/resources/codex.exe'));
  const npm = join(root, 'npm');
  await mkdir(join(npm, 'node_modules/@openai/codex/bin'), { recursive: true });
  await writeFile(join(npm, 'codex.cmd'), 'synthetic npm shim', { mode: 0o755 });
  await writeFile(join(npm, 'node_modules/@openai/codex/bin/codex.js'), '// synthetic', {
    mode: 0o755,
  });
  const launcher = await resolveCodexCommand('codex', args, {
    env: { PATH: npm },
    platform: 'win32',
  });
  assert.equal(launcher.command, process.execPath);
  assert.deepEqual(launcher.args, [join(npm, 'node_modules/@openai/codex/bin/codex.js'), ...args]);
  assert.deepEqual(await resolveCodexCommand(join(root, 'pinned-missing.exe'), args), {
    command: join(root, 'pinned-missing.exe'),
    args,
  });
});

test('failed host launch is definite, while an interrupted submitted mutation remains uncertain', async (t) => {
  const root = await temporary(t);
  const missing = new StdioRpc(join(root, 'missing.exe'), [], root);
  await assert.rejects(
    missing.call('initialize', {}),
    (error) =>
      error instanceof EchoError && error.code === 'rpc_launch_missing' && !error.uncertain,
  );
  await missing.close();
  const script = join(root, 'disconnect.mjs');
  await writeFile(
    script,
    "import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){process.exit(7)}",
  );
  for (const [method, uncertain] of [
    ['initialize', false],
    ['turn/start', true],
  ] as const) {
    const rpc = new StdioRpc(process.execPath, [script], root);
    await assert.rejects(
      rpc.call(method, {}),
      (error) =>
        error instanceof EchoError && error.uncertain === uncertain && error.message.includes('7'),
    );
    await rpc.close();
  }
});

test('generation defaults allow long work but preserve explicitly saved small budgets and deadlines', () => {
  const profile = profileSchema.parse({ id: 'fixture', name: 'Fixture', kind: 'api' });
  const model = modelProfileSchema.parse({
    id: 'fixture',
    name: 'Fixture',
    connectionId: 'fixture',
  });
  assert.equal(profile.maxOutputTokens, 65536);
  assert.equal(model.maxOutputTokens, 65536);
  assert.equal(profile.timeoutMs, 300000);
  assert.equal(model.timeoutMs, 300000);
  assert.equal(
    profileSchema.parse({ ...profile, maxOutputTokens: 2048, timeoutMs: 30000 }).maxOutputTokens,
    2048,
  );
  assert.equal(
    modelProfileSchema.parse({ ...model, maxOutputTokens: 2048, timeoutMs: 30000 }).timeoutMs,
    30000,
  );
});
