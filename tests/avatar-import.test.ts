import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import { setup } from './helpers.ts';
const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
test('PetDex trims transparent row padding while retaining authored interior gaps', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('avatar');
  const dir = join(app.runtime, 'padded-pet');
  await mkdir(dir);
  await writeFile(join(dir, 'pet.json'), JSON.stringify({ name: 'Padded fixture' }));
  const red = await sharp({ create: { width: 192, height: 936, channels: 4, background: '#f00' } })
    .png()
    .toBuffer();
  await writeFile(
    join(dir, 'spritesheet.png'),
    await sharp({ create: { width: 768, height: 936, channels: 4, background: '#0000' } })
      .composite([
        { input: red, left: 0, top: 0 },
        { input: red, left: 384, top: 0 },
      ])
      .png()
      .toBuffer(),
  );
  const asset = await app.registry.call(
    'avatar.import',
    { source: dir, requestId: 'padded-pet' },
    ui,
  );
  const manifest = JSON.parse(await readFile(join(asset.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.clips.idle.frames.length, 6);
  assert.equal(
    manifest.clips.idle.frames[2].x,
    192,
    'The intentional interior gap retains its time slot',
  );
  assert.equal(manifest.clips.waving.frames.length, 6);
});
test('PetDex JSON and WebP grid imports preserve animation rows and original metadata', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('avatar');
  const dir = join(app.runtime, 'petdex');
  await mkdir(dir);
  await writeFile(
    join(dir, 'pet.json'),
    JSON.stringify({ name: 'Synthetic sprite', author: 'Fixture', license: 'CC0' }),
  );
  await writeFile(
    join(dir, 'spritesheet.webp'),
    await sharp({ create: { width: 768, height: 936, channels: 4, background: '#ff0000' } })
      .webp()
      .toBuffer(),
  );
  const asset = await app.registry.call(
    'avatar.import',
    { source: join(dir, 'pet.json'), requestId: 'petdex' },
    ui,
  );
  const manifest = JSON.parse(await readFile(join(asset.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.clips['running-left'].frames.length, 8);
  assert.equal(manifest.clips.review.frames[0].y, 832);
  assert.equal(manifest.author, 'Fixture');
  assert(
    (await readFile(join(asset.directory, 'original', 'pet.json'), 'utf8')).includes(
      'Synthetic sprite',
    ),
  );
});

test('avatar imports an image and a naturally ordered PNG sequence into private managed assets', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('avatar');
  const frames = join(app.runtime, 'frames');
  await mkdir(frames);
  const image = await sharp({
    create: { width: 32, height: 40, channels: 4, background: '#ff000080' },
  })
    .png()
    .toBuffer();
  const single = join(app.runtime, 'character.png');
  await writeFile(single, image);
  const first = await app.registry.call('avatar.import', { source: single, requestId: 'one' }, ui);
  assert.equal(first.frames, 1);
  assert.equal(first.fps, 1);
  assert.match(first.preview, /^data:image\/png;base64,/);
  assert.equal(
    (await app.registry.call('avatar.import', { source: single, requestId: 'one' }, ui)).id,
    first.id,
  );
  for (const name of ['Idle 10.png', 'Idle 2.png', 'Idle 1.png'])
    await writeFile(join(frames, name), image);
  const second = await app.registry.call(
    'avatar.import',
    { source: frames, fps: 12, requestId: 'two' },
    ui,
  );
  assert.equal(second.frames, 3);
  assert.equal(second.fps, 12);
  const manifest = JSON.parse(await readFile(join(second.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.clips.idle.frames.length, 3);
  assert.equal(
    app.store.get<any>('avatar.config', {}).assetDirectory,
    undefined,
    'Import does not change the active avatar',
  );
  assert.equal((await app.registry.call('avatar.assets', {}, ui)).length, 2);
});

test('avatar rejects traversal archives and malformed atlas rectangles without changing active assets', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('avatar');
  const archive = join(app.runtime, 'bad.zip');
  await writeFile(archive, zipSync({ '../outside.png': new Uint8Array([1, 2, 3]) }));
  await assert.rejects(
    app.registry.call('avatar.import', { source: archive, requestId: 'bad' }, ui),
    /越界/,
  );
  const dir = join(app.runtime, 'atlas');
  await mkdir(dir);
  await writeFile(
    join(dir, 'atlas.png'),
    await sharp({ create: { width: 32, height: 32, channels: 4, background: '#00000000' } })
      .png()
      .toBuffer(),
  );
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      format: 'frame-atlas-v1',
      clips: { idle: { fps: 10, frames: [{ x: 20, y: 20, w: 20, h: 20 }] } },
    }),
  );
  await assert.rejects(
    app.registry.call('avatar.import', { source: dir, requestId: 'invalid' }, ui),
    /超出图集/,
  );
  assert.equal((await app.registry.call('avatar.assets', {}, ui)).length, 0);
});
