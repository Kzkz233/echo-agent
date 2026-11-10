import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, FakeBackend } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';

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
  assert(after.persona.prompt.length > 1000);
  assert.equal(app.store.get<any>('routes', {})['embeddings.encode'], 'existing-custom-model');
});
