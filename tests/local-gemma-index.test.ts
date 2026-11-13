import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, until } from './helpers.ts';
import { openPortableIndex } from '../plugins/semantic/portable-index.ts';
import { listenBrowserHttp } from '../packages/kernel/http-listener.ts';
test('GGUF artifacts define the vector space; device, residency and file relocation do not', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('local-models');
  await app.router.inference.refresh();
  const c = app.router.inference,
    file = join(app.runtime, 'a.gguf'),
    relocated = join(app.runtime, 'b.gguf');
  await writeFile(file, 'GGUF synthetic weights');
  await c.saveConnection({
    id: 'gguf',
    name: 'GGUF',
    adapterId: 'local-models.gguf',
    deployment: 'local',
    config: { command: process.execPath },
  });
  const m = await c.saveModel({
    id: 'gemma',
    name: 'Gemma',
    connectionId: 'gguf',
    model: file,
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'], dimensions: 768 },
    options: {},
  });
  const before = c.fingerprint(m.id);
  assert.match(m.options.modelSha256 as string, /^[a-f0-9]{64}$/);
  assert(!c.adapter('local-models.gguf').modelFields.some((f) => /quant|dtype/i.test(f.key)));
  await copyFile(file, relocated);
  await c.saveModel({
    ...m,
    model: relocated,
    options: { ...m.options, threads: 3, device: 'gpu', keepLoaded: true },
  });
  assert.equal(c.fingerprint(m.id), before);
  await writeFile(relocated, 'GGUF different weights');
  await c.saveModel({ ...m, model: relocated });
  assert.notEqual(c.fingerprint(m.id), before);
  await assert.rejects(c.saveModel({ ...m, options: { dtype: 'q8' } }));
});
test('owned llama.cpp process formats query/document inputs and is killed on plugin unload', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('local-models');
  await app.router.inference.refresh();
  const file = join(app.runtime, 'a.gguf'),
    script = join(app.runtime, 'fake-llama.mjs'),
    log = join(app.runtime, 'wire.jsonl'),
    pidFile = join(app.runtime, 'pid');
  await writeFile(file, 'GGUF fake test');
  await writeFile(
    script,
    `import http from'node:http';import fs from'node:fs';const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));http.createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+get('--api-key')){res.writeHead(401).end();return;}res.setHeader('Content-Type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:get('--alias')}]}));return;}let body='';for await(const part of req)body+=part;const m=JSON.parse(body);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');res.end(JSON.stringify({data:[{index:0,embedding:[3,4]}]}));}).listen(Number(get('--port')),'127.0.0.1');`,
  );
  await app.router.inference.saveConnection({
    id: 'gguf',
    name: 'GGUF',
    adapterId: 'local-models.gguf',
    deployment: 'local',
    config: { command: process.execPath, args: [script] },
  });
  await app.router.inference.saveModel({
    id: 'gemma',
    name: 'Gemma',
    connectionId: 'gguf',
    model: file,
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'], dimensions: 2 },
    options: { keepLoaded: true },
  });
  for (const purpose of ['query', 'document'] as const)
    assert.deepEqual(
      await app.embeddings.encode(
        'gemma',
        [{ content: [{ type: 'text', text: 'hello' }] }],
        purpose,
        new AbortController().signal,
      ),
      [[0.6, 0.8]],
    );
  const rows = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.equal(rows[0].input[0], 'task: search result | query: hello');
  assert.equal(rows[1].input[0], 'title: none | text: hello');
  const pid = Number(await readFile(pidFile, 'utf8'));
  await app.localModels.close();
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(app.localModels.status().loaded, 0);
});
test('GGUF audio/video parts use native media inputs, sample at 1 fps and keep text/image space identity', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('local-models');
  await app.router.inference.refresh();
  const file = join(app.runtime, 'model.gguf'),
    projector = join(app.runtime, 'projector.gguf'),
    script = join(app.runtime, 'media.mjs'),
    log = join(app.runtime, 'media.jsonl');
  await writeFile(file, 'GGUF text model');
  await writeFile(projector, 'GGUF media encoders');
  await writeFile(
    script,
    `import http from'node:http';import fs from'node:fs';const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args:a})+'\\n');http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:get('--alias')}]}));return;}let b='';for await(const p of req)b+=p;const v=JSON.parse(b);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(v)+'\\n');res.end(JSON.stringify({data:[{index:0,embedding:[1,0]}]}));}).listen(Number(get('--port')),'127.0.0.1');`,
  );
  const c = app.router.inference;
  await c.saveConnection({
    id: 'media',
    name: 'Media',
    adapterId: 'local-models.gguf',
    deployment: 'local',
    config: { command: process.execPath, args: [script] },
  });
  const m = await c.saveModel({
      id: 'media',
      name: 'Media',
      connectionId: 'media',
      model: file,
      generation: { enabled: false, inputs: ['text'] },
      embedding: { enabled: true, inputs: ['text', 'image'], dimensions: 2 },
      options: { projector },
    }),
    space = c.fingerprint(m.id);
  await c.saveModel({
    ...m,
    embedding: { ...m.embedding, inputs: ['text', 'image', 'audio', 'video'] },
  });
  assert.equal(c.fingerprint(m.id), space, 'enabling modalities is not a new weight space');
  const vectors = await app.embeddings.encode(
    'media',
    [
      { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'YQ==' }] },
      { content: [{ type: 'video', mimeType: 'video/mp4', data: 'Yg==' }] },
    ],
    'document',
    new AbortController().signal,
  );
  assert.deepEqual(vectors, [
    [1, 0],
    [1, 0],
  ]);
  await assert.rejects(
    app.embeddings.encode(
      'media',
      [{ content: [{ type: 'audio', mimeType: 'audio/wav', data: 'http://localhost/private' }] }],
      'document',
      new AbortController().signal,
    ),
    /Base64/,
  );
  const rows = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(rows[0].args[rows[0].args.indexOf('--video-fps') + 1], '1');
  assert.equal(rows[1].input[0].content[0].type, 'input_audio');
  assert.equal(rows[2].input[0].content[0].type, 'input_video');
  await assert.rejects(
    app.embeddings.encode(
      'media',
      [{ content: [{ type: 'audio', mimeType: 'audio/unsupported', data: 'YQ==' }] }],
      'document',
      new AbortController().signal,
    ),
    /媒体格式/,
  );
});
test('migrated structural vectors return original evidence, respect filters and reject stale content without rebuilding', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  await app.plugins.enable('embeddings');
  const { createServer } = await import('node:http'),
    server = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    });
  await listenBrowserHttp(server);
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  await app.router.inference.saveConnection({
    id: 'emb',
    name: 'Emb',
    adapterId: 'core.api',
    deployment: 'local',
    config: { endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` },
  });
  await app.router.inference.saveModel({
    id: 'emb',
    name: 'Emb',
    connectionId: 'emb',
    model: 'test',
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'], dimensions: 2 },
  });
  app.store.set('routes', { 'embeddings.encode': 'emb' });
  const a = await app.knowledge.save('local', 'A', 'A long document', { path: 'scope/A.md' }),
    b = await app.knowledge.save('local', 'B', 'Another document', { path: 'elsewhere/B.md' });
  const records = await app.knowledge.records({ vaultId: 'local' }),
    status = await app.semantic.indexStatus({ vaultId: 'local' }),
    db = openPortableIndex(app.semantic.portableIndexPath);
  try {
    db.prepare('INSERT INTO spaces VALUES(?,?,?)').run('original-pinned-space', 2, 'synthetic');
    db.prepare('INSERT INTO space_aliases VALUES(?,?)').run(
      status.fingerprint,
      'original-pinned-space',
    );
    for (const d of [a, b]) {
      const r = records.find((r) => r.documentId === d.id)!;
      db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(
        'original-pinned-space',
        'local',
        d.id,
        r.bodyHash!,
      );
      db.prepare('INSERT INTO vectors VALUES(?,?,?,?,?,?,?,?,?)').run(
        'original-pinned-space',
        'local',
        d.id,
        d.id + 'node',
        'text',
        'parent',
        'Original structural evidence ' + d.title,
        Buffer.from(new Float32Array([1, 0]).buffer),
        '{}',
      );
    }
  } finally {
    db.close();
  }
  assert.equal((await app.semantic.indexStatus({ vaultId: 'local' })).missing, 0);
  const hits = await app.knowledge.search('unrelated', new AbortController().signal, 10, {
    vaultId: 'local',
    folder: 'scope',
    strategy: 'semantic',
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].documentId, a.id);
  assert.equal(hits[0].text, 'Original structural evidence A');
  assert.equal(hits[0].node?.parentId, 'parent');
  const job = await app.semantic.startIndex(
    { vaultId: 'local' },
    'no-rebuild',
    new AbortController().signal,
  );
  assert.equal(job.total, 0);
  await app.knowledge.save('local', 'A', 'Changed content', { id: a.id });
  assert.equal((await app.semantic.indexStatus({ vaultId: 'local' })).missing, 1);
  await assert.rejects(
    app.knowledge.search('unrelated', new AbortController().signal, 10, {
      vaultId: 'local',
      folder: 'scope',
      strategy: 'semantic',
    }),
  );
});
