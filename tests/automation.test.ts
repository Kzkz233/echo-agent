import test from 'node:test';
import assert from 'node:assert/strict';
import { internal } from '../packages/kernel/registry.ts';
import { conversation, FakeBackend, setup, until } from './helpers.ts';

test('Review scopes observations to the role and selected tasks without consuming excluded records', async (t) => {
  const app = await setup(t);
  const personaId = 'companion';
  const policy = app.reviews.policy(personaId);
  const call = (name: string, params = {}) => app.registry.call(name, params, internal);
  const storePolicy = (streams: string[]) =>
    call('automation.save', {
      type: 'review.policies',
      id: policy.id,
      settings: {
        ...policy,
        sourceIds: ['observation.source'],
        sourceStreams: { 'observation.source': streams },
      },
    });
  const base = Date.now() - 30000;
  for (const [index, taskId, role] of [
    [0, 'task-b', personaId],
    [1, 'task-a', personaId],
    [2, 'task-a', 'other'],
  ] as const) {
    await app.observations.record({
      id: 'obs-' + index,
      personaId: role,
      taskId,
      conversationId: '',
      timestamp: new Date(base + index * 1000).toISOString(),
      frameTimes: [],
      sources: ['fixture'],
      summary: 'Observation ' + index,
      interesting: false,
    });
  }
  await storePolicy(['task-a']);
  assert.deepEqual(
    (await app.reviews.collect(personaId)).map((m) => m.id),
    ['obs-1'],
  );
  const backend = new FakeBackend();
  backend.responder = async () => ({ text: '{"notes":"Done","memories":[]}' });
  app.router.backends.set('api', backend);
  const job = await app.reviews.start(personaId, 'scoped-observation-review');
  await until(() => app.reviews.jobs().some((r) => r.id === job.id && r.state === 'completed'));
  await storePolicy(['task-a', 'task-b']);
  assert.deepEqual(
    (await app.reviews.collect(personaId)).map((m) => m.id),
    ['obs-0'],
  );
  await storePolicy([]);
  assert.deepEqual(await app.reviews.collect(personaId), []);
});

test('Review renders registered prompt fields and scopes the model guidance to the frozen packet sources', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('reflections');
  const chat = conversation(app, { review: true });
  const call = (name: string, params = {}) => app.registry.call(name, params, internal);
  const descriptor = async () =>
    (await call('automation.catalog')).types.find(
      (type: { id: string }) => type.id === 'review.policies',
    );
  const initial = await descriptor();
  const observationField = initial.fields.find(
    (field: { key: string }) => field.key === 'sourcePrompt.observation.source',
  );
  assert.deepEqual(observationField.when, { key: 'sourceIds', value: 'observation.source' });
  assert(
    initial.fields.some((field: { key: string }) => field.key === 'targetPrompt.reflections.state'),
  );

  const policy = app.reviews.policy('companion');
  await call('automation.save', {
    type: 'review.policies',
    id: policy.id,
    settings: {
      ...policy,
      packetChars: 2000,
      prompt: 'GLOBAL_RULE',
      sourceIds: ['observation.source'],
      targetIds: ['reflections.state'],
      'sourcePrompt.core.conversation': 'CHAT_RULE',
      'sourcePrompt.observation.source': 'OBSERVATION_RULE',
      'targetPrompt.reflections.state': 'REFLECTION_RULE',
    },
  });
  const saved = (await descriptor()).items[0].settings;
  assert.equal(saved['sourcePrompt.core.conversation'], 'CHAT_RULE');
  assert.equal(saved['sourcePrompt.observation.source'], 'OBSERVATION_RULE');
  app.store.append(chat.id, 'user', 'human', 'x'.repeat(3500));
  await app.observations.record({
    id: 'synthetic-observation',
    personaId: 'companion',
    conversationId: '',
    timestamp: new Date(Date.now() + 1000).toISOString(),
    frameTimes: [],
    sources: ['fixture'],
    summary: 'y'.repeat(900),
    interesting: false,
  });

  const backend = new FakeBackend();
  backend.responder = async () => ({ text: '{"notes":"Done","memories":[]}' });
  app.router.backends.set('api', backend);
  const job = await app.reviews.start('companion', 'source-prompt-fixture');
  await until(() =>
    app.reviews.jobs().some((row) => row.id === job.id && row.state === 'completed'),
  );
  assert.deepEqual(
    backend.calls.map((request) => {
      const prompt = request.messages[0].text;
      assert(prompt.includes('GLOBAL_RULE') && prompt.includes('REFLECTION_RULE'));
      return [prompt.includes('CHAT_RULE'), prompt.includes('OBSERVATION_RULE')];
    }),
    [
      [true, false],
      [true, true],
      [false, true],
    ],
  );

  await app.plugins.disable('observation');
  await app.plugins.disable('reflections');
  const reduced = await descriptor();
  assert(
    !reduced.fields.some(
      (field: { key: string }) =>
        field.key === 'sourcePrompt.observation.source' ||
        field.key === 'targetPrompt.reflections.state',
    ),
  );
  assert.equal(reduced.items[0].settings['sourcePrompt.observation.source'], 'OBSERVATION_RULE');
  assert.equal(reduced.items[0].settings['targetPrompt.reflections.state'], 'REFLECTION_RULE');
});

