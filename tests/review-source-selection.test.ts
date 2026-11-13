import test from 'node:test';
import assert from 'node:assert/strict';
import { internal } from '../packages/kernel/registry.ts';
import { setup, conversation } from './helpers.ts';

test('legacy marked and omitted scopes freeze the same role-owned conversations without altering other settings or cursors', async t => {
  const app = await setup(t);
  const first = conversation(app, { review: true });
  conversation(app, { review: true });
  const other = conversation(app, { personaId: 'other', review: true });
  const ignored = conversation(app);
  const original = { id: 'legacy', personaId: first.personaId, enabled: false, conversationScope: 'marked',
    conversationIds: [ignored.id], sourceIds: ['mail.source'], sourceStreams: { 'mail.source': ['mailbox'] },
    sourcePrompts: { 'mail.source': 'KEEP_SOURCE_GUIDANCE' }, prompt: 'KEEP_TASK_GUIDANCE',
    memoryOperations: ['add'], reasoning: 'high', report: false };
  app.store.set('review.tasks', [original, { id: 'omitted', personaId: 'other', enabled: false }]);
  const cursor = 'review.taskConversation.' + JSON.stringify(['legacy', first.id]);
  app.store.set(cursor, 17);
  const frozen = { id: 'frozen', personaId: first.personaId, state: 'paused', policy: original,
    materials: [{ id: 'frozen-evidence', text: 'KEEP_FROZEN_INPUT' }], nextPacket: 1 };
  app.store.put('review-jobs', frozen.id, frozen);
  const before = app.store.conversations();
  const expectedIds = before.filter(c => c.personaId === first.personaId && c.review).map(c => c.id);
  const tasks = app.reviews.tasks(), migrated = tasks.find(task => task.id === original.id)!;
  assert.equal(migrated.conversationScope, 'selected');
  assert.deepEqual(migrated.conversationIds, expectedIds);
  assert.deepEqual(app.reviews.conversations(migrated).map(c => c.id), expectedIds);
  assert.deepEqual(tasks.find(task => task.id === 'omitted')!.conversationIds, [other.id]);
  const stored = app.store.get<any[]>('review.tasks', [])[0];
  assert.deepEqual(stored, { ...original, conversationScope: 'selected', conversationIds: expectedIds });
  assert.equal(app.store.get(cursor, 0), 17);
  assert.deepEqual(app.store.document('review-jobs', frozen.id), frozen);
  assert.deepEqual(app.store.conversations(), before);
  const saved = app.store.get('review.tasks', []);
  app.store.saveConversation({ ...first, review: false });
  conversation(app, { review: true });
  assert.deepEqual(app.reviews.tasks().find(task => task.id === original.id)!.conversationIds, expectedIds);
  assert.deepEqual(app.store.get('review.tasks', []), saved);
});

test('legacy global policies preserve empty and populated ranges and independent read positions', async t => {
  const app = await setup(t);
  const main = conversation(app, { kind: 'main' }), chosen = conversation(app, { review: true });
  const report = conversation(app, { personaId: 'empty-role' });
  app.store.set('review.config', { enabled: false, reportConversationId: report.id,
    sourceIds: ['observation.source'], packetChars: 3000, prompt: 'KEEP_LEGACY_PROMPT' });
  app.store.set('review.watermark.' + chosen.id, 8);
  const tasks = app.reviews.tasks();
  const selected = tasks.find(task => task.personaId === chosen.personaId)!;
  assert.deepEqual(selected.conversationIds, [chosen.id]);
  assert.equal(selected.conversationScope, 'selected');
  assert.deepEqual(tasks.find(task => task.personaId === report.personaId)!.conversationIds, []);
  assert(!app.reviews.conversations(selected).some(c => c.id === main.id));
  assert.equal(selected.prompt, 'KEEP_LEGACY_PROMPT');
  assert.deepEqual(selected.sourceIds, ['observation.source']);
  assert.equal(app.store.get('review.watermark.' + chosen.id, 0), 8);
  await app.plugins.disable('review'); await app.plugins.enable('review');
  assert.equal(app.store.get('review.taskConversation.' + JSON.stringify([selected.id, chosen.id]), 0), 8);
  app.store.saveConversation({ ...main, review: true });
  assert.deepEqual(app.reviews.tasks().find(task => task.id === selected.id)!.conversationIds, [chosen.id]);
});

