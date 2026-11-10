import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  parseReviewOutput,
  reviewRepairSchema,
  reviewValidationVersion,
  recoverLegacyReviewReferences,
} from '../plugins/review/output.ts';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { memoryChange } from '../plugins/memory/changes.ts';
import { createHash } from 'node:crypto';

const context = { sources: ['evidence-one'], targets: [{ id: 'fixture.state' }] };
const output = (target = 'fixture.state', source = 'evidence-one') => ({
  notes: 'Retained notes',
  memories: [],
  actions: [
    {
      target,
      title: 'An interest',
      text: 'A supported update',
      sources: [source],
      operation: 'update',
      subjectId: 'record-one',
      expectedVersion: 1,
    },
  ],
});

test('Review requires explicit mutation targets and recovers only unambiguous legacy content hashes', () => {
  const version = 'a'.repeat(64),
    snapshot = [{ id: 'existing', version }];
  const draft = {
    operation: 'update' as const,
    title: 'Title',
    text: 'Revised fact',
    sources: ['evidence-one'],
    expectedVersion: version,
  };
  assert.throws(
    () =>
      parseReviewOutput(JSON.stringify({ notes: '', memories: [draft], actions: [] }), {
        ...context,
        memoryOperations: ['update'],
        memorySnapshot: snapshot,
      }),
    (error: any) => error.code === 'review_memory_shape',
  );
  const recovered = recoverLegacyReviewReferences([draft], snapshot);
  assert.equal(recovered.drafts[0].subjectId, 'existing');
  assert.equal(recovered.repairs.length, 1);
  assert.equal(draft.hasOwnProperty('subjectId'), false);
  assert.throws(
    () => recoverLegacyReviewReferences([draft], [...snapshot, { id: 'duplicate', version }]),
    /唯一/,
  );
  assert.throws(
    () => recoverLegacyReviewReferences([{ ...draft, expectedVersion: 'short' }], snapshot),
    /唯一/,
  );
});

test('memory batches reconstruct prior committed revisions and reject external edits', async (t) => {
  const app = await setup(t);
  const original = await app.memories.save({
    personaId: 'companion',
    title: 'Fact',
    text: 'Original',
    core: false,
    tags: [],
    sources: [],
  });
  const change = (text: string) =>
    memoryChange.parse({
      operation: 'update',
      subjectId: original.id,
      expectedVersion: original.version,
      title: 'Fact',
      text,
      sources: ['evidence'],
    });
  const entries = ['First', 'Second'].map((text, index) => ({
    change: change(text),
    requestId: 'batch-' + index,
  }));
  await app.memories.change('companion', entries[0].change, entries[0].requestId);
  await app.memories.changeBatch('companion', entries);
  const final = app.store.document<any>('memories', original.id);
  assert.equal(final.text, 'Second');
  await app.memories.changeBatch('companion', entries);
  assert.deepEqual(app.store.document('memories', original.id), final);
  await app.memories.save({ ...final, text: 'External edit' });
  await assert.rejects(
    app.memories.changeBatch('companion', [
      ...entries,
      { change: change('Third'), requestId: 'batch-2' },
    ]),
    /已变化/,
  );
  assert.equal(app.store.document<any>('memories', original.id).text, 'External edit');
  assert.equal(app.store.document('memory-changes', 'batch-2'), undefined);
});

