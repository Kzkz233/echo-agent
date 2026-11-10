import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { setup, conversation, FakeBackend } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { profileSchema, observationConfigSchema } from '../packages/contracts/index.ts';
import { inferenceTasks, modelProfileSchema } from '../packages/contracts/inference.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';
import { modelEligible } from '../apps/workbench/src/model-eligibility.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';

test('all model selectors consume the same task eligibility as route saving and execution', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('semantic');
  await app.router.inference.refresh();
  for (const [id, kind, vision] of [
    ['language', 'api', false],
    ['vision', 'api', true],
    ['dsh-worker', 'dsh', true],
    ['codex-worker', 'codex', true],
  ] as const)
    seedProfile(app, profileSchema.parse({ id, name: id, kind, model: 'synthetic', vision }));
  app.store.put(
    'profiles',
    'embed',
    modelProfileSchema.parse({
      id: 'embed',
      name: 'Embed',
      connectionId: 'language',
      model: 'embedding',
      generation: { enabled: false, inputs: ['text'] },
      embedding: { enabled: true, inputs: ['text'] },
    }),
  );
  app.store.put(
    'profiles',
    'rank',
    modelProfileSchema.parse({
      id: 'rank',
      name: 'Rank',
      connectionId: 'language',
      model: 'rank',
      generation: { enabled: false, inputs: ['text'] },
      reranking: { enabled: true, inputs: ['text'] },
    }),
  );
  const options = await app.registry.call('inference.options', {}, internal);
  for (const task of options.tasks)
    for (const profile of options.profiles) {
      const model = app.router.inference.models().find((m) => m.id === profile.id)!;
      assert.equal(
        modelEligible(profile, { taskId: task.id }),
        profile.available && app.router.inference.compatible(model, task),
        task.id + ' / ' + profile.id,
      );
    }
  const select = (taskId: string) =>
    options.profiles
      .filter((profile: any) => modelEligible(profile, { taskId }))
      .map((p: any) => p.id);
  assert(!select(inferenceTasks.semanticQuery).includes('dsh-worker'));
  assert(!select(inferenceTasks.rerankLanguage).includes('codex-worker'));
  assert(select(inferenceTasks.review).includes('dsh-worker'));
  assert(select(inferenceTasks.review).includes('codex-worker'));
  assert(!select(inferenceTasks.vision).includes('language'));
  assert(select(inferenceTasks.vision).includes('vision'));
  assert.deepEqual(select(inferenceTasks.rerank), ['rank']);
  assert(!options.profiles.some((p: any) => p.id === 'embed' && modelEligible(p)));
  await assert.rejects(
    app.registry.call('routes.save', { [inferenceTasks.rerankLanguage]: 'dsh-worker' }, internal),
    /符合|能力/,
  );
  const backend = new FakeBackend();
  app.router.backends.set('dsh', backend);
  await assert.rejects(
    app.router.infer(
      inferenceTasks.semanticQuery,
      [{ role: 'user', text: 'fixture' }],
      new AbortController().signal,
      'inherit',
      undefined,
      'dsh-worker',
    ),
    /辅助推理|Worker/,
  );
  assert.equal(backend.calls.length, 0);
});

