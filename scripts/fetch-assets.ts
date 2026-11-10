import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
const url = 'https://opengameart.org/sites/default/files/CuteGirlFiles.zip';
const expected = 'facd021364fba2cfb25c21172ce890aea1bedbebab437be51c4426ee0dc9257d';
const response = await fetch(url);
if (!response.ok) throw Error('Asset download failed: ' + response.status);
const archive = Buffer.from(await response.arrayBuffer());
const hash = createHash('sha256').update(archive).digest('hex');
if (hash !== expected)
  throw Error(
    'Upstream archive changed. Inspect license and content before updating its approved hash.',
  );
const files = unzipSync(archive);
const input: any[] = [];
const manifest: any = {
  format: 'frame-atlas-v1',
  image: 'atlas.png',
  author: 'pzUH',
  license: 'CC0-1.0',
  source: 'https://opengameart.org/content/cute-girl-free-sprites',
  archive_sha256: hash,
  clips: {},
};
let index = 0;
for (const clip of ['idle', 'walk', 'jump']) {
  const entries = Object.keys(files)
    .filter((name) => new RegExp(`(?:^|/)${clip} \\(\\d+\\)\\.png$`, 'i').test(name))
    .sort((a, b) => Number(a.match(/\((\d+)\)/)![1]) - Number(b.match(/\((\d+)\)/)![1]));
  if (!entries.length) throw Error('Missing animation ' + clip);
  const frames = [];
  for (const name of entries) {
    const data = Buffer.from(files[name]);
    const image = await sharp(data)
      .resize(238, 260, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const x = (index % 8) * 256,
      y = Math.floor(index / 8) * 280;
    input.push({ input: image, left: x, top: y });
    frames.push({
      x,
      y,
      w: 238,
      h: 260,
      source_file: name,
      source_sha256: createHash('sha256').update(data).digest('hex'),
    });
    index++;
  }
  manifest.clips[clip] = { fps: clip === 'idle' ? 10 : 12, frames };
}
const atlas = await sharp({
  create: {
    width: 2048,
    height: Math.ceil(index / 8) * 280,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(input)
  .png()
  .toBuffer();
manifest.atlas_sha256 = createHash('sha256').update(atlas).digest('hex');
const directory = 'apps/workbench/public/assets/cute-girl';
await mkdir(directory, { recursive: true });
await writeFile(directory + '/atlas.png', atlas);
await writeFile(directory + '/manifest.json', JSON.stringify(manifest, null, 2));
console.log(`Prepared ${index} licensed animation frames.`);