test('automation exposes optional types and keeps settings and frozen Review materials per role', async (t) => {
  const app = await setup(t);
  for (const id of ['care', 'scheduler', 'reflections', 'mail']) await app.plugins.enable(id);
  const call = (name: string, params = {}) => app.registry.call(name, params, internal);
  const catalog = await call('automation.catalog');
  assert.deepEqual(catalog.unavailable, []);
  for (const id of ['care.rules', 'review.policies', 'observation.tasks'])
    assert.equal(catalog.types.find((type: { id: string }) => type.id === id)?.scope, 'character');
  const observation = catalog.types.find((type: { id: string }) => type.id === 'observation.tasks');
  assert.ok(observation);
  assert.deepEqual(
    observation.defaults.occlusionAllowlist.map(({ id, value, enabled }: any) => [
      id,
      value,
      enabled,
    ]),
    [
      ['echo-avatar-overlay', 'echo-avatar.exe', true],
      ['nvidia-performance-overlay', 'NVIDIA Overlay.exe', true],
    ],
  );
  assert.deepEqual(
    observation.defaults.browserAllowlist.map(({ name, value, enabled }: any) => [
      name,
      value,
      enabled,
    ]),
    [
      ['Google Chrome', 'chrome.exe', true],
      ['Microsoft Edge', 'msedge.exe', true],
      ['Brave', 'brave.exe', true],
      ['Firefox', 'firefox.exe', true],
    ],
  );
  assert.equal(
    catalog.types.find((type: { id: string }) => type.id === 'scheduler.mail')?.scope,
    'workspace',
  );
  for (const id of ['care.rules', 'review.policies', 'observation.tasks', 'scheduler.mail'])
    assert.ok(
      catalog.types.some((type: { id: string }) => type.id === id),
      id,
    );

  const otherRole = {
    ...app.store.document<object>('personas', 'companion'),
    id: 'other',
    name: 'Other',
  };
  app.store.put('personas', otherRole.id, otherRole);
  const first = conversation(app),
    other = conversation(app, { personaId: 'other', review: true });
  const save = (id: string, settings: object) =>
    call('automation.save', { type: 'review.policies', id, settings });
  await save('first-review', {
    name: 'Synthetic review',
    personaId: 'companion',
    conversationScope: 'selected',
    conversationIds: [first.id],
    reportConversationId: first.id,
    targetIds: ['reflections.state'],
    sourceIds: [],
    prompt: 'First instructions',
    'targetPrompt.reflections.state': 'Specific reflection instructions',
  });
  const second = app.reviews.policy('other');
  await save(second.id, { ...second, sourceIds: [], prompt: 'Other instructions' });
  await assert.rejects(save(second.id, { ...second, reportConversationId: first.id }), /所选角色/);
  app.store.append(first.id, 'user', 'human', 'First material');
  app.store.append(other.id, 'user', 'human', 'Other material');
  const backend = new FakeBackend();
  backend.responder = async () => ({ text: '{"notes":"Done","memories":[]}' });
  app.router.backends.set('api', backend);
  await call('automation.run', {
    type: 'review.policies',
    id: 'first-review',
    requestId: 'task-review-fixture',
  });
  await until(() =>
    app.reviews
      .jobs()
      .some((job) => job.key === 'task-review-fixture' && job.state === 'completed'),
  );
  const job = app.reviews.jobs().find((job) => job.key === 'task-review-fixture');
  assert.equal(job?.policy?.prompt, 'First instructions');
  assert.equal(app.reviews.policy('other').prompt, 'Other instructions');
  const prompt = backend.calls.flatMap((r) => r.messages.map((m) => m.text)).join('\n');
  assert.match(prompt, /First material/);
  assert.match(prompt, /Specific reflection instructions/);
  assert.doesNotMatch(prompt, /Other material|Other instructions/);
  await app.plugins.disable('care');
  assert.ok(
    !(await call('automation.catalog')).types.some(
      (type: { id: string }) => type.id === 'care.rules',
    ),
  );
});