test('adapter modality, missing resources and plugin unload narrow choices without changing saved selections', async (t) => {
  const app = await setup(t);
  app.plugins.add({
    manifest: {
      id: 'selectionfixture',
      name: 'Fixture',
      description: '',
      version: '1',
      dependencies: [],
      permissions: ['inference.contribute', 'inference.provide'],
      settings: [],
    },
    activate: (ctx) => {
      ctx.capabilities.provide(
        'core.inference.adapters@1',
        'selectionfixture.text',
        'Text',
        () => ({
          id: 'selectionfixture.text',
          label: 'Text',
          family: 'api',
          engine: 'api',
          connectionSchema: z.toJSONSchema(z.object({}).strict()),
          modelSchema: z.toJSONSchema(z.object({}).strict()),
          connectionFields: [],
          modelFields: [],
          generation: ['text'],
          embedding: [],
          generationProvider: 'selectionfixture.generate',
        }),
      );
      ctx.capabilities.provide(
        'core.inference.generate@1',
        'selectionfixture.generate',
        'Fixture',
        () => ({ text: 'Fixture' }),
      );
      ctx.capabilities.provide(
        'core.inference.tasks@1',
        'selectionfixture.query',
        'Custom query',
        () => ({
          id: 'selectionfixture.query',
          label: 'Custom query',
          scope: 'shared',
          operation: 'generate',
          inputs: ['text'],
        }),
      );
    },
  });
  await app.plugins.enable('selectionfixture');
  await app.router.inference.refresh();
  app.store.put('connections', 'fixture', {
    id: 'fixture',
    name: 'Fixture',
    adapterId: 'selectionfixture.text',
    deployment: 'local',
    config: {},
  });
  app.store.put(
    'profiles',
    'overdeclared',
    modelProfileSchema.parse({
      id: 'overdeclared',
      name: 'Overdeclared',
      model: 'fixture',
      connectionId: 'fixture',
      generation: { enabled: true, inputs: ['text', 'image'] },
    }),
  );
  app.store.put(
    'profiles',
    'missing',
    modelProfileSchema.parse({
      id: 'missing',
      name: 'Missing',
      model: 'fixture',
      connectionId: 'missing-connection',
    }),
  );
  const before = app.router.profiles(),
    profile = before.find((p) => p.id === 'overdeclared');
  assert(modelEligible(profile, { taskId: 'selectionfixture.query' }));
  assert(!modelEligible(profile, { taskId: inferenceTasks.vision }));
  assert(!modelEligible(before.find((p) => p.id === 'missing')));
  assert(!modelEligible(profile, { taskId: 'unknown.task' }));
  assert(!modelEligible({ ...profile, eligibility: undefined }));
  const saved = app.store.document('profiles', 'overdeclared');
  await app.plugins.disable('selectionfixture');
  await app.router.inference.refresh();
  assert(
    !modelEligible(
      app.router.profiles().find((p) => p.id === 'overdeclared'),
      { taskId: 'selectionfixture.query' },
    ),
  );
  assert.deepEqual(app.store.document('profiles', 'overdeclared'), saved);
});

test('inherited vision defaults and invalid main models fail before enabling work or creating a partial role', async (t) => {
  const app = await setup(t);
  seedProfile(
    app,
    profileSchema.parse({ id: 'text-only', name: 'Text', kind: 'api', model: 'text' }),
  );
  const chat = conversation(app, { kind: 'main', personaId: 'companion' });
  app.store.saveBinding({
    conversationId: chat.id,
    profileId: 'text-only',
    epoch: 1,
    state: 'active',
  });
  app.store.put('characters', 'companion', {
    id: 'companion',
    revision: 1,
    features: ['memory', 'observation'],
    mainConversationId: chat.id,
    routes: {},
    taskIds: [],
    state: 'ready',
  });
  assert.throws(
    () =>
      app.observations.configure(
        observationConfigSchema.parse({ id: 'inherited', enabled: true, personaId: 'companion' }),
      ),
    /视觉模型/,
  );
  assert(!app.observations.configurations().some((row) => row.id === 'inherited'));
  const options = await app.registry.call('inference.options', {}, internal);
  assert.equal(options.defaults.companion.main, 'text-only');
  const vector = modelProfileSchema.parse({
    id: 'vector',
    name: 'Vector',
    model: 'vectors',
    connectionId: 'text-only',
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'] },
  });
  app.store.put('profiles', 'vector', vector);
  await assert.rejects(
    app.registry.call(
      'persona.character.commit',
      {
        requestId: 'invalid-main',
        draft: characterDraft.parse({
          persona: { id: 'invalid', name: 'Invalid', prompt: 'Fixture' },
          profileId: 'vector',
        }),
      },
      internal,
    ),
    /主会话/,
  );
  assert(!app.store.document('personas', 'invalid'));
  assert(!app.store.document('characters', 'invalid'));
});