test('Review resumes legacy partially applied updates without rereading packets or duplicating changes', async (t) => {
  const app = await setup(t),
    chat = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const original = await app.memories.save({
    personaId: 'companion',
    title: 'Fact',
    text: 'Original',
    core: false,
    tags: [],
    sources: [],
  });
  const source = app.store.append(chat.id, 'user', 'human', 'Synthetic evidence');
  app.reviews.saveTask('maintenance', {
    ...app.reviews.policy('companion'),
    memoryOperations: ['update'],
    autoApply: true,
  });
  backend.responder = async () => {
    throw Error('Synthetic checkpoint');
  };
  const job = await app.reviews.start(
    'companion',
    'legacy-apply',
    undefined,
    app.reviews.tasks()[0],
  );
  await until(() => app.reviews.jobs().find((row) => row.id === job.id)?.state === 'paused');
  const paused = app.reviews.jobs().find((row) => row.id === job.id)!;
  const draft = (text: string) =>
    memoryChange.parse({
      operation: 'update',
      subjectId: original.id,
      expectedVersion: original.version,
      title: 'Fact',
      text,
      sources: [source.id],
    });
  const drafts = [draft('First'), draft('Second'), { ...draft('Third'), subjectId: undefined }];
  const requestId =
    'review-' +
    job.id +
    '-' +
    createHash('sha256')
      .update(JSON.stringify(memoryChange.parse(drafts[0])))
      .digest('hex')
      .slice(0, 24);
  await app.memories.change('companion', drafts[0], requestId);
  app.store.put('review-jobs', job.id, { ...paused, drafts, nextPacket: paused.packets.length });
  const calls = backend.calls.length;
  await app.reviews.execute(job.id);
  const complete = app.reviews.jobs().find((row) => row.id === job.id)!;
  assert.equal(complete.state, 'completed', complete.error ?? 'Review should complete');
  assert(complete.applied);
  assert.equal(backend.calls.length, calls);
  assert.equal(complete.draftRepairs?.length, 1);
  assert.equal(app.store.document<any>('memories', original.id).text, 'Third');
  assert.equal(app.store.documents('memory-changes').length, 3);
  assert.deepEqual(complete.materials, paused.materials);
  assert.deepEqual(complete.packets, paused.packets);
  await app.reviews.apply(complete);
  assert.equal(app.store.documents('memory-changes').length, 3);
});

test('Review distinguishes target identity from evidence and constrains repair to the frozen packet', () => {
  assert.throws(
    () => parseReviewOutput(JSON.stringify(output('record-one')), context),
    (error: any) => {
      assert.equal(error.code, 'review_target');
      assert.match(error.message, /fixture.state/);
      assert.match(error.message, /subjectId/);
      return true;
    },
  );
  assert.throws(
    () => parseReviewOutput(JSON.stringify(output('fixture.state', 'invented')), context),
    (error: any) => error.code === 'review_sources',
  );
  assert.throws(
    () => parseReviewOutput(JSON.stringify(output('fixture.state', '')), context),
    (error: any) => error.code === 'review_sources',
  );
  assert.equal(
    parseReviewOutput(JSON.stringify(output()), context).actions[0].subjectId,
    'record-one',
  );
  const schema = reviewRepairSchema(context);
  assert(schema.safeParse(output()).success);
  assert(!schema.safeParse(output('record-one')).success);
  assert(!schema.safeParse(output('fixture.state', 'invented')).success);
  const json = z.toJSONSchema(schema) as any;
  assert.deepEqual(json.properties.actions.items.properties.target.enum, ['fixture.state']);
  assert(!reviewRepairSchema({ ...context, targets: [] }).safeParse(output()).success);
  assert(
    reviewRepairSchema({ sources: [], targets: [], memoryOperations: [] }).safeParse({
      notes: '',
      memories: [],
      actions: [],
    }).success,
  );
});

test('Review retries invalid repairs within a bounded budget and never resets that budget on resume', async (t) => {
  const app = await setup(t),
    chat = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(chat.id, 'user', 'human', 'Synthetic packet');
  backend.responder = async () => ({ text: '{"notes":"retained","memories":[],"actions":[{}]}' });
  const job = await app.reviews.start('companion', 'bounded-repair');
  await until(() => app.reviews.jobs().find((row) => row.id === job.id)?.state === 'paused');
  assert.equal(backend.calls.length, 3);
  let paused = app.reviews.jobs().find((row) => row.id === job.id)!;
  assert.equal(paused.pending?.repairs, 2);
  assert.equal(paused.pending?.validationVersion, reviewValidationVersion);
  assert.equal(paused.nextPacket, 0);
  await app.reviews.execute(job.id);
  assert.equal(backend.calls.length, 3);
  paused = app.reviews.jobs().find((row) => row.id === job.id)!;
  assert.equal(paused.state, 'paused');
  assert.equal(app.store.documents('memories').length, 0);
});

