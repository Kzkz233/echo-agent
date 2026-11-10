import test from 'node:test';
import assert from 'node:assert/strict';
import { echoToolPermissions, migrateRoleToolGrants } from '../packages/kernel/tool-access.ts';
import { observationConfigSchema } from '../packages/contracts/index.ts';
import { conversation, setup } from './helpers.ts';

test('migration preserves effective grants and lets explicit worker grants diverge from main', async (t) => {
  const app = await setup(t, []);
  const personaId = 'fixture';
  const main = conversation(app, { personaId, kind: 'main' });
  const worker = conversation(app, { personaId, kind: 'worker', permissions: { echoTools: ['memory.write', 'memory.read'] } });
  app.store.set('mcp.permissions', ['memory.read']);
  app.store.put('characters', personaId, { id: personaId, toolPermissions: ['memory.read', 'memory.write'] });
  app.store.put('character-settings.delegation', personaId, { authorizationVersion: 3, toolPermissions: ['memory.write', 'memory.read'] });
  const active = new Set(['memory.read', 'memory.write']);
  const grants = (conversationId: string) => [...echoToolPermissions(app.store, false, { personaId, conversationId }, active)];
  assert.deepEqual(grants(main.id), ['memory.read']);
  assert.deepEqual(grants(worker.id), ['memory.read']);
  migrateRoleToolGrants(app.store, active);
  assert.deepEqual(grants(main.id), ['memory.read']);
  assert.deepEqual(grants(worker.id), ['memory.read']);
  app.store.put('character-settings.delegation', personaId, { authorizationVersion: 3, toolPermissions: ['memory.write'] });
  assert.deepEqual(grants(worker.id), [], 'the existing task cannot acquire a newly granted tool');
  const next = conversation(app, { personaId, kind: 'worker', permissions: { echoTools: ['memory.write'] } });
  assert.deepEqual(grants(next.id), ['memory.write']);
  assert.deepEqual(grants(main.id), ['memory.read']);
});

test('application limits and character grants intersect and scoped tools cannot read another character', async (t) => {
  const app = await setup(t);
  for (const id of ['persona', 'memory', 'observation', 'knowledge'])
    await app.plugins.enable(id);

  for (const id of ['companion', 'other']) {
    app.store.put('personas', id, { id, name: id, prompt: '' });
    app.store.put('characters', id, {
      id,
      features: [],
      toolPermissions: id === 'companion' ? ['memory.read', 'persona.read'] : [],
    });
  }
  const chat = conversation(app, { id: 'permission-chat', personaId: 'companion' });
  app.store.set('mcp.permissions', [
    'memory.read',
    'memory.write',
    'persona.read',
    'knowledge.read',
    'observation.read',
  ]);
  const principal = { conversationId: chat.id, personaId: 'companion' };
  const caller = {
    kind: 'mcp' as const,
    permissions: echoToolPermissions(
      app.store,
      false,
      principal,
      app.plugins.characterPermissions(),
    ),
    ...principal,
  };
  const names = new Set(app.registry.list(caller, true).map((operation) => operation.name));
  assert(names.has('memory.list'));
  assert(names.has('persona.list'));
  assert(!names.has('memory.save'), 'application-open write still needs a character grant');
  assert(!names.has('knowledge.search'), 'another character capability is not implicitly granted');
  assert(!names.has('observation.status'));

  app.store.put('memories', 'mine', {
    id: 'mine', personaId: 'companion', title: 'Mine', text: 'A private test memory',
  });
  app.store.put('memories', 'theirs', {
    id: 'theirs', personaId: 'other', title: 'Theirs', text: 'Another private test memory',
  });
  const own = await app.registry.call('memory.list', {}, caller);
  assert.deepEqual(own.map((memory: any) => memory.id), ['mine']);
  await assert.rejects(
    app.registry.call('memory.list', { personaId: 'other' }, caller),
    /角色只能读取自己的记忆/,
  );
  const personas = await app.registry.call('persona.list', {}, caller);
  assert.deepEqual(personas.map((persona: any) => persona.id), ['companion']);
});

test('observation status only returns tasks and records belonging to its trusted character', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('observation');
  for (const id of ['companion', 'other'])
    app.store.put('personas', id, { id, name: id, prompt: '' });
  app.store.put('characters', 'companion', {
    id: 'companion', features: [], toolPermissions: ['observation.read'],
  });
  app.store.put('characters', 'other', {
    id: 'other', features: [], toolPermissions: ['observation.read'],
  });
  conversation(app, { id: 'permission-chat', personaId: 'companion' });
  const own = observationConfigSchema.parse({ id: 'own-observation', personaId: 'companion' });
  const other = observationConfigSchema.parse({ id: 'other-observation', personaId: 'other' });
  await app.observations.configure(own);
  await app.observations.configure(other);
  for (const [id, personaId, taskId] of [
    ['own-record', 'companion', own.id],
    ['other-record', 'other', other.id],
  ])
    await app.observations.record({
      id,
      taskId,
      personaId,
      conversationId: 'permission-observation-' + id,
      timestamp: new Date().toISOString(),
      frameTimes: [],
      sources: ['synthetic'],
      summary: id,
      interesting: false,
    });
  const appPermissions = ['observation.read'];
  app.store.set('mcp.permissions', appPermissions);
  const caller = {
    kind: 'mcp' as const,
    permissions: echoToolPermissions(
      app.store,
      false,
      { conversationId: 'permission-chat', personaId: 'companion' },
      app.plugins.characterPermissions(),
    ),
    conversationId: 'permission-chat',
    personaId: 'companion',
  };
  const result = await app.registry.call('observation.status', {}, caller);
  assert.deepEqual(result.tasks.map((task: any) => task.id), [own.id]);
  assert.deepEqual(result.recent.map((row: any) => row.id), ['own-record']);
});
