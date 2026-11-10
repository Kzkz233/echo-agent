import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FakeBackend, until, conversation } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';
import { profileSchema } from '../packages/contracts/index.ts';

test('editing a role leaves unchanged schedules and shared-source assignments intact', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('scheduler');
  await app.plugins.enable('mail');
  app.store.put('mail-accounts', 'fixture-account', { id: 'fixture-account', name: 'Fixture' });
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  const role = await call('persona.character.commit', {
    requestId: 'scheduled-role',
    draft: characterDraft.parse({
      persona: { id: 'owner', name: 'Owner', prompt: 'Original' },
      features: ['mail'],
      tasks: [
        {
          id: 'sync-fixture',
          type: 'scheduler.mail',
          settings: {
            name: 'Sync fixture',
            enabled: false,
            accountId: 'fixture-account',
            mode: 'interval',
            minutes: 30,
          },
        },
      ],
    }),
  });
  const original = app.store.document<any>('scheduler-jobs', 'sync-fixture');
  app.store.put('scheduler-jobs', 'sync-fixture', { ...original, nextAt: Date.now() + 123456 });
  const expected = app.store.document('scheduler-jobs', 'sync-fixture');
  const draft = await call('persona.character.read', { id: role.persona.id });
  await call('persona.character.commit', {
    requestId: 'edit-scheduled-role',
    draft: { ...draft, persona: { ...draft.persona, prompt: 'Revised persona' } },
  });
  assert.deepEqual(app.store.document('scheduler-jobs', 'sync-fixture'), expected);
});

test('managed chats change backend and permissions through character configuration only', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  seedProfile(
    app,
    profileSchema.parse({
      id: 'alternate',
      name: 'Alternate',
      kind: 'api',
      endpoint: 'http://127.0.0.1:1/v1',
      model: 'fixture',
    }),
  );
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  const role = await call('persona.character.commit', {
    requestId: 'managed-role',
    draft: characterDraft.parse({
      persona: { id: 'owner', name: 'Owner', prompt: 'Synthetic' },
      features: [],
      profileId: 'test',
    }),
  });
  await assert.rejects(
    call('conversations.bind', { id: role.mainConversationId, profileId: 'alternate' }),
    /编辑角色/,
  );
  await assert.rejects(
    app.registry.call(
      'conversations.permissions',
      {
        id: role.mainConversationId,
        permissions: role.permissions,
      },
      { kind: 'ui', permissions: new Set(['conversation.write']) },
    ),
    /编辑角色/,
  );
  await assert.rejects(
    call('conversations.update', { id: role.mainConversationId, personaId: 'companion' }),
    /更换角色/,
  );
  await call('conversations.bind', { id: role.mainConversationId, profileId: 'test' });
  const updated = await call('persona.character.commit', {
    requestId: 'switch-role',
    draft: { ...role, profileId: 'alternate' },
  });
  assert.equal(updated.profileId, 'alternate');
  assert.equal(backend.archived.length, 1);
  for (const kind of ['worker', 'group-member']) {
    const chat = conversation(app, { kind, personaId: 'owner' });
    await assert.rejects(
      call('conversations.bind', { id: chat.id, profileId: 'alternate' }),
      /编辑角色/,
    );
  }
  const independent = conversation(app);
  await call('conversations.bind', { id: independent.id, profileId: 'test' });
  assert.equal(app.store.binding(independent.id)?.profileId, 'test');
});

test('saving an active main role cannot partially change its permissions or configuration', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  backend.responder = (request) =>
    new Promise((resolve) =>
      request.signal.addEventListener('abort', () => resolve({ text: 'Stopped' }), { once: true }),
    );
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  const role = await call('persona.character.commit', {
    requestId: 'active-role',
    draft: characterDraft.parse({
      persona: { id: 'owner', name: 'Owner', prompt: 'Original' },
      features: [],
      profileId: 'test',
    }),
  });
  const running = app.router.send({
    conversationId: role.mainConversationId,
    text: 'Start',
    requestId: 'running-role',
  });
  await until(() => backend.calls.length === 1);
  await assert.rejects(
    call('persona.character.commit', {
      requestId: 'edit-active',
      draft: {
        ...role,
        persona: { ...role.persona, prompt: 'Changed' },
        permissions: {
          ...role.permissions,
          codex: { ...role.permissions.codex, approvals: 'ask' },
        },
      },
    }),
    /主会话的当前运行/,
  );
  assert.equal((await call('persona.character.read', { id: 'owner' })).persona.prompt, 'Original');
  assert.deepEqual(app.store.conversation(role.mainConversationId)!.permissions, role.permissions);
  app.router.cancel(role.mainConversationId);
  await running;
});

