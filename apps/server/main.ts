import { storageLocation, applyStorageMigration, restoreStorageLocation } from '../../packages/kernel/storage.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { Application } from './application.ts';
import { serve } from './http.ts';
import { InstanceLock } from '../../packages/kernel/instance.ts';
import { z } from 'zod';

const project =
  process.env.ECHO_PROJECT_ROOT ??
  fileURLToPath(new URL(import.meta.url.includes('/dist/') ? '../' : '../../', import.meta.url));
const anchor =
  process.env.ECHO_DATA_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'Echo');
await mkdir(anchor, { recursive: true });
let runtime = await storageLocation(anchor);
await mkdir(runtime, { recursive: true });
let lock = InstanceLock.acquire(runtime);
const originalRuntime = runtime;
try {
  let targetLock: InstanceLock | undefined;
  const migrated = await applyStorageMigration(anchor, runtime, (held) => { targetLock = held; });
  if (migrated !== runtime) { const next = targetLock ?? InstanceLock.acquire(migrated); lock.release(); lock = next; runtime = migrated; }
} catch (error) { process.stderr.write('Storage migration failed; using original data: ' + (error as Error).message + '\n'); }

process.env.ECHO_DATA_DIR = runtime;
const openApplication = () => Application.create({
  runtime,
  project,
  nativePath: process.env.ECHO_NATIVE_PATH,
  plugins:
    process.env.ECHO_PLUGINS === undefined
      ? undefined
      : process.env.ECHO_PLUGINS.split(',').filter(Boolean),
});
let app: Application;
try { app = await openApplication(); }
catch (error) {
  if (runtime === originalRuntime) throw error;
  lock.release(); runtime = originalRuntime; lock = InstanceLock.acquire(runtime);
  await restoreStorageLocation(anchor, runtime); process.env.ECHO_DATA_DIR = runtime;
  process.stderr.write('Migrated data could not start; original location restored.\n');
  app = await openApplication();
}
const http = await serve(app, {
  webRoot: process.env.ECHO_WEB_ROOT ?? join(project, 'dist', 'web'),
  port: Number(process.env.ECHO_PORT ?? 0),
});
await writeFile(
  join(runtime, 'connection.json'),
  JSON.stringify({ url: `http://127.0.0.1:${http.port}`, token: http.token, pid: process.pid }),
  { mode: 0o600 },
);
process.stdout.write(`Echo ready on http://127.0.0.1:${http.port}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await http.close();
  await app.close();
  await unlink(join(runtime, 'connection.json')).catch(() => {});
  lock.release();
  process.exit(0);
}
app.registry.register({
  name: 'system.shutdown',
  description: '关闭此 Echo 核心',
  owner: 'launcher',
  permission: 'system.write',
  mcp: false,
  input: z.object({}),
  output: z.object({ accepted: z.boolean() }),
  run: () => {
    setTimeout(() => void close(), 20);
    return { accepted: true };
  },
});
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
