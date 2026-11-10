import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { setup, project, until } from './helpers.ts';
import { NativeAvatar } from '../plugins/avatar/native.ts';
import { displayAvatar, roleAvatar } from '../plugins/avatar/profiles.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { internal } from '../packages/kernel/registry.ts';

test('multiple characters retain independent avatar settings and native lifecycles', async (t) => {
  const instances = new Map<string, NativeAvatar>(),
    stopped: string[] = [];
  t.mock.method(NativeAvatar.prototype as any, 'configure', async function (this: NativeAvatar) {
    if (displayAvatar(this.store, this.personaId).enabled) instances.set(this.personaId!, this);
  });
  t.mock.method(NativeAvatar.prototype, 'stop', async function (this: NativeAvatar) {
    stopped.push(this.personaId!);
    instances.delete(this.personaId!);
  });
  const app = await setup(t);
  await app.plugins.enable('avatar');
  const call = (name: string, value: any) => app.registry.call(name, value, internal);
  for (const [i, id] of ['first', 'second', 'third'].entries())
    await call('persona.character.commit', {
      requestId: id,
      draft: characterDraft.parse({
        persona: { id, name: id, prompt: 'Synthetic' },
        features: ['avatar'],
        configurations: { avatar: { enabled: true, scale: 0.7 + i / 10 } },
      }),
    });
  await until(() => instances.size === 3);
  assert.equal(new Set([...instances.values()].map((n) => n.slot)).size, 3);
  assert.deepEqual(
    ['first', 'second', 'third'].map((id) => roleAvatar(app.store, id).enabled),
    [true, true, true],
  );
  const original = instances.get('first');
  await call('avatar.configureRole', { personaId: 'second', patch: { enabled: false } });
  await until(() => instances.size === 2);
  assert.equal(instances.get('first'), original);
  assert(instances.has('third'));
  assert.equal(roleAvatar(app.store, 'first').scale, 0.7);
  await call('avatar.configureRole', { personaId: 'second', patch: { enabled: true } });
  await until(() => instances.size === 3);
  assert.notEqual(instances.get('second'), original);
  await call('avatar.setVisible', {visible:false});assert.equal(instances.size,0);
  assert.equal(roleAvatar(app.store,'first').enabled,true);
  assert.equal(roleAvatar(app.store,'second').enabled,true);
  await call('avatar.setVisible', {visible:true});await until(()=>instances.size===3);
  await app.plugins.disable('avatar');
  assert.equal(instances.size, 0);
  const count = stopped.length;
  app.events.emit('characters.updated', { personaId: 'first' });
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped.length, count);
});

test('every advertised starter animation frame contains visible artwork', async () => {
  for (const name of ['hina', 'miyu']) {
    const root = join(project, 'apps/workbench/public/assets/starter-characters', name);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    const { data, info } = await sharp(join(root, manifest.image))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(manifest.clips.idle.frames.length, 7);
    assert.equal(manifest.clips.waving.frames.length, 4);
    for (const [clip, value] of Object.entries<any>(manifest.clips))
      for (const [index, frame] of value.frames.entries()) {
        let alpha = 0;
        for (let y = frame.y; y < frame.y + frame.h; y++)
          for (let x = frame.x; x < frame.x + frame.w; x++)
            alpha += data[(y * info.width + x) * 4 + 3];
        assert(alpha > 0, `${name}/${clip}/${index} is a transparent padding cell`);
      }
  }
});