test('temporary role configuration suspension does not turn off the saved frame avatar', async (t) => {
  const app = await setup(t);
  const draft = characterDraft.parse({
    persona: { id: 'frame-role', name: 'Frame role', prompt: 'Synthetic' },
    features: ['avatar'],
    configurations: { avatar: { enabled: true, renderer: 'frames' } },
  });
  const saved: any = await app.registry.call(
    'persona.character.commit',
    { draft, requestId: 'frame-role-create' },
    internal,
  );
  assert.equal(saved.configurations.avatar.enabled, true);
  assert.equal(app.store.get<any>('avatar.config', {}).enabled, true);
  await app.registry.call(
    'persona.character.commit',
    { draft: saved, requestId: 'frame-role-edit' },
    internal,
  );
  assert.equal(app.store.get<any>('avatar.config', {}).enabled, true);
});

test('role-owned contributed tasks retain ownership even when the execution plugin has no persona dependency', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('scheduler');
  await app.plugins.enable('mail');
  app.store.put('mail-accounts', 'fixture-account', {
    id: 'fixture-account',
    name: 'Fixture mailbox',
  });
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  const role = await call('persona.character.commit', {
    requestId: 'mail-role',
    draft: characterDraft.parse({
      persona: { id: 'mail-role', name: 'Mailbox role', prompt: 'Synthetic' },
      features: ['mail'],
      tasks: [
        {
          id: 'role-mail-sync',
          type: 'scheduler.mail',
          settings: {
            name: 'Role mail sync',
            mode: 'interval',
            minutes: 10,
            enabled: false,
            accountId: 'fixture-account',
          },
        },
      ],
    }),
  });
  assert.equal(role.tasks.length, 1);
  assert.equal(role.tasks[0].id, 'role-mail-sync');
  assert.equal(app.store.document<any>('scheduler-jobs', 'role-mail-sync').personaId, undefined);
  await call('persona.character.commit', {
    requestId: 'mail-role-remove',
    draft: { ...role, features: [], tasks: [] },
  });
  assert.equal(app.store.document('scheduler-jobs', 'role-mail-sync'), undefined);
});

test('character packages carry validated frame assets and upgrades retain local overrides', async (t) => {
  const app = await setup(t);
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  const draft = characterDraft.parse({
    persona: { id: 'sprite-role', name: 'Sprite', prompt: 'Original persona' },
    features: ['memory', 'avatar'],
    configurations: {
      memory: { planner: false, limit: 2 },
      avatar: { assetDirectory: app.project + '/apps/workbench/public/assets/cute-girl' },
    },
  });
  await call('persona.character.commit', { draft, requestId: 'sprite-role' });
  const pack = await call('persona.package.export', {
    personaId: 'sprite-role',
    packageId: 'sprite-template',
    version: '1',
  });
  assert(pack.features.find((f: any) => f.id === 'avatar').assets['atlas.png']);
  assert(!JSON.stringify(pack).includes(app.project));
  const imported = await call('persona.package.import', pack);
  const installed = await call('persona.character.commit', {
    draft: imported.draft,
    requestId: 'install-sprite',
  });
  assert(installed.configurations.avatar.assetDirectory);
  const edited = { ...installed, persona: { ...installed.persona, prompt: 'Local persona' } };
  await call('persona.character.commit', { draft: edited, requestId: 'edit-sprite' });
  const next = {
    ...pack,
    version: '2',
    persona: { ...pack.persona, prompt: 'New author persona' },
    features: pack.features.map((f: any) =>
      f.id === 'memory' ? { ...f, configuration: { ...f.configuration, limit: 3 } } : f,
    ),
  };
  const update = await call('persona.package.update', {
    personaId: installed.persona.id,
    package: next,
  });
  assert.equal(update.draft.persona.prompt, 'Local persona');
  assert.equal(update.draft.configurations.memory.limit, 3);
  assert.equal(app.memories.config().limit, 4);
  assert.equal(update.draft.persona.id, installed.persona.id);
});

test('interrupted delegation does not replay and withdrawn capability cancels its work', async (t) => {
  const app = await setup(t);
  const backend = new FakeBackend();
  backend.responder = (request) =>
    new Promise((_resolve, reject) =>
      request.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }),
    );
  app.router.backends.set('codex', backend);
  seedProfile(app, profileSchema.parse({ id: 'worker-model', name: 'Worker', kind: 'codex' }));
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  const initial = characterDraft.parse({
    persona: { id: 'owner', name: 'Owner', prompt: 'Example' },
    features: ['delegation'],
    configurations: {
      delegation: {
        reportOnCompletion: false,
        templates: [{ id: 'default', name: 'Worker', profileId: 'worker-model' }],
      },
    },
  });
  const role = await call('persona.character.commit', { draft: initial, requestId: 'make-owner' });
  const task = await call('delegation.request', {
    conversationId: role.mainConversationId,
    requestId: 'start-work',
    goal: 'Read fixture',
    acceptance: 'Return findings',
  });
  await until(() => backend.calls.length === 1);
  await call('persona.character.commit', {
    draft: { ...role, configurations:{...role.configurations,delegation:{...role.configurations.delegation,autonomous:false,allowedProfileIds:[]}} },
    requestId: 'disable-worker',
  });
  await until(() => app.store.document<any>('delegated-tasks', task.id)?.state === 'cancelled');
  assert.equal(backend.calls.length, 1);
});

