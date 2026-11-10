import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../apps/server/application.ts';
import { requestStorageMigration, storageLocation } from '../packages/kernel/storage.ts';
const project = resolve(import.meta.dirname, '..'), base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const testRoot = await mkdtemp(join(base, 'storage-startup-')), original = join(testRoot, 'original'), target = join(testRoot, 'new data');
const app = await Application.create({ project, runtime: original, plugins: [] });
app.store.put('personas', 'fixture', { id: 'fixture', name: 'Storage fixture', prompt: 'Literal path must stay unchanged: ' + original });
await app.close();
await requestStorageMigration(original, target);
let child: ReturnType<typeof spawn> | undefined;
const start = async () => {
  child = spawn(process.execPath, ['dist/server.mjs'], { cwd: project, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ECHO_DATA_DIR: original, ECHO_PROJECT_ROOT: project, ECHO_PLUGINS: '', ECHO_PORT: '0' } });
  let error = ''; child.stderr!.on('data', (data) => error += data);
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error('Synthetic startup failed: ' + error);
    try {
      const location = await storageLocation(original), connection = JSON.parse(await readFile(join(location, 'connection.json'), 'utf8'));
      return { connection, location };
    } catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  throw Error('Synthetic startup timed out: ' + error);
};
const rpc = async (connection: any, method: string) => {
  const response = await fetch(connection.url + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) });
  const result = await response.json() as any; assert(!result.error); return result.result;
};
const stop = async (connection: any) => {
  const exited = new Promise((done) => child!.once('exit', done)); await rpc(connection, 'system.shutdown'); await exited; child = undefined;
};
try {
  for (let run = 0; run < 2; run++) {
    const { location, connection } = await start(); assert.equal(location, target);
    assert.equal((await rpc(connection, 'storage.status')).root, target);
    assert.equal((await rpc(connection, 'system.bootstrap')).personas.find((role: any) => role.id === 'fixture').prompt, 'Literal path must stay unchanged: ' + original);
    await stop(connection);
  }
  const result = { offlineMigration: true, bootstrapLocator: true, explicitEnvironmentCompatible: true, restartAtNewLocation: true, personaTextPreserved: true };
  await writeFile(join(project, 'test-results/storage-startup.json'), JSON.stringify(result)); console.log(JSON.stringify(result));
} finally { child?.kill(); }
