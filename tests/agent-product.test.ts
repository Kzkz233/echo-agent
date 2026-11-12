import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema, observationConfigSchema } from '../packages/contracts/index.ts';
import { inferenceTasks } from '../packages/contracts/inference.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';
import sharp from 'sharp';

test('language services drive the built-in agent for main and worker conversations; auxiliary inference uses transport', async (t) => {
  const app = await setup(t);
  const transport = new FakeBackend(), agent = new FakeBackend();
  app.router.backends.set('api', transport);
  app.router.backends.set('pi', agent);
  app.router.useConversationRuntime(transport, agent);
  seedProfile(app, profileSchema.parse({ id: 'legacy-pi', kind: 'pi', name: 'Existing service', model: 'synthetic',vision:true }));
  for (const kind of ['main', 'worker']) {
    const chat = conversation(app, { kind });
    await app.router.bind(chat.id, 'test', new AbortController().signal);
    assert.equal(app.router.executionBackend(app.router.profile('test'), chat.id), agent);
    await app.router.send({ conversationId: chat.id, text: 'Synthetic request', requestId: kind });
  }
  assert.equal(agent.calls.length, 2);
  await app.router.infer(inferenceTasks.query, [{ role: 'user', text: 'Query terms' }], new AbortController().signal);
  await app.router.infer(inferenceTasks.vision, [{ role: 'user', text: 'Vision' }], new AbortController().signal, undefined, undefined, 'legacy-pi');
  assert.equal(transport.calls.length, 2);
  assert.equal(agent.calls.length, 2);
});

test('disabling a role capability preserves and suspends its configured tasks, then restores intent', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('mail');
  await app.plugins.enable('mail-triggers');
  app.store.put('mail-accounts', 'fixture', { id: 'fixture', name: 'Synthetic mailbox' });
  const call = (name: string, input: any) => app.registry.call(name, input, internal);
  let role = await call('persona.character.commit', { requestId: 'create-task-role', draft: characterDraft.parse({
    persona: { id: 'task-role', name: 'Task role', prompt: 'Unchanged original persona' }, features: ['mail', 'mail-triggers'],
    configurations: { mail: { accountIds: ['fixture'] } },
    tasks: [{ id: 'mail-reminder', type: 'mail-triggers.rules', settings: {
      name: 'Mailbox reminder', accountIds: ['fixture'], enabled: true, cooldownMinutes: 37,
      rules: [{ name: 'Fixture topic', match: 'subject', terms: 'synthetic' }],
    } }],
  }) });
  role = await call('persona.character.commit', { requestId: 'disable-task-role', draft: { ...role, features: [] } });
  assert.equal(role.tasks.length, 1);
  assert.equal(role.tasks[0].enabledWhenAvailable, true);
  assert.equal(role.tasks[0].settings.enabled, false);
  assert.equal(role.tasks[0].settings.cooldownMinutes, 37);
  role = await call('persona.character.commit', { requestId: 'restore-task-role', draft: { ...role, features: ['mail', 'mail-triggers'] } });
  assert.equal(role.tasks[0].settings.enabled, true);
  assert.equal(role.tasks[0].enabledWhenAvailable, undefined);
  assert.equal(role.persona.prompt, 'Unchanged original persona');
  await app.plugins.disable('mail-triggers');
  role = await call('persona.character.read', { id: 'task-role' });
  role = await call('persona.character.commit', { requestId: 'edit-with-unavailable-plugin', draft: {
    ...role, persona: { ...role.persona, name: 'Renamed role' },
  } });
  assert(app.store.document<any>('characters', 'task-role').taskIds.some((task: any) => task.id === 'mail-reminder'));
  await app.plugins.enable('mail-triggers');
  role = await call('persona.character.read', { id: 'task-role' });
  assert.equal(role.tasks[0].settings.cooldownMinutes, 37);
});

test('observation task model selection overrides only that task and preserves the role route', async (t) => {
  const app = await setup(t), backend = new FakeBackend();
  app.router.backends.set('api', backend);
  seedProfile(app, profileSchema.parse({ id: 'vision-task-model', name: 'Task vision', kind: 'api', vision: true,
    model: 'task-vision', endpoint: 'http://127.0.0.1:1/v1' }));
  const before = app.store.get('routes', {});
  app.observations.configure(observationConfigSchema.parse({ visionProfileId: 'vision-task-model' }));
  backend.responder = async () => ({ text: '{"summary":"A synthetic green screen","attention":""}' });
  const jpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: 'green' } }).jpeg().toBuffer();
  const frames = Array.from({ length: 4 }, (_, i) => ({ timestamp: new Date(Date.now() + i).toISOString(),
    source: 'fixture', title: 'Synthetic', ruleId: 'fixture', jpeg, signature: new Uint8Array(), generation: 0 }));
  await app.observations.process(frames);
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].profile.id, 'vision-task-model');
  assert.deepEqual(app.store.get('routes', {}), before);
  const references = await app.registry.call('inference.references', { id: 'vision-task-model' }, internal);
  assert(references.some((entry: any) => entry.id === 'observation.tasks'));
  await assert.rejects(app.registry.call('profiles.delete', { id: 'vision-task-model' }, internal), /仍被角色或任务使用/);
  app.observations.remove('default');
  await app.registry.call('profiles.delete', { id: 'vision-task-model' }, internal);
  assert(!app.router.inference.models().some((model) => model.id === 'vision-task-model'));
});

test('character setting placement and inference ownership come from registered contributions', async (t) => {
  const app = await setup(t);
  const catalog = await app.registry.call('persona.character.catalog', {}, internal);
  assert.equal(catalog.features.find((feature: any) => feature.id === 'memory').presentation.section, 'memory');
  assert.equal(catalog.features.find((feature: any) => feature.id === 'delegation').presentation.section, 'tools');
  const options = await app.registry.call('inference.options', {}, internal);
  assert.equal(options.tasks.find((task: any) => task.id === inferenceTasks.vision).owner, 'observation');
  assert(!JSON.stringify(options).includes('apiKeyRef'));
  const plugins = app.plugins.list();
  assert(plugins.find((plugin) => plugin.id === 'files')!.loadOrder < plugins.find((plugin) => plugin.id === 'memory')!.loadOrder);
});

test('inherited role models follow the current main model without freezing an implicit route', async (t) => {
  const app = await setup(t), backend = new FakeBackend();
  app.router.backends.set('api', backend);
  seedProfile(app, profileSchema.parse({ id: 'alternate', kind: 'api', name: 'Alternate',
    endpoint: 'http://127.0.0.1:1/v1', model: 'alternate', vision: true }));
  let role = await app.registry.call('persona.character.commit', { requestId: 'inherit-create', draft: characterDraft.parse({
    persona: { id: 'inherit-role', name: 'Inherit', prompt: 'Original' }, features: ['memory', 'observation'], profileId: 'test',
  }) }, internal);
  assert.deepEqual(role.routes, {});
  assert.equal(app.router.route(inferenceTasks.vision, 'inherit-role').id, 'test');
  role = await app.registry.call('persona.character.commit', { requestId: 'inherit-change', draft: { ...role, profileId: 'alternate' } }, internal);
  assert.deepEqual(role.routes, {});
  assert.equal(app.router.route(inferenceTasks.vision, 'inherit-role').id, 'alternate');
  assert.equal(app.router.route(inferenceTasks.query, 'inherit-role').id, 'alternate');
});