test('old main fallbacks freeze once, while new main selections never consult legacy flags', async t => {
  const app = await setup(t);
  const chosen = conversation(app, { review: true }), worker = conversation(app, { kind: 'worker', review: true });
  app.store.set('review.conversationSources.v2', false);
  app.store.set('review.tasks', [{ id: 'old-main', personaId: chosen.personaId, enabled: false, conversationScope: 'main' }]);
  const old = app.reviews.tasks()[0];
  assert.equal(old.conversationScope, 'selected'); assert.deepEqual(old.conversationIds, [chosen.id]);
  app.reviews.saveTask('new-main', { personaId: chosen.personaId, enabled: false });
  const fresh = app.reviews.tasks().find(task => task.id === 'new-main')!;
  assert.equal(fresh.conversationScope, 'main'); assert.deepEqual(app.reviews.conversations(fresh), []);
  const main = conversation(app, { kind: 'main' });
  assert.deepEqual(app.reviews.conversations(fresh).map(c => c.id), [main.id]);
  assert(!app.reviews.conversations(old).some(c => c.id === worker.id || c.id === main.id));
});

test('task catalog and conversation operations expose one task-owned source selection', async t => {
  const app = await setup(t);
  const catalog = await app.registry.call('automation.catalog', {}, internal);
  const type = catalog.types.find((type: any) => type.id === 'review.policies');
  assert.equal(type.defaults.conversationScope, 'main');
  assert.equal(type.fields.find((field: any) => field.key === 'conversationScope').allowEmpty, false);
  assert.deepEqual(type.fields.find((field: any) => field.key === 'conversationScope').options.map((option: any) => option.value), ['main', 'selected']);
  for (const name of ['conversations.create', 'conversations.update']) {
    const operation = app.registry.list(internal).find(operation => operation.name === name)!;
    const input = name.endsWith('create') ? { title: 'Synthetic', review: true } : { id: 'synthetic', review: true };
    assert(!Object.hasOwn(operation.input.parse(input) as object, 'review'));
  }
  const created = await app.registry.call('conversations.create', { title: 'Synthetic', review: true }, internal);
  assert(!Object.hasOwn(created, 'review'));
  const old = conversation(app, { review: true });
  app.reviews.tasks();
  const taskSnapshot = app.store.get('review.tasks', []);
  await app.registry.call('conversations.update', { id: old.id, review: false, title: 'Renamed' }, internal);
  assert.equal(app.store.conversation(old.id)!.review, true);
  assert.deepEqual(app.store.get('review.tasks', []), taskSnapshot);
  app.reviews.saveTask('legacy-import', { personaId: old.personaId, enabled: false, conversationScope: 'marked' });
  const imported = app.reviews.tasks().find(task => task.id === 'legacy-import')!;
  assert.equal(imported.conversationScope, 'selected'); assert.deepEqual(imported.conversationIds, [old.id]);
});

test('historical direct callers freeze all legacy roles together instead of dropping other role selections', async t => {
  const app = await setup(t), first = conversation(app, { review: true }), second = conversation(app, { personaId: 'other', review: true });
  assert.deepEqual(app.reviews.policy(first.personaId).conversationIds, [first.id]);
  assert.deepEqual(app.reviews.policy(second.personaId).conversationIds, [second.id]);
  app.store.saveConversation({ ...second, review: false });
  assert.deepEqual(app.reviews.policy(second.personaId).conversationIds, [second.id]);
});
