import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionForPurpose, modelDisplayName, connectionDeployment } from '../packages/contracts/model-services.ts';
import {
  adapterSchema,
  connectionSchema,
  modelProfileSchema,
} from '../packages/contracts/inference.ts';
import { setup } from './helpers.ts';
import { ensureBundledEmbedding } from '../apps/server/bundled-models.ts';

test('adapter classification corrects legacy API harness labels without replacing connection settings', async t => {
  const app = await setup(t, []);
  const legacy = connectionSchema.parse({ id: 'legacy', name: 'Synthetic provider',
    adapterId: 'core.pi', deployment: 'harness', config: { endpoint: 'https://example.invalid/v1', apiKeyRef: 'fixture-key' } });
  app.store.put('connections', legacy.id, legacy);
  const projected = app.router.inference.connections().find(connection => connection.id === legacy.id)!;
  assert.equal(projected.deployment, 'cloud');
  assert.deepEqual(projected.config, legacy.config);
  assert.deepEqual(app.store.document('connections', legacy.id), legacy);
  const saved = await app.router.inference.saveConnection(legacy);
  assert.equal(saved.deployment, 'cloud');
  assert.equal(saved.config.apiKeyRef, 'fixture-key');
  assert.equal(connectionDeployment({ ...legacy, config: { endpoint: 'http://127.0.0.1:8000/v1' } }, { family: 'api' }), 'local');
  assert.equal(connectionDeployment({ ...legacy, deployment: 'remote' }, { family: 'api' }), 'remote');
  assert.equal(connectionDeployment({ ...legacy, deployment: 'cloud' }, { family: 'harness' }), 'harness');
});
test('new and legacy model services do not leak empty connections into unrelated model pages', () => {
  assert.equal(
    modelDisplayName({ name: 'Local model', model: 'C:\\models\\weights.gguf' }),
    'Local model',
  );
  const adapter = adapterSchema.parse({
    id: 'example',
    engine: 'example',
    label: 'Example',
    family: 'api',
    connectionSchema: {},
    modelSchema: {},
    connectionFields: [],
    modelFields: [],
    generation: ['text', 'image'],
    embedding: ['text'],
  });
  const language = connectionSchema.parse({
    id: 'language',
    name: 'Language',
    adapterId: adapter.id,
    purposes: ['generation'],
  });
  const vector = connectionSchema.parse({
    id: 'vector',
    name: 'Vector',
    adapterId: adapter.id,
    purposes: ['embedding'],
  });
  assert(connectionForPurpose(language, adapter, [], 'generation'));
  assert(!connectionForPurpose(language, adapter, [], 'embedding'));
  assert(connectionForPurpose(vector, adapter, [], 'embedding'));
  assert(!connectionForPurpose(vector, adapter, [], 'generation'));
  const legacy = { ...language, purposes: undefined };
  assert(!connectionForPurpose(legacy, adapter, [], 'embedding'));
  const embedding = modelProfileSchema.parse({
    id: 'embedding',
    name: 'Embedding',
    connectionId: language.id,
    generation: { enabled: false },
    embedding: { enabled: true },
  });
  assert(
    connectionForPurpose(language, adapter, [embedding], 'embedding'),
    'a deliberately shared connection can serve both purposes',
  );
  assert(connectionForPurpose(legacy, adapter, [embedding], 'embedding'));
  assert(!connectionForPurpose(legacy, adapter, [embedding], 'generation'));
});
test('starter setup reuses an existing local BGE directory instead of creating a duplicate', async (t) => {
  const app = await setup(t, ['local-models']);
  await app.router.inference.refresh();
  await app.router.inference.saveConnection({
    id: 'existing-local',
    name: 'Local',
    adapterId: 'local-models.onnx',
    deployment: 'local',
    config: {},
  });
  await app.router.inference.saveModel({
    id: 'existing-vector',
    name: 'Existing BGE',
    connectionId: 'existing-local',
    model: 'C:\\models\\Xenova\\bge-small-zh-v1.5',
    generation: { enabled: false },
    embedding: { enabled: true, dimensions: 512 },
  });
  assert.equal(await ensureBundledEmbedding(app), 'existing-vector');
  assert(!app.router.inference.models().some((m) => m.id === 'echo-bge-small-zh'));
});