test('character setup and editing share plugin configurations and commit idempotently with one main conversation', async (t) => {
  const app = await setup(t);
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  await call('settings.save', {
    pluginId: 'memory',
    value: { planner: false, limit: 2, threshold: 0.08, useSemantic: true },
  });
  const raw = characterDraft.parse({
    persona: { id: 'custom', name: 'Mira', prompt: 'Synthetic persona' },
    features: ['memory', 'review'],
    configurations: { memory: { planner: false, limit: 2 } },
    profileId: 'test',
    tasks: [
      {
        id: 'mira-review',
        type: 'review.policies',
        settings: { enabled: false, prompt: 'Task-specific' },
      },
    ],
  });
  const result = await call('persona.character.commit', { draft: raw, requestId: 'create-mira' });
  assert.equal(result.mainConversationId, 'main-custom');
  assert.equal(result.configurations.memory.limit, 2);
  assert.equal(app.observations.configurations().length, 0);
  assert.equal(app.memories.config().limit, 2);
  assert.equal(app.plugins.list().find((plugin) => plugin.id === 'memory')!.settings.length, 0);
  assert.equal(
    (await call('persona.character.catalog')).features
      .find((feature: any) => feature.id === 'memory')
      .fields.some((field: any) => field.key === 'limit'),
    true,
  );
  assert.equal(app.reviews.policy('custom').prompt, 'Task-specific');
  await call('persona.character.commit', { draft: raw, requestId: 'create-mira' });
  assert.equal(app.store.conversations().filter((c) => c.personaId === 'custom').length, 1);
  const updated = {
    ...result,
    configurations: {
      ...result.configurations,
      memory: { ...result.configurations.memory, limit: 6 },
    },
  };
  const second = await call('persona.character.commit', { draft: updated, requestId: 'edit-mira' });
  assert.equal(second.revision, 2);
  assert.equal(app.memories.config().limit, 2);
  await assert.rejects(
    call('persona.character.commit', { draft: raw, requestId: 'stale-mira' }),
    /其他窗口/,
  );
  const exported = await call('persona.package.export', {
    personaId: 'custom',
    packageId: 'mira',
    version: '1',
  });
  assert(!JSON.stringify(exported).includes('main-custom'));
  assert.equal(exported.features.find((f: any) => f.id === 'memory').configuration.limit, 6);
  assert.equal(app.memories.config('custom').limit, 6);
  const imported = await call('persona.package.import', exported);
  assert.notEqual(imported.draft.persona.id, 'custom');
  assert.equal(imported.draft.profileId, '');
  assert.equal(imported.draft.tasks[0].settings.enabled, false);
  const legacyImport = await call('persona.package.import', {
    ...exported,
    features: [{ id: 'memory', version: 1, configuration: { profileId: 'private-model' } }],
  });
  assert.equal(legacyImport.draft.configurations.memory.profileId, undefined);
  assert.deepEqual(legacyImport.draft.configurations.memory, {});
});

