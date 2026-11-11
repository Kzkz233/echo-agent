import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, FakeBackend } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { starterCharacters, starterStudio } from '../apps/server/starter-content.ts';
import {
  starterCharacters as legacyCharacters,
  starterSourcePrompts as legacySources,
} from '../apps/server/starter-content-v2.ts';
import { refreshStarterDraft } from '../apps/server/starter-refresh.ts';

test('starter studio creates two editable roles with licensed assets, inactive task templates and an isolated group, exactly once', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const call = (name: string, value: any = {}) => app.registry.call(name, value, internal);
  const routes = app.store.get<Record<string, string>>('routes', {});
  delete routes['embeddings.encode'];
  app.store.set('routes', routes);
  assert.equal(app.store.documents('groups').length, 0);
  const result = await call('characters.examples.create', {
    profileId: 'test',
    requestId: 'first',
  });
  assert.equal(result.roles.length, 2);
  for (const id of result.roles) {
    const role = await call('persona.character.read', { id });
    assert.equal(role.profileId, 'test');
    assert.equal(role.tasks.length, 4);
    assert(role.persona.prompt.length > 1000);
    for (const heading of [
      'Identity',
      'Appearance',
      'Style',
      'Working Principles',
      'Character',
      'Delegation',
      'Defaults',
      'Avoid',
    ])
      assert(role.persona.prompt.includes('# ' + heading));
    assert(role.persona.expression.external.length > 100);
    assert(role.persona.expression.bubble.length > 70);
    assert(role.persona.expression.chat.length > 100);
    assert(role.persona.expression.channels['notifications.inbox'].length > 100);
    assert(
      role.features.includes('mail') &&
        role.features.includes('reflections') &&
        role.features.includes('chatstick'),
    );
    assert.equal(role.reasoning, 'off');
    assert.equal(role.routes['memory.query'], 'test');
    assert.equal(role.routes['observation.vision'], 'test');
    const observation = role.tasks.find((task: any) => task.type === 'observation.tasks');
    assert.equal(observation.settings.visionProfileId, 'test');
    assert.equal(observation.settings.visionReasoning, 'off');
    const policy = role.tasks.find((task: any) => task.type === 'review.policies');
    assert.equal(policy.settings.profileId, 'test');
    assert.equal(policy.settings.reasoning, 'off');
    assert.deepEqual(policy.settings.conversationIds, [role.mainConversationId]);
    assert(policy.settings.sourcePrompts['mail.source']);
    assert(policy.settings.targetPrompts['reflections.state']);
    assert.deepEqual(policy.settings.memoryOperations, [
      'add',
      'update',
      'archive',
      'propose-core',
    ]);
    const mail = role.tasks.find((task: any) => task.type === 'mail-triggers.rules');
    assert.equal(mail.settings.remindAll, false);
    assert.equal(mail.settings.useLegacyFilters, false);
    assert.equal(mail.settings.rules.length, 1);
    assert.notEqual(mail.settings.rules[0].terms, '');
    assert.deepEqual(role.configurations.mail.accountIds, []);
    assert.deepEqual(role.configurations.chatstick.channels, {
      'core.chat': true,
      'avatar.bubble': true,
      'notifications.inbox': false,
    });
    assert.equal((await call('chatstick.list', { personaId: id })).length, 3);
    assert(role.tasks.every((task: any) => task.settings.enabled === false));
    assert.equal(role.configurations.avatar.enabled, false);
    assert.equal(role.configurations.avatar.animationClips.speaking, 'waving');
    const manifest = JSON.parse(
      await readFile(join(role.configurations.avatar.assetDirectory, 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.author, 'Ryu JaeHyun');
    assert.equal(manifest.license, 'CC-BY-4.0');
    assert.match(manifest.source, /springtiger07/);
    assert.match(manifest.modifications, /PNG/);
    assert.match(role.persona.portrait, /^data:image\/webp;base64,/);
    const pack = await call('persona.package.export', {
      personaId: id,
      packageId: id,
      version: '1.0.0',
    });
    const imported = await call('persona.package.import', pack);
    const review = imported.draft.tasks.find((task: any) => task.type === 'review.policies');
    assert.deepEqual(review.settings.memoryOperations, [
      'add',
      'update',
      'archive',
      'propose-core',
    ]);
    assert.equal(review.settings.mode, 'daily');
    const copied = JSON.parse(
      await readFile(
        join(imported.draft.configurations.avatar.assetDirectory, 'manifest.json'),
        'utf8',
      ),
    );
    assert.equal(copied.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
  }
  assert.equal(app.store.documents('groups').length, 1);
  assert.equal(app.store.documents('memories').length, 0);
  assert.equal(app.router.route('embeddings.encode').model, 'Xenova/bge-small-zh-v1.5');
  assert.equal(backend.calls.length, 0, 'creating examples must not invoke inference');
  const rolesBefore = JSON.stringify(app.store.documents('personas'));
  assert.deepEqual(
    await call('characters.examples.create', { profileId: 'test', requestId: 'again' }),
    result,
  );
  assert.equal(JSON.stringify(app.store.documents('personas')), rolesBefore);
});

test('starter updates require explicit action and preserve histories, activity and existing shared models', async (t) => {
  const app = await setup(t);
  const call = (n: string, p: any = {}) => app.registry.call(n, p, internal);
  await call('characters.examples.create', { profileId: 'test', requestId: 'create' });
  const before = await call('persona.character.read', { id: 'example-hina' });
  app.store.append(before.mainConversationId, 'user', 'human', 'Synthetic retained conversation');
  await call('characters.setActive', {
    personaId: 'example-hina',
    enabled: false,
    revision: before.activity.revision,
  });
  app.store.set('routes', {
    ...app.store.get('routes', {}),
    'embeddings.encode': 'existing-custom-model',
  });
  app.store.put('personas', 'example-hina', { ...before.persona, prompt: 'Synthetic custom edit' });
  await call('characters.examples.create', { profileId: 'test', requestId: 'idempotent' });
  assert.equal(
    app.store.document<any>('personas', 'example-hina')!.prompt,
    'Synthetic custom edit',
  );
  await call('characters.examples.create', {
    profileId: 'test',
    requestId: 'explicit-update',
    updateExisting: true,
  });
  const after = await call('persona.character.read', { id: 'example-hina' });
  assert.equal(after.activity.enabled, false);
  assert.equal(after.mainConversationId, before.mainConversationId);
  assert(
    app.store
      .allMessages(before.mainConversationId)
      .some((m) => m.text === 'Synthetic retained conversation'),
  );
  assert.equal(after.persona.prompt, 'Synthetic custom edit');
  assert.equal(app.store.get<any>('routes', {})['embeddings.encode'], 'existing-custom-model');
});

test('v2 example refresh upgrades untouched text while preserving local prompts, tasks, authorization and assets', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const call = (name: string, input: any = {}) =>
    app.registry.call(name, input, internal) as Promise<any>;
  await call('characters.examples.create', { profileId: 'test', requestId: 'create' });
  const current = await call('persona.character.read', { id: 'example-hina' });
  const legacy = legacyCharacters[0];
  const draft = structuredClone(current);
  draft.persona.prompt = legacy.prompt;
  draft.persona.expression = {
    ...legacy.expression,
    external: 'Synthetic custom QQ style',
    channels: { 'test.target': 'Synthetic custom channel' },
  };
  draft.configurations.memory.queryPrompt = 'Synthetic custom query';
  draft.configurations.delegation.prompt = legacy.delegation;
  draft.configurations.delegation.reportPrompt = legacy.handoff;
  draft.configurations.avatar.fps = 12;
  draft.features = draft.features.filter((f: string) => f !== 'chatstick');
  const review = draft.tasks.find((task: any) => task.type === 'review.policies');
  for (const key of Object.keys(review.settings))
    if (key.startsWith('sourcePrompt.') || key.startsWith('targetPrompt.'))
      delete review.settings[key];
  Object.assign(review.settings, {
    hour: 17,
    contextMode: 'fresh',
    memoryOperations: ['add'],
    prompt: legacy.review,
    memoryPrompt: legacy.memory,
    corePrompt: legacy.core,
    reportPrompt: legacy.report,
    sourcePrompts: {
      ...legacySources,
      'mail.source': 'Synthetic custom mail source',
      'custom.source': 'Synthetic extra source',
    },
    targetPrompts: {
      'reflections.state': legacy.concern,
      'custom.target': 'Synthetic extra target',
    },
    outputTargets: ['notifications.inbox'],
  });
  const observation = draft.tasks.find((task: any) => task.type === 'observation.tasks');
  Object.assign(observation.settings, {
    interactionPrompt: legacy.interaction,
    observationPrompt: legacy.observation,
  });
  const mail = draft.tasks.find((task: any) => task.type === 'mail-triggers.rules');
  mail.settings.prompt = legacy.mail;
  mail.settings.rules = [{ name: 'My rule', match: 'subject', terms: 'Synthetic only' }];
  draft.tasks = draft.tasks.filter((task: any) => task.type !== 'care.rules');
  draft.tasks.push({
    id: 'my-extra-task',
    type: 'care.rules',
    settings: {
      ...current.tasks.find((task: any) => task.type === 'care.rules').settings,
      id: 'my-extra-task',
      prompt: 'Synthetic custom task',
    },
  });
  draft.package = {
    id: 'echo-starter-hina',
    version: '2.0.1',
    baseline: {
      format: 'echo-character-v1',
      id: 'echo-starter-hina',
      version: '2.0.1',
      persona: { name: 'Hina', prompt: legacy.prompt },
      features: [],
      tasks: [],
    },
  };
  await call('persona.character.commit', { draft, requestId: 'legacy' });
  await call('characters.setActive', {
    personaId: 'example-hina',
    enabled: false,
    revision: current.activity.revision,
  });
  await call('chatstick.save', {
    personaId: 'example-hina',
    key: 'hello',
    label: 'My greeting',
    meaning: 'Synthetic edited sticker',
    replace: true,
  });
  const stickerBefore = app.store.documents('chatstick');
  app.store.set('starter.studio.v1', {
    ...app.store.get<any>('starter.studio.v1', {}),
    version: '2.0.1',
    groupDefaults: undefined,
  });
  const group = app.store.document<any>('groups', 'example-studio')!;
  group.context =
    '这是使用者与 Hina、Miyu 的共享工作室，可以一起讨论学习、创作、日常计划或项目。没有预设的私人经历。';
  group.prompt = 'Synthetic custom group prompt';
  app.store.put('groups', group.id, group);
  const mcpBefore = app.store.get('mcp.permissions', []);
  const before = await call('persona.character.read', { id: 'example-hina' });
  const result = await call('characters.examples.refresh', { requestId: 'refresh' });
  const after = await call('persona.character.read', { id: 'example-hina' });
  assert.equal(after.persona.prompt, starterCharacters[0].prompt);
  assert.equal(after.persona.expression.external, 'Synthetic custom QQ style');
  assert.equal(after.persona.expression.chat, starterCharacters[0].expression.chat);
  assert.equal(after.persona.expression.channels['test.target'], 'Synthetic custom channel');
  assert.equal(
    after.persona.expression.channels['notifications.inbox'],
    starterCharacters[0].expression.channels['notifications.inbox'],
  );
  assert.equal(after.configurations.memory.queryPrompt, 'Synthetic custom query');
  assert.equal(after.configurations.delegation.prompt, starterCharacters[0].delegation);
  const reviewed = after.tasks.find((task: any) => task.type === 'review.policies');
  assert.equal(reviewed.settings.memoryPrompt, starterCharacters[0].memory);
  assert.equal(reviewed.settings.sourcePrompts['mail.source'], 'Synthetic custom mail source');
  assert.equal(reviewed.settings.sourcePrompts['custom.source'], 'Synthetic extra source');
  assert.notEqual(
    reviewed.settings.sourcePrompts['core.conversation'],
    legacySources['core.conversation'],
  );
  assert.equal(
    reviewed.settings['sourcePrompt.core.conversation'],
    reviewed.settings.sourcePrompts['core.conversation'],
  );
  assert.equal(reviewed.settings.targetPrompts['custom.target'], 'Synthetic extra target');
  assert.equal(reviewed.settings.hour, 17);
  assert.equal(reviewed.settings.contextMode, 'fresh');
  assert.deepEqual(reviewed.settings.memoryOperations, ['add']);
  assert.deepEqual(reviewed.settings.outputTargets, ['notifications.inbox']);
  assert.equal(
    after.tasks.some((task: any) => task.id === 'example-hina-care'),
    false,
  );
  assert.equal(
    after.tasks.find((task: any) => task.id === 'my-extra-task').settings.prompt,
    'Synthetic custom task',
  );
  for (const key of [
    'features',
    'profileId',
    'reasoning',
    'routes',
    'permissions',
    'toolPermissions',
    'activity',
    'mainConversationId',
  ])
    assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.configurations.avatar, before.configurations.avatar);
  assert.deepEqual(
    after.configurations.delegation.workspaces,
    before.configurations.delegation.workspaces,
  );
  assert.deepEqual(
    after.tasks.find((task: any) => task.type === 'mail-triggers.rules').settings.rules,
    mail.settings.rules,
  );
  assert.deepEqual(app.store.get('mcp.permissions', []), mcpBefore);
  assert.deepEqual(app.store.documents('chatstick'), stickerBefore);
  assert.equal(app.store.document<any>('groups', 'example-studio')!.context, starterStudio.context);
  assert.equal(
    app.store.document<any>('groups', 'example-studio')!.prompt,
    'Synthetic custom group prompt',
  );
  assert(result.changes.find((row: any) => row.id === 'example-hina').preserved > 0);
  const again = refreshStarterDraft(after, starterCharacters[0], result.version);
  assert.equal(again.updated, 0);
  assert.equal(backend.calls.length, 0);
  assert.equal(app.store.documents('memories').length, 0);
  const receipt = await call('characters.examples.refresh', { requestId: 'refresh' });
  assert.deepEqual(receipt.changes, []);
});
