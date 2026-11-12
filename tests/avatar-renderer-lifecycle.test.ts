import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, until } from './helpers.ts';
import { NativeAvatar } from '../plugins/avatar/native.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { internal } from '../packages/kernel/registry.ts';
test('renderer libraries extend the base avatar and unloading restores frames without changing role configuration', async (t) => {
  const resolved: any[] = [];
  t.mock.method(NativeAvatar.prototype as any, 'configure', async function (this: NativeAvatar) {
    if (this.personaId === 'fixture-role') resolved.push(await this.renderer?.());
  });
  const app = await setup(t);
  await app.plugins.enable('avatar');
  app.plugins.add({
    manifest: {
      id: 'fixture-renderer',
      name: 'Fixture Renderer',
      description: 'Synthetic rendering extension',
      version: '1',
      dependencies: ['avatar'],
      permissions: ['avatar.renderer'],
      settings: [],
    },
    activate: (ctx) => {
      ctx.capabilities.provide('avatar.renderers@2', 'fixture-renderer.native', 'Fixture', () => ({
        kind: 'fixture',
        directory: app.runtime,
        library: app.runtime + '/fixture.dll',
        abi: 1,
        clips: ['idle', 'walk'],
        stateClips: { 'avatar.working': 'walk' },
      }));
    },
  });
  await app.plugins.enable('fixture-renderer');
  const call = (name: string, value: any) => app.registry.call(name, value, internal);
  await call('persona.character.commit', {
    requestId: 'renderer-role',
    draft: characterDraft.parse({
      persona: { id: 'fixture-role', name: 'Fixture', prompt: 'Synthetic' },
      features: ['avatar'],
      configurations: { avatar: { enabled: true, renderer: 'fixture-renderer.native' } },
    }),
  });
  await until(() => resolved.at(-1)?.abi === 1);
  const before = await call('avatar.profile', { personaId: 'fixture-role' });
  const info = await call('avatar.rendererInfo', {
    renderer: 'fixture-renderer.native',
    personaId: 'fixture-role',
  });
  assert.deepEqual(info.clips, ['idle', 'walk']);
  assert.equal(resolved.at(-1).executable, undefined);
  await app.plugins.disable('fixture-renderer');
  await until(() => resolved.at(-1)?.kind === 'frames');
  assert.match(resolved.at(-1).issue, /不可用/);
  assert.deepEqual(await call('avatar.rendererInfo', { renderer: 'fixture-renderer.native' }), {
    clips: [],
    stateClips: {},
  });
  const role = await call('persona.character.read', { id: 'fixture-role' });
  assert.equal(role.configurations.avatar.renderer, 'fixture-renderer.native');
  if (before) assert.deepEqual(await call('avatar.profile', { personaId: 'fixture-role' }), before);
  await app.plugins.enable('fixture-renderer');
  await until(() => resolved.at(-1)?.abi === 1);
  assert.equal(resolved.at(-1).kind, 'fixture');
});
