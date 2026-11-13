import { seedProfile } from '../scripts/inference-fixture.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { inferenceTasks } from '../packages/contracts/inference.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { internal } from '../packages/kernel/registry.ts';
import { InstanceLock } from '../packages/kernel/instance.ts';
import { setup, conversation, FakeBackend, temporary, until } from './helpers.ts';
import { Reviews } from '../plugins/review/index.ts';
import { mkdir } from 'node:fs/promises';

test('an exited local embedding worker falls back promptly and restarts on the next request', async (t) => {
  const app = await setup(t),
    project = join(app.runtime, 'worker-fixture');
  await mkdir(join(project, 'dist'), { recursive: true });
  Object.defineProperty(app.localModels, 'root', { value: project });
  const worker = join(project, 'dist/embedding-worker.mjs');
  await writeFile(
    worker,
    "import {parentPort} from 'node:worker_threads';parentPort.once('message',()=>process.exit(0));",
  );
  await app.plugins.enable('semantic');
  await app.plugins.enable('local-models');
  await app.router.inference.refresh();
  seedProfile(
    app,
    profileSchema.parse({
      id: 'local-test',
      name: 'Local fixture',
      kind: 'onnx',
      model: 'synthetic',
    }),
  );
  app.store.set('routes', {
    ...app.store.get('routes', {}),
    [inferenceTasks.embedding]: 'local-test',
  });
  app.store.set('semantic.config', { threshold: 0.45 });
  await app.memories.save({
    id: 'fixture-memory',
    personaId: 'companion',
    title: 'Tea',
    text: 'Enjoys tea.',
    core: false,
    tags: [],
    sources: [],
  });
  const first = await app.memories.recall('companion', 'tea', [], new AbortController().signal);
  assert(first.every((m) => m.method === 'keyword'));
  assert.match(app.store.get<any>('semantic.lastIssue', {}).message, /退出/);
  await writeFile(
    worker,
    "import {parentPort} from 'node:worker_threads';parentPort.on('message',m=>parentPort.postMessage({id:m.id,vectors:m.texts.map(()=>[1,0])}));",
  );
  const next = await app.memories.recall('companion', 'tea', [], new AbortController().signal);
  assert(next.some((m) => m.method === 'hybrid'));
  assert.equal(app.store.get('semantic.lastIssue', null), null);
});

test('a cancelled turn cannot publish a late successful response or bubble', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  let finish!: (v: any) => void;
  backend.responder = () => new Promise((resolve) => (finish = resolve));
  const controller = new AbortController();
  const task = app.router.send(
    {
      conversationId: c.id,
      text: 'test',
      requestId: 'cancel-late',
      source: 'observation',
      bubble: true,
    },
    controller.signal,
  );
  await until(() => Boolean(finish));
  controller.abort();
  finish({ text: 'stale bubble' });
  assert.equal((await task).state, 'cancelled');
  assert.equal(app.store.allMessages(c.id).filter((m) => m.role === 'assistant').length, 0);
  assert.equal(app.store.receipts().filter((r) => r.kind === 'bubble').length, 0);
});

test('a Review interrupted before its first packet is explicitly resumable', async (t) => {
  const app = await setup(t);
  app.store.put('review-jobs', 'pending-fixture', {
    id: 'pending-fixture',
    key: 'fixture',
    personaId: 'companion',
    state: 'pending',
    materials: [],
    packets: [],
    nextPacket: 0,
    notes: '',
    drafts: [],
    applied: false,
    createdAt: new Date().toISOString(),
  });
  const recovered = new Reviews(
    app.store,
    app.router,
    app.events,
    app.files,
    app.materials,
    app.memories,
  );
  assert.equal(recovered.jobs().find((j) => j.id === 'pending-fixture')!.state, 'paused');
});