test('Review upgrades a legacy exhausted repair checkpoint without rereading completed packets', async (t) => {
  const app = await setup(t),
    chat = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(chat.id, 'user', 'human', 'S'.repeat(18000));
  let calls = 0;
  backend.responder = async () => {
    if (++calls === 2) throw Error('Synthetic transport stop');
    return { text: '{"notes":"completed checkpoint","memories":[]}' };
  };
  const job = await app.reviews.start('companion', 'legacy-checkpoint');
  await until(() => app.reviews.jobs().find((row) => row.id === job.id)?.state === 'paused');
  const paused = app.reviews.jobs().find((row) => row.id === job.id)!;
  assert.equal(paused.nextPacket, 1);
  const invalid = JSON.stringify(output('record-one', paused.packets[1].sources[0]));
  app.store.put('review-jobs', job.id, {
    ...paused,
    targets: [{ id: 'fixture.state', context: '', instructions: '' }],
    pending: { packetIndex: 1, text: invalid, repairs: 2 },
  });
  let repairs = 0,
    reads = 0;
  backend.responder = async (request) => {
    if (request.messages[0].text.includes('修复')) {
      const payload = JSON.parse(request.messages[1].text);
      assert.deepEqual(payload.allowedTargetIds, ['fixture.state']);
      assert.match(payload.issue, /target/);
      return {
        text: ++repairs === 1 ? invalid : '{"notes":"repaired notes","memories":[],"actions":[]}',
      };
    }
    reads++;
    return { text: '{"notes":"completed","memories":[],"actions":[]}' };
  };
  await app.reviews.execute(job.id);
  const complete = app.reviews.jobs().find((row) => row.id === job.id)!;
  assert.equal(complete.state, 'completed');
  assert.equal(repairs, 2);
  assert.equal(reads, paused.packets.length - 2);
  assert.deepEqual(complete.materials, paused.materials);
  assert.deepEqual(complete.packets, paused.packets);
  assert.equal(complete.nextPacket, paused.packets.length);
});

test('Review recovers a nonempty candidate after an old empty repair and applies a job-local output budget', async (t) => {
  const app = await setup(t),
    chat = conversation(app, { review: true }),
    backend = new FakeBackend();
  const tasksBefore = app.reviews.tasks();
  app.router.backends.set('api', backend);
  app.store.append(chat.id, 'user', 'human', 'Synthetic input');
  backend.responder = async () => ({
    text: '{"notes":"known notes","memories":[],"actions":[{}]}',
  });
  const job = await app.reviews.start('companion', 'empty-repair');
  await until(() => app.reviews.jobs().find((row) => row.id === job.id)?.state === 'paused');
  const paused = app.reviews.jobs().find((row) => row.id === job.id)!;
  app.store.put('review-jobs', job.id, { ...paused, pending: { ...paused.pending!, text: '' } });
  backend.responder = async (request) => {
    assert.equal(request.profile.maxOutputTokens, 8192);
    assert.equal(app.router.profile('test').maxOutputTokens, 2048);
    assert.match(JSON.parse(request.messages[1].text).previousResult, /known notes/);
    return { text: '{"notes":"known notes","memories":[],"actions":[]}' };
  };
  await app.registry.call(
    'review.resume',
    { id: job.id, confirmed: true, maxOutputTokens: 8192 },
    internal,
  );
  await until(() => app.reviews.jobs().find((row) => row.id === job.id)?.state === 'completed');
  const complete = app.reviews.jobs().find((row) => row.id === job.id)!;
  assert.equal(complete.policy?.maxOutputTokens, 8192);
  assert.deepEqual(complete.materials, paused.materials);
  assert.equal(complete.notes, 'known notes');
  assert.deepEqual(app.reviews.tasks(), tasksBefore);
});
