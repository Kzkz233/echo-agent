import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DshBackend } from '../packages/backends/dsh.ts';
import { Store } from '../packages/kernel/store.ts';
import { profileSchema } from '../packages/contracts/index.ts';
const entry = process.env.ECHO_DSH_ENTRY;
if (!entry) throw Error('Set ECHO_DSH_ENTRY to the installed official DSH CLI entry.');
await mkdir(join(tmpdir(), 'EchoTests'), { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'EchoTests', 'dsh-catalog-'));
let posts = 0;
const server = createServer((req, res) => {
  if (req.method === 'POST') posts++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: [] }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const store = new Store(join(root, 'echo.db'));
const backend = new DshBackend(root, store, async () => 'local-fixture-key');
try {
  const profile = profileSchema.parse({ id: 'catalog', name: 'Catalog fixture', kind: 'dsh',
    provider: 'deepseek-official', apiKeyRef: 'fixture', model: 'deepseek-flash',
    endpoint: 'http://127.0.0.1:' + (server.address() as any).port + '/anthropic',
    command: process.env.ECHO_DSH_COMMAND ?? process.execPath,
    args: [entry, '--profile', 'sdk-minimal'], timeoutMs: 30000,
  });
  const rows = await backend.listModels(profile);
  const model = rows.find((row) => row.id === profile.model);
  assert(model?.reasoning);
  assert(model.reasoning.levels.includes('high'));
  assert(model.reasoning.levels.includes('off'));
  assert.equal(model.reasoning.source, 'host');
  assert.equal(posts, 0);
  console.log(JSON.stringify({ ok: true, root, models: rows.length, reasoning: model.reasoning, inferenceRequests: posts }));
} finally {
  await backend.close();
  store.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