test('conversation edits preserve injection and cannot alter task-owned review sources', async (t) => {
  const app = await setup(t),
    c = conversation(app);
  await app.registry.call('conversations.update', { id: c.id, injection: true }, internal);
  await app.registry.call('conversations.update', { id: c.id, review: true }, internal);
  assert.equal(app.store.conversation(c.id)!.injection, true);
  assert.equal(app.store.conversation(c.id)!.review, false);
  assert.deepEqual(app.registry.list(internal).find(op => op.name === 'conversations.update')!.input.parse({ id: c.id, review: true }), { id: c.id });
});
test('durable queued input is accepted once and drains after active generation', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  let finish!: (v: any) => void;
  backend.responder = () => new Promise((resolve) => (finish = resolve));
  const active = app.router.send({ conversationId: c.id, text: 'first', requestId: 'first' });
  await until(() => Boolean(finish));
  const request = { conversationId: c.id, text: 'second', requestId: 'second' };
  app.router.enqueue(request);
  app.router.enqueue(request);
  assert.equal(app.store.receipts().filter((r) => r.kind === 'input').length, 1);
  finish({ text: 'first answer' });
  backend.responder = async () => ({ text: 'second answer' });
  await active;
  await until(() => app.store.run('second')?.state === 'succeeded');
  assert.equal(backend.calls.length, 2);
  assert.equal(app.store.allMessages(c.id).filter((m) => m.text === 'second').length, 1);
});
test('old unresolved runs are fenced beyond the UI history limit', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.transaction(() => {
    for (let i = 0; i < 510; i++)
      app.store.createRun({
        id: 'r-' + i,
        requestId: 'q-' + i,
        conversationId: c.id,
        profileId: 'test',
        epoch: 1,
        state: i === 0 ? 'unknown' : 'succeeded',
        input: 'test',
        source: 'human',
        createdAt: '2026-01-01',
        meta: {},
      });
  });
  assert.equal(app.store.runs().length, 500);
  await assert.rejects(
    app.router.send({ conversationId: c.id, text: 'new', requestId: 'new' }),
    /未知/,
  );
  assert.equal(backend.calls.length, 0);
});
test('a too-large current message is rejected rather than dropped from model input', async (t) => {
  const app = await setup(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  seedProfile(app, {
    ...app.router.profile('test'),
    id: 'small',
    contextChars: 4000,
  });
  await app.router.bind(c.id, 'small', new AbortController().signal);
  await assert.rejects(
    app.router.send({ conversationId: c.id, text: 'a'.repeat(4100), requestId: 'large' }),
    /超过/,
  );
  assert.equal(backend.calls.length, 0);
});
test('only one avatar window can claim and acknowledge a bubble', async (t) => {
  const app = await setup(t);
  app.store.saveReceipt('bubble-one', {
    kind: 'bubble',
    state: 'pending',
    text: 'test',
    conversationId: 'c',
    createdAt: new Date().toISOString(),
  });
  const first = await app.registry.call('avatar.claim', { claimId: 'window-one' }, internal);
  const second = await app.registry.call('avatar.claim', { claimId: 'window-two' }, internal);
  assert.equal(first.id, 'bubble-one');
  assert.equal(second, null);
  await assert.rejects(
    app.registry.call(
      'avatar.ack',
      { id: 'bubble-one', claimId: 'window-two', state: 'shown' },
      internal,
    ),
    /不属于/,
  );
  await app.registry.call(
    'avatar.ack',
    { id: 'bubble-one', claimId: 'window-one', state: 'shown' },
    internal,
  );
  assert.equal(app.store.receipt('bubble-one')!.state, 'shown');
});
test('instance lock prevents concurrent writers and releases explicitly', async (t) => {
  const root = await temporary(t);
  const lock = InstanceLock.acquire(root);
  assert.throws(() => InstanceLock.acquire(root), /已有 Echo/);
  lock.release();
  const second = InstanceLock.acquire(root);
  second.release();
});
test('disabling observation leaves ordinary Review active', async (t) => {
  const app = await setup(t);
  await app.plugins.disable('observation');
  assert(app.plugins.active.has('review'));
  assert.equal(app.materials.entries.has('observation.source'), false);
  assert.equal(app.observations.status().allowed, false);
});
test('archived old raw data is kept until Review consumed it and late additions preserve old archive', async (t) => {
  const app = await setup(t);
  const timestamp = new Date(Date.now() - 12 * 86400000).toISOString();
  const row = {
    id: 'old-one',
    personaId: 'companion',
    conversationId: 'c',
    timestamp,
    frameTimes: [],
    sources: ['fixture'],
    summary: 'old raw text',
    interesting: false,
  };
  const today = new Date().toISOString().slice(0, 10);
  await app.observations.record(row);
  await app.observations.archiveBefore(today);
  assert((await app.observations.allRaw()).some((o) => o.id === row.id));
  app.store.set('review.sourceWatermark.observation.source.companion', { timestamp, id: row.id });
  await app.observations.archiveBefore(today);
  assert.equal((await app.observations.allRaw()).length, 0);
  const later = { ...row, id: 'old-two', summary: 'late raw text' };
  await app.observations.record(later);
  const changed = await app.observations.archiveBefore(today);
  assert.equal(changed.length, 1);
  const document = await app.knowledge.read(changed[0].id);
  assert(document.content.includes('old-one'));
  assert(document.content.includes('old-two'));
});
