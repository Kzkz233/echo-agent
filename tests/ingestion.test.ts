import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, until } from './helpers.ts';
import { ingestionPolicy } from '../packages/contracts/ingestion.ts';
import { evidenceGraph } from '../plugins/knowledge/graph.ts';
import { internal } from '../packages/kernel/registry.ts';
import { createHash } from 'node:crypto';
import { openPortableIndex } from '../plugins/semantic/portable-index.ts';

test('unaccepted transcript words cannot leak into media evidence and assessment changes invalidate graph identity', async t => {
  const nodes = evidenceGraph({ id: 'review', title: 'Video', content: '', sourceHash: 'b'.repeat(64), original: { mediaType: 'video/mp4' },
    assessment: { state: 'needs_review' }, segments: [{ start: 0, end: 5, text: 'Suspect words', assessment: { state: 'needs_review' } }] }, ingestionPolicy.parse({}), 5);
  assert(!JSON.stringify(nodes).includes('Suspect words'));
  assert.equal(nodes.filter(n => n.kind === 'text').length, 0);
  assert.equal(nodes.filter(n => ['audio','video'].includes(n.kind)).length, 2);
  const app = await setup(t), parser = (await app.files.parsers.list()).find(p => p.id === 'files.text')!;
  const plan = { format: 'echo-parse-plan-v1' as const, parser, options: {}, provenance: {} };
  const first = await app.knowledge.save('local', 'Same body', '', { parsed: { jobId: 'parse-one', plan, segments: [], assessment: { state: 'empty', reason: 'no_speech' } } });
  const second = await app.knowledge.save('local', 'Same body', '', { id: first.id, revision: first.revision, parsed: { jobId: 'parse-two', plan, segments: [], assessment: { state: 'needs_review' } } });
  assert.notEqual(first.version, second.version);
  const restored = await app.registry.call('knowledge.restore-revision', { vaultId: 'local', id: first.id, revision: second.revision, targetRevision: first.revision, confirmed: true }, internal);
  assert.equal((await app.knowledge.read(restored.id, 0, 100, 'local')).assessment.state, 'empty');
});

test('normalization shares media parents and preserves source coordinates without rewriting Markdown', () => {
  const doc = {
    id: 'one',
    title: 'Speech',
    content: '# Speech\n\nhello world',
    sourceHash: 'a'.repeat(64),
    original: { mediaType: 'video/mp4' },
    segments: [{ start: 0, end: 5, text: 'hello world' }],
  };
  const nodes = evidenceGraph(doc, ingestionPolicy.parse({}), 35);
  const text = nodes.find((n) => n.kind === 'text')!,
    audio = nodes.find((n) => n.kind === 'audio')!,
    video = nodes.find((n) => n.kind === 'video')!;
  assert.equal(text.parentId, audio.parentId);
  assert.equal(video.parentId, audio.parentId);
  assert.equal(doc.content, '# Speech\n\nhello world');
  assert.equal(nodes.filter((n) => n.kind === 'video').length, 2);
  assert.notEqual(
    text.id,
    evidenceGraph({ ...doc, id: 'two' }, ingestionPolicy.parse({}), 35).find(
      (n) => n.kind === 'text',
    )!.id,
  );
});

test('parser page coordinates share a parent across text and images; silent video excludes audio', () => {
  const hash = 'a'.repeat(64),
    content = `Page one\n\n![diagram](echo-asset:${hash})\n\nPage two`;
  const nodes = evidenceGraph(
    {
      id: 'pages',
      title: 'Pages',
      content,
      blocks: [
        { type: 'text', text: 'Page one', page: 1 },
        { type: 'image', asset: 'echo-asset:' + hash, page: 1 },
        { type: 'text', text: 'Page two', page: 2 },
      ],
    },
    ingestionPolicy.parse({}),
  );
  const image = nodes.find((n) => n.kind === 'image')!,
    text = nodes.find((n) => n.kind === 'text' && n.text === 'Page one')!;
  assert.equal(image.parentId, text.parentId);
  assert.equal(image.page, 1);
  assert.equal(nodes.find((n) => n.id === text.parentId)!.page, 1);
  const silent = evidenceGraph(
    {
      id: 'silent',
      title: 'Silent',
      content: '',
      original: { mediaType: 'video/mp4' },
      sourceHash: hash,
    },
    ingestionPolicy.parse({}),
    65,
    false,
  );
  assert.equal(silent.filter((n) => n.kind === 'video').length, 3);
  assert.equal(silent.filter((n) => n.kind === 'audio').length, 0);
});