test('group turns retain speaker attribution and use shared context without private main-conversation history', async (t) => {
  const app = await setup(t);
  const backend = new FakeBackend();
  backend.responder = async () => ({ text: 'A group response' });
  app.router.backends.set('api', backend);
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  for (const id of ['first', 'second']) {
    const draft = characterDraft.parse({
      persona: { id, name: id, prompt: 'Role ' + id },
      profileId: 'test',
      features: [],
    });
    const role = await call('persona.character.commit', { draft, requestId: 'create-' + id });
    app.store.append(role.mainConversationId, 'user', 'human', 'PRIVATE_SENTINEL_' + id);
  }
  await call('groups.save', {
    id: 'team',
    name: 'Planning',
    members: ['first', 'second'],
    context: 'Shared project',
  });
  await call('groups.send', {
    groupId: 'team',
    text: 'Discuss the plan',
    speakers: ['first', 'second'],
    requestId: 'group-turn',
  });
  await until(() => app.store.document<any>('group-turns', 'group-turn')?.state === 'completed');
  const result = await call('groups.messages', { id: 'team' });
  assert.deepEqual(
    result.messages.map((m: any) => m.meta.authorPersonaId),
    [undefined, 'first', 'second'],
  );
  assert(backend.calls.length === 2);
  for (const request of backend.calls)
    assert(!JSON.stringify(request.messages).includes('PRIVATE_SENTINEL'));
  await call('groups.send', {
    groupId: 'team',
    text: 'Discuss the plan',
    speakers: ['first', 'second'],
    requestId: 'group-turn',
  });
  assert.equal((await call('groups.messages', { id: 'team' })).messages.length, 3);
  // Simulate a crash after a host reply was durable but before its shared transcript write.
  const latest = result.messages.at(-1);
  app.store.remove('group-messages.team', latest.id);
  const interrupted = app.store.document<any>('group-turns', 'group-turn');
  app.store.put('group-turns', 'group-turn', { ...interrupted, state: 'unknown', done: ['first'] });
  await call('groups.resolve', { id: 'team', confirmed: true });
  assert.equal((await call('groups.messages', { id: 'team' })).messages.length, 3);
  assert.equal(app.store.document<any>('group-turns', 'group-turn').state, 'completed');
  assert.equal(backend.calls.length, 2);
  await call('groups.send', {
    groupId: 'team',
    text: 'Second distinct question',
    speakers: ['first'],
    requestId: 'group-turn-next',
  });
  await until(
    () => app.store.document<any>('group-turns', 'group-turn-next')?.state === 'completed',
  );
  const nextInput = backend.calls[2].messages.at(-1)!.text;
  assert(nextInput.includes('Second distinct question'));
  assert(!nextInput.includes('Discuss the plan'));
  assert(!nextInput.includes('Shared project'));
});

test('delegation honors role permission, deduplicates requests, returns a result and rejects unscoped MCP writes', async (t) => {
  const app = await setup(t);
  const backend = new FakeBackend();
  backend.responder = async (request) => {
    assert.equal(request.permissions?.codex.sandbox, 'read-only');
    assert.match(request.messages[0].text, /WORKER_TEMPLATE[\s\S]*delegation_checkpoint/);
    assert.doesNotMatch(request.messages[0].text, /authority=|Synthetic chief/);
    assert(request.messages.some((m) => m.context === 'turn' && m.text.includes('authority=')));
    assert.match(request.messages.at(-1)!.text, /验收要求/);
    assert.doesNotMatch(request.messages.at(-1)!.text, /WORKER_TEMPLATE/);
    return { text: 'Verified synthetic deliverable' };
  };
  app.router.backends.set('codex', backend);
  seedProfile(
    app,
    profileSchema.parse({ id: 'worker-model', name: 'Synthetic worker', kind: 'codex' }),
  );
  const call = (name: string, params: any = {}) => app.registry.call(name, params, internal);
  const role = await call('persona.character.commit', {
    requestId: 'create-chief',
    draft: characterDraft.parse({
      persona: { id: 'chief', name: 'Chief', prompt: 'Synthetic chief' },
      features: ['delegation'],
      profileId: 'test',
      configurations: {
        delegation: {
          reportOnCompletion: false,
          templates: [
            {
              id: 'default',
              name: 'Worker',
              profileId: 'worker-model',
              prompt: 'WORKER_TEMPLATE',
              write: false,
              timeoutMinutes: 1,
            },
          ],
        },
      },
    }),
  });
  const request = {
    requestId: 'work-one',
    conversationId: role.mainConversationId,
    goal: 'Inspect fixture',
    acceptance: 'Return verified result',
    execution:{profileId:'worker-model',prompt:'WORKER_TEMPLATE',timeoutMinutes:1},
  };
  await assert.rejects(
    app.registry.call('delegation.request', request, {
      kind: 'mcp',
      permissions: new Set(['delegation.write']),
    }),
    /凭据/,
  );
  const task = await call('delegation.request', request);
  await until(() => app.store.document<any>('delegated-tasks', task.id)?.state === 'completed');
  await call('delegation.request', request);
  assert.equal(backend.calls.length, 1);
  assert.equal(
    app.store.allMessages(role.mainConversationId).filter((m) => m.source === 'notification')
      .length,
    1,
  );
  assert.equal(
    app.store.document<any>('delegated-tasks', task.id).result,
    'Verified synthetic deliverable',
  );
  await call('persona.character.commit', {
    requestId: 'change-chief-policy',
    draft: {
      ...role,
      configurations: {
        ...role.configurations,
        delegation: {
          ...role.configurations.delegation,
          allowedProfileIds: [],
        },
      },
    },
  });
  await assert.rejects(
    call('delegation.resume', {
      taskId: task.id,
      conversationId: role.mainConversationId,
      text: 'Do more',
      requestId: 'resume-old-policy',
    }),
    /授权已改变/,
  );
  assert.equal(backend.calls.length, 1);
});
