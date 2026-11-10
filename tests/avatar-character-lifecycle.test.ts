import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, until } from './helpers.ts';
import { NativeAvatar } from '../plugins/avatar/native.ts';
import { displayAvatar } from '../plugins/avatar/profiles.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { internal } from '../packages/kernel/registry.ts';

test('avatar resumes after character creation and editing without rewriting its settings', async (t) => {
  const applied: { enabled: boolean; state?: string }[] = [];
  // Keep real plugin subscriptions and the serialized native update queue, but never
  // open a desktop window during this lifecycle test.
  t.mock.method(NativeAvatar.prototype as any, 'configure', async function (this: NativeAvatar) {
    const config = displayAvatar(this.store, this.personaId);
    applied.push({
      enabled: config.enabled,
      state: config.personaId
        ? this.store.document<any>('characters', config.personaId)?.state
        : undefined,
    });
  });
  t.mock.method(NativeAvatar.prototype, 'stop', async function (this: NativeAvatar) {
    const config = displayAvatar(this.store, this.personaId);
    applied.push({
      enabled: false,
      state: config.personaId
        ? this.store.document<any>('characters', config.personaId)?.state
        : undefined,
    });
  });
  const app = await setup(t);
  await app.plugins.enable('avatar');
  const call = (method: string, params: any) => app.registry.call(method, params, internal);
  const role = await call('persona.character.commit', {
    requestId: 'create-avatar-role',
    draft: characterDraft.parse({
      persona: { id: 'fixture-owner', name: 'Fixture', prompt: 'Original' },
      features: ['avatar'],
      configurations: { avatar: { enabled: true } },
    }),
  });
  await until(() => applied.at(-1)?.enabled === true && applied.at(-1)?.state === 'ready', 1500);
  const config = app.store.get('avatar.config', {});
  applied.length = 0;
  await call('persona.character.commit', {
    requestId: 'edit-avatar-role',
    draft: { ...role, persona: { ...role.persona, prompt: 'Revised' } },
  });
  await until(() => applied.at(-1)?.enabled === true && applied.at(-1)?.state === 'ready', 1500);
  assert.deepEqual(app.store.get('avatar.config', {}), config);
  assert(applied.some((entry) => entry.state === 'configuring' && !entry.enabled));
  await call('persona.character.commit', {
    requestId: 'disable-avatar-role',
    draft: { ...(await call('persona.character.read', { id: role.persona.id })), features: [] },
  });
  await until(() => applied.at(-1)?.state === 'ready' && !applied.at(-1)?.enabled, 1500);
  await app.plugins.disable('avatar');
  const count = applied.length;
  app.events.emit('characters.updated', { personaId: role.persona.id });
  await new Promise((r) => setImmediate(r));
  assert.equal(applied.length, count, 'Unloaded avatar must not retain its role listener');
});
