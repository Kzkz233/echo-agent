import test from 'node:test';
import assert from 'node:assert/strict';
import { open, writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { Application } from '../apps/server/application.ts';
import { defineManifest, internal } from '../packages/kernel/registry.ts';
import { setup, temporary, until, project } from './helpers.ts';
import { LocalModelPool } from '../packages/kernel/local-model-pool.ts';
import { ZipWriter } from '../packages/kernel/zip-writer.ts';
import { requestStorageMigration, applyStorageMigration } from '../packages/kernel/storage.ts';
import { LibraryDatabase } from '../plugins/files/database.ts';

type Fixture = { calls: number; fail: boolean; block?: Promise<void>; seen: string[] };
async function addParser(app: Application, state: Fixture) {
  app.plugins.add({
    manifest: defineManifest({
      id: 'test-parser',
      name: 'Synthetic source parser',
      description: 'Fixture',
      version: '1.0.0',
      dependencies: ['files'],
      permissions: ['knowledge.parse', 'files.read'],
    }),
    activate(ctx) {
      ctx.capabilities.provide('files.parsers@1', 'test-parser.media', 'Synthetic parser', () => ({
        id: 'test-parser.media',
        label: 'Synthetic parser',
        version: '1',
        contract: 'files.extract@3',
        extensions: ['.av'],
        maxBytes: 8 * 1024 ** 3,
        prepare: 'test-parser.plan',
      }));
      ctx.capabilities.provide(
        'files.prepare-parse@1',
        'test-parser.plan',
        'Freeze fixture options',
        () => ({
          options: { tag: app.store.get('test.tag', 'alpha') },
          provenance: { tag: app.store.get('test.tag', 'alpha') },
        }),
      );
      ctx.capabilities.provide(
        'files.extract@3',
        'test-parser.media',
        'Synthetic parser',
        async (v, signal) => {
          state.calls++;
          if (state.block)
            await Promise.race([
              state.block,
              new Promise((_, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              ),
            ]);
          signal.throwIfAborted();
          if (state.fail) throw Error('Synthetic parse interruption');
          const source = await app.files.original(v.vaultId, v.fileId, v.sourceHash);
        const resolved=await app.registry.call('files.source-object',{vaultId:v.vaultId,fileId:v.fileId,sourceHash:v.sourceHash},
          {kind:'extension',pluginId:'test-parser',permissions:new Set(['files.read'])},signal);
        assert.equal(resolved.hash,source.hash);
        const tag = String(v.plan.options.tag),
          bytes = await readFile(resolved.path);
          state.seen.push(bytes.toString());
          return {
            text: `# ${tag}\n\n${tag} transcript\n\n![figure](frame.png)`,
            assets: [
              {
                name: 'frame.png',
                mimeType: 'image/png',
                data: Buffer.from(tag).toString('base64'),
              },
            ],
            segments: [{ start: 10, end: 20, text: tag + ' transcript' }],
          };
        },
      );
    },
  });
  await app.plugins.enable('test-parser');
}
const done = async (app: Application, id: string, state = 'completed') =>
  until(() => app.store.document<any>('knowledge-jobs', id)?.state === state);
test('archived originals reparse without external files; failed publication keeps current content and manual attachments', async (t) => {
  const app = await setup(t),
    root = await temporary(t),
    state = { calls: 0, fail: false, seen: [] as string[] };
  await addParser(app, state);
  const source = join(root, 'Lecture.av');
  await writeFile(source, 'Original lecture');
  const job = await app.knowledge.queueImport('local', source, 'first');
  await done(app, job.id);
  let doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  const originalVersion = doc.version,
    asset = doc.attachments[0] as any;
  const manual = await app.files.write('local', 'manual.txt', 'User attachment');
  await app.knowledge.attach('local', doc.id, manual.id);
  await unlink(source);
  app.store.set('test.tag', 'beta');
  state.fail = true;
  const failed = await app.knowledge.reparse({
    vaultId: 'local',
    id: doc.id,
    revision: doc.revision,
    requestId: 'reparse',
  });
  await done(app, failed.id, 'failed');
  assert.equal((await app.knowledge.read(doc.id, 0, 12000, 'local')).version, originalVersion);
  state.fail = false;
  await app.registry.call('knowledge.resume', { id: failed.id }, internal);
  await done(app, failed.id);
  doc = await app.knowledge.read(doc.id, 0, 12000, 'local');
  assert.match(doc.content, /beta transcript/);
  assert.equal(doc.attachments.length, 2);
  assert(!doc.attachments.some((a: any) => a.hash === asset.hash));
  assert(doc.attachments.some((a: any) => a.hash === manual.hash));
  const db = await app.files.database('local');
  assert(
    db.db
      .prepare(
        'SELECT 1 FROM entry_revision_attachments WHERE entry_id=? AND revision=1 AND object_hash=?',
      )
      .get(doc.id, asset.hash),
  );
  assert.equal((doc as any).segments[0].start, 10);
  const hit = (
    await app.knowledge.search('beta', new AbortController().signal, 10, { vaultId: 'local' })
  )[0];
  assert.equal(hit.timeRange?.start, 10);
  await app.registry.call(
    'knowledge.restore-revision',
    { vaultId: 'local', id: doc.id, revision: doc.revision, targetRevision: 1, confirmed: true },
    internal,
  );
  const restored = await app.knowledge.read(doc.id, 0, 12000, 'local');
  assert.match(restored.content, /alpha transcript/);
  assert.equal(restored.parsing.provenance.tag, 'alpha');
});
test('duplicate imports coalesce; derived assets are reused; concurrent edits are checked before parsing', async (t) => {
  const app = await setup(t),
    root = await temporary(t);
  let release!: () => void;
  const state: Fixture = {
    calls: 0,
    fail: false,
    seen: [],
    block: new Promise<void>((r) => (release = r)),
  };
  await addParser(app, state);
  const source = join(root, 'Duplicate.av');
  await writeFile(source, 'Identical original');
  const a = await app.knowledge.queueImport('local', source, 'duplicate-a'),
    b = await app.knowledge.queueImport('local', source, 'duplicate-b');
  assert.equal(a.id, b.id);
  release();
  await done(app, a.id);
  assert.equal(state.calls, 1);
  assert.equal((await app.knowledge.queueImport('local', source, 'duplicate-b')).id, a.id);
  let doc = await app.knowledge.read(a.documentId, 0, 12000, 'local');
  const before = (await app.files.records('local')).length;
  const next = await app.knowledge.reparse({
    vaultId: 'local',
    id: doc.id,
    revision: doc.revision,
    requestId: 'repeat',
  });
  await done(app, next.id);
  assert.equal((await app.files.records('local')).length, before);
  doc = await app.knowledge.read(a.documentId, 0, 12000, 'local');
  state.fail = true;
  const failed = await app.knowledge.reparse({
    vaultId: 'local',
    id: doc.id,
    revision: doc.revision,
    requestId: 'conflict',
  });
  await done(app, failed.id, 'failed');
  await app.knowledge.save('local', 'Edited', 'User edit', { id: doc.id, revision: doc.revision });
  state.fail = false;
  const calls = state.calls;
  await app.registry.call('knowledge.resume', { id: failed.id }, internal);
  await done(app, failed.id, 'failed');
  assert.equal(state.calls, calls);
  assert.match((await app.knowledge.read(doc.id, 0, 12000, 'local')).content, /User edit/);
});
test('129 MB archived originals support streamed source inspection and rebinding', async (t) => {
  const app = await setup(t),
    root = await temporary(t),
    source = join(root, 'Large.wav');
  const file = await open(source, 'w');
  await file.truncate(129000001);
  await file.close();
  const original = await app.files.import('local', source);
  const doc = await app.knowledge.save('local', 'Large source', 'Transcript', {
    source,
    sourceHash: original.hash,
    sourceFileId: original.id,
  });
  assert.equal((await app.knowledge.inspectSource('local', doc.id)).state, 'current');
  const rebound = await app.knowledge.rebind({
    vaultId: 'local',
    id: doc.id,
    revision: doc.revision,
    source,
  });
  assert.equal(rebound.revision, doc.revision + 1);
});
test('old captured source version remains readable after its file record has a newer head', async (t) => {
  const app = await setup(t),
    root = await temporary(t),
    state = { calls: 0, fail: true, seen: [] as string[] };
  await addParser(app, state);
  const source = join(root, 'Version.av');
  await writeFile(source, 'Old bytes');
  const job = await app.knowledge.queueImport('local', source, 'version');
  await done(app, job.id, 'failed');
  await writeFile(source, 'New bytes');
  await app.files.import('local', source);
  state.fail = false;
  await app.registry.call('knowledge.resume', { id: job.id }, internal);
  await done(app, job.id);
  assert.deepEqual(state.seen, ['Old bytes']);
  assert.equal(
    (await app.knowledge.read(job.documentId, 0, 12000, 'local')).sourceHash,
    job.original.hash,
  );
});
test('parser catalog does not confuse source-reference PDF parsers with media support and checks connection files', async (t) => {
  const app = await setup(t, ['asr']);
  const parsers = await app.files.parsers.list();
  assert(parsers.find((p) => p.id === 'asr.media')?.extensions.includes('.wav'));
  assert(!parsers.find((p) => p.id === 'documents.local')?.extensions.includes('.wav'));
  await app.router.inference.saveConnection({
    id: 'missing',
    name: 'Missing runtime',
    adapterId: 'asr.llama',
    deployment: 'local',
    purposes: ['transcription'],
    config: { command: join(app.runtime, 'missing.exe') },
  });
  assert.equal(
    (await app.registry.call('connections.test', { id: 'missing' }, internal)).ok,
    false,
  );
  const root = await temporary(t),
    path = join(root, 'Wrong.pdf');
  await writeFile(path, 'Synthetic PDF');
  await assert.rejects(
    app.knowledge.queueImport('local', path, 'wrong', 'asr.media'),
    /格式或大小/,
  );
  await app.plugins.disable('asr');
  assert(!(await app.files.parsers.list()).some((p) => p.id === 'asr.media'));
  const text = join(root, 'Subtitles.vtt');
  await writeFile(text, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello');
  const job = await app.knowledge.queueImport('local', text, 'text-without-asr');
  await done(app, job.id);
});
test('interrupted jobs survive restart and data migration with frozen configuration and no external original', async (t) => {
  let app: Application;
  t.after(() => app?.close());
  const base = await temporary(t),
    sourceRoot = join(base, 'source'),
    target = join(base, 'target');
  await mkdir(sourceRoot);
  app = await Application.create({ project, runtime: sourceRoot, plugins: [] });
  const state = { calls: 0, fail: true, seen: [] as string[] };
  await addParser(app, state);
  const source = join(base, 'External.av');
  await writeFile(source, 'Portable original');
  const job = await app.knowledge.queueImport('local', source, 'migrate');
  await done(app, job.id, 'failed');
  await unlink(source);
  app.store.set('test.tag', 'changed-after-failure');
  app.store.put('personas', 'preserved', { id: 'preserved', prompt: 'Do not change me' });
  await app.close();
  await requestStorageMigration(sourceRoot, target);
  assert.equal(await applyStorageMigration(sourceRoot, sourceRoot), target);
  app = await Application.create({ project, runtime: target, plugins: [] });
  state.fail = false;
  await addParser(app, state);
  await app.registry.call('knowledge.resume', { id: job.id }, internal);
  await done(app, job.id);
  const doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  assert.match(doc.content, /alpha transcript/);
  assert.deepEqual(state.seen, ['Portable original']);
  assert.equal(app.store.document<any>('personas', 'preserved').prompt, 'Do not change me');
  // A committed library generation reconciles an interrupted operational receipt.
  const old = app.store.document<any>('knowledge-jobs', job.id);
  app.store.put('knowledge-jobs', job.id, { ...old, state: 'paused' });
  const calls = state.calls;
  await app.registry.call('knowledge.resume', { id: job.id }, internal);
  await done(app, job.id);
  assert.equal(state.calls, calls);
});
test('portable ZIP64 library retains current provenance and can reparse without source locations', async (t) => {
  let other: Application;
  t.after(() => other?.close());
  const app = await setup(t),
    root = await temporary(t),
    state = { calls: 0, fail: false, seen: [] as string[] };
  await addParser(app, state);
  const source = join(root, 'Portable.av');
  await writeFile(source, 'Portable audio');
  const job = await app.knowledge.queueImport('local', source, 'export');
  await done(app, job.id);
  const path = join(root, 'bundle.zip');
  await app.registry.call(
    'knowledge.export',
    { vaultId: 'local', destination: path, mode: 'bundle' },
    internal,
  );
  const archive = unzipSync(await readFile(path));
  const mounted = join(root, 'mounted');
  await mkdir(mounted);
  for (const [name, bytes] of Object.entries(archive)) {
    if (name === 'manifest.json') continue;
    const full = join(mounted, name);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, bytes);
  }
  other = await setup(t);
  await addParser(other, { calls: 0, fail: false, seen: [] });
  await other.files.register({ id: 'portable', name: 'Portable', path: mounted });
  const doc = await other.knowledge.read(job.documentId, 0, 12000, 'portable');
  assert.equal(doc.source, undefined);
  assert.equal(doc.parsing.provenance.tag, 'alpha');
  const next = await other.knowledge.reparse({
    vaultId: 'portable',
    id: doc.id,
    revision: doc.revision,
    requestId: 'mounted-reparse',
  });
  await done(other, next.id);
  assert.equal((await other.knowledge.read(doc.id, 0, 12000, 'portable')).segments[0].start, 10);
});
test('legacy library upgrade preserves existing content and does not fabricate historical provenance', async (t) => {
  let db: LibraryDatabase;
  t.after(() => db?.close());
  const root = await temporary(t),
    path = join(root, 'library.sqlite');
  db = new LibraryDatabase(path);
  db.db
    .prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      'old',
      'Original',
      'Unchanged',
      'knowledge',
      null,
      null,
      null,
      null,
      'old-version',
      1,
      '2026-01-01',
      '{}',
    );
  db.db
    .prepare('INSERT INTO entry_revisions VALUES(?,?,?,?,?,?,?)')
    .run('old', 1, 'Original', 'Unchanged', '{}', 'old-version', '2026-01-01');
  for (const table of [
    'entry_revision_parsing',
    'parse_generations',
    'entry_revision_attachments',
    'entry_revision_sources',
    'file_versions',
  ])
    db.db.exec('DROP TABLE ' + table);
  db.close();
  db = new LibraryDatabase(path);
  assert.equal(
    (db.db.prepare('SELECT body FROM entries WHERE id=?').get('old') as any).body,
    'Unchanged',
  );
  assert.equal((db.db.prepare('SELECT count(*) n FROM parse_generations').get() as any).n, 0);
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
});
test('shared local residency budget waits for busy inference, evicts idle models and handles failed loading', async () => {
  const pool = new LocalModelPool(() => ({ maxLoadedModels: 1, idleSeconds: 10 })),
    signal = new AbortController().signal;
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let closed = 0,
    secondStarted = false;
  const a = pool.run(
    'embedding',
    'Embedding',
    async () => {
      closed++;
    },
    signal,
    async () => blocked,
  );
  await until(() => pool.status().loaded === 1);
  const b = pool.run(
    'asr',
    'ASR',
    async () => {},
    signal,
    async () => {
      secondStarted = true;
    },
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(secondStarted, false);
  assert.equal(closed, 0);
  release();
  await a;
  await b;
  assert.equal(closed, 1);
  assert.equal(pool.status().loaded, 1);
  await pool.releaseIdle();
  assert.equal(pool.status().loaded, 0);
  await assert.rejects(
    pool.run(
      'bad',
      'Bad',
      async () => {},
      signal,
      async () => {
        throw Error('Load failed');
      },
    ),
    /Load failed/,
  );
  assert.equal(pool.status().loaded, 0);
});
test('streaming ZIP64 archives preserve binary bytes with standard readers', async (t) => {
  const root = await temporary(t),
    path = join(root, 'zip64.zip'),
    zip = await ZipWriter.create(path);
  try {
    await zip.add('attachments/sample.bin', Buffer.from([0, 255, 16, 21]));
    await zip.add('empty', new Uint8Array());
    await zip.finish();
  } finally {
    await zip.close();
  }
  const contents = unzipSync(await readFile(path));
  assert.deepEqual([...contents['attachments/sample.bin']], [0, 255, 16, 21]);
  assert.equal(contents.empty.length, 0);
});