test('default import, graph reuse, staged model switching and rollback keep existing content and query identity', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  const vault = await app.files.register({
    id: 'fixture',
    name: 'Fixture',
    path: join(app.runtime, 'Fixture'),
  });
  const source = join(app.runtime, 'example.md');
  await writeFile(source, '# Fixture\n\nUnique evidence about sound.');
  const job = await app.knowledge.queueImport(vault.id, source, 'import-fixture');
  await app.knowledge.waitImport(job.id, new AbortController().signal);
  assert.equal(app.store.document<any>('knowledge-jobs', job.id)?.state, 'completed');
  const before = await app.knowledge.read(job.documentId, 0, 1000, vault.id);
  let calls = 0;
  app.embeddings.encode = async (_model, inputs) => {
    calls += inputs.length;
    return inputs.map(() => [1, 0, 0]);
  };
  const model = app.store.document<any>('profiles', 'test');
  app.store.put('profiles', model.id, {
    ...model,
    embedding: { ...model.embedding, dimensions: 3 },
  });
  const graph = await app.knowledge.pipeline.graph(vault.id, job.documentId);
  assert.equal(graph.reused, false);
  assert.equal((await app.knowledge.pipeline.graph(vault.id, job.documentId)).reused, true);
  const plan = await app.semantic.generations!.plan({ vaultIds: [vault.id] });
  assert.equal(plan.reuseParsing, 1);
  assert.equal(plan.reparse, 0);
  await app.semantic.generations!.start(plan.id, 'migration-fixture');
  await until(
    () =>
      app.store.document<any>('knowledge-migrations', 'migration-fixture')?.state !== 'running' &&
      app.store.document<any>('knowledge-migrations', 'migration-fixture')?.state !== 'queued',
  );
  const finished = app.store.document<any>('knowledge-migrations', 'migration-fixture');
  assert.equal(finished.state, 'completed', finished.error);
  assert(calls > 0);
  assert.deepEqual(await app.knowledge.read(job.documentId, 0, 1000, vault.id), before);
  const hits = await app.knowledge.search('sound', new AbortController().signal, 3, {
    vaultId: vault.id,
    strategy: 'semantic',
  });
  assert(hits[0].node?.parentId);
  assert.match(hits[0].text, /Unique evidence/);
  const opened = await app.registry.call(
    'knowledge.read',
    {
      id: hits[0].id,
      vaultId: vault.id,
      nodeId: hits[0].node!.id,
      graphPolicy: hits[0].node!.graphPolicy,
    },
    internal,
  );
  assert.equal(opened.evidence.node.id, hits[0].node!.id);
  await app.registry.call('semantic.migration.rollback', { id: finished.id }, internal);
  assert.equal(Object.keys(app.semantic.generations!.bindings()).length, 0);
  const jobs = await app.jobs.list();
  assert(jobs.some((j) => j.id === 'semantic.migrations/migration-fixture'));
});

