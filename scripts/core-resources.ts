import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
const project = resolve(import.meta.dirname, '..'),
  base = join(project, 'test-results/runtime');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'core-'));
const child = spawn(
  join(project, 'dist/runtime/node.exe'),
  [join(project, 'dist/runtime/dist/server.mjs')],
  {
    cwd: join(project, 'dist/runtime'),
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ECHO_DATA_DIR: runtime,
      ECHO_PROJECT_ROOT: join(project, 'dist/runtime'),
    },
  },
);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let connection: any;
const rpc = async (method: string) => {
  const response = await fetch(connection.url + '/rpc', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });
  const data = (await response.json()) as any;
  if (data.error) throw Error(data.error.message);
  return data.result;
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      connection = JSON.parse(await readFile(join(runtime, 'connection.json'), 'utf8'));
      break;
    } catch {
      if (child.exitCode !== null) throw Error('Core exited before readiness');
      await pause(100);
    }
  }
  if (!connection) throw Error('Core not ready');
  await pause(2000);
  const first = await rpc('system.status'),
    start = performance.now();
  await pause(15000);
  const last = await rpc('system.status'),
    seconds = (performance.now() - start) / 1000,
    cpuMicros = last.cpu.user + last.cpu.system - first.cpu.user - first.cpu.system;
  const result = {
    seconds,
    rssMB: last.resources.rss / 1048576,
    cpuCorePercent: (cpuMicros / 1000000 / seconds) * 100,
    cpuMachinePercent: (cpuMicros / 1000000 / seconds / availableParallelism()) * 100,
    activeRuns: last.activeRuns,
    captureEnabled: last.observation.enabled,
    paidCalls: 0,
  };
  await writeFile(
    join(project, 'test-results/core-resources.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  if (connection) await rpc('system.shutdown').catch(() => {});
  await pause(500);
  if (child.exitCode === null) child.kill();
}