test('failed or stale migration keeps the old index binding; retry reuses saved vectors', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  const vault = await app.files.register({
    id: 'fixture',
    name: 'Fixture',
    path: join(app.runtime, 'Fixture'),
  });
  await app.knowledge.save(vault.id, 'Document', 'A'.repeat(2800), { id: 'entry' });
  const profile = app.store.document<any>('profiles', 'test');
  app.store.put('profiles', profile.id, {
    ...profile,
    embedding: { ...profile.embedding, dimensions: 2 },
  });
  let n = 0;
  app.embeddings.encode = async () => {
    if (++n === 2) throw Error('synthetic upstream');
    return [[1, 0]];
  };
  const plan = await app.semantic.generations!.plan({ vaultIds: [vault.id] });
  await app.semantic.generations!.start(plan.id, 'fail-fixture');
  await until(
    () => app.store.document<any>('knowledge-migrations', 'fail-fixture')?.state === 'failed',
  );
  assert.deepEqual(app.semantic.generations!.bindings(), {});
  await app.plugins.disable('semantic');
  await app.plugins.enable('semantic');
  let resumed = 0;
  app.embeddings.encode = async () => {
    resumed++;
    return [[1, 0]];
  };
  await app.registry.call('semantic.migration.resume', { id: 'fail-fixture' }, internal);
  await until(
    () => app.store.document<any>('knowledge-migrations', 'fail-fixture')?.state === 'completed',
  );
  assert.equal(resumed, 2);
  assert.equal(app.store.document<any>('knowledge-migrations', 'fail-fixture').vectors, 3);
});

test('stale content cannot replace an active index', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  const vault = await app.files.register({
    id: 'fixture',
    name: 'Fixture',
    path: join(app.runtime, 'Fixture'),
  });
  await app.knowledge.save(vault.id, 'Document', 'Saved content', { id: 'entry' });
  app.embeddings.encode = async () => [[1, 0]];
  const profile = app.store.document<any>('profiles', 'test');
  app.store.put('profiles', profile.id, {
    ...profile,
    embedding: { ...profile.embedding, dimensions: 2 },
  });
  const first = await app.semantic.generations!.plan({ vaultIds: [vault.id] });
  await app.semantic.generations!.start(first.id, 'baseline');
  await until(
    () => app.store.document<any>('knowledge-migrations', 'baseline')?.state === 'completed',
  );
  const bindings = app.semantic.generations!.bindings();
  const stale = await app.semantic.generations!.plan({ vaultIds: [vault.id] });
  const doc = await app.files.entries.find('entry', vault.id);
  await app.knowledge.save(vault.id, 'Document', 'Changed by user', {
    id: doc.id,
    revision: doc.revision,
  });
  await app.semantic.generations!.start(stale.id, 'stale');
  await until(() => app.store.document<any>('knowledge-migrations', 'stale')?.state === 'failed');
  assert.deepEqual(app.semantic.generations!.bindings(), bindings);
  assert.equal((await app.knowledge.read('entry', 0, 100, vault.id)).content, 'Changed by user');
});

test('portable structural evidence opens the saved passage without re-embedding legacy vectors', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  const vault = await app.files.register({
    id: 'fixture',
    name: 'Fixture',
    path: join(app.runtime, 'Fixture'),
  });
  const content = 'Before\n\nThe matching paragraph\n\nAfter';
  await app.knowledge.save(vault.id, 'Document', content, { id: 'entry' });
  const db = openPortableIndex(app.semantic.portableIndexPath),
    logical = (app.semantic as any).fingerprint('knowledge');
  db.prepare('INSERT INTO spaces VALUES(?,?,?)').run('old-physical-space', 2, '{}');
  db.prepare('INSERT INTO space_aliases VALUES(?,?)').run(logical, 'old-physical-space');
  db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(
    'old-physical-space',
    vault.id,
    'entry',
    createHash('sha256').update(content).digest('hex'),
  );
  for (const [id, parent, text] of [
    ['parent', null, content],
    ['leaf', 'parent', 'The matching paragraph'],
  ] as const)
    db.prepare('INSERT INTO vectors VALUES(?,?,?,?,?,?,?,?,?)').run(
      'old-physical-space',
      vault.id,
      'entry',
      id,
      'text',
      parent,
      text,
      Buffer.from(new Float32Array([1, 0]).buffer),
      '{}',
    );
  db.close();
  app.embeddings.encode = async () => {
    throw Error('Must not re-embed');
  };
  const read = await app.registry.call(
    'knowledge.read',
    { id: 'entry', vaultId: vault.id, nodeId: 'leaf', limit: 100 },
    internal,
  );
  assert.equal(read.evidence.parent.id, 'parent');
  assert.equal(read.offset, content.indexOf('The matching paragraph'));
  assert.match(read.content, /^The matching paragraph/);
});
