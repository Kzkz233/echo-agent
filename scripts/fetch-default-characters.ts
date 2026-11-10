import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const revision = '6e8ca988a6b3db007cc74e5f0ab62aca5a801131';
const repository = 'https://github.com/springtiger07/codex-chibi-girl-pets';
const upstream = `https://raw.githubusercontent.com/springtiger07/codex-chibi-girl-pets/${revision}`;
const root = resolve(import.meta.dirname, '../apps/workbench/public/assets/starter-characters');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const roles = [
  {
    id: 'hina',
    name: 'Hina',
    sha256: '092f7bf6ee6d2df24ae4995e172cc3249b17c03db1ba9081ebce5cf2d797a922',
  },
  {
    id: 'miyu',
    name: 'Miyu',
    sha256: 'bec59029a3da3efdb9ba4eaefdf71c6590caf2cf182af5578a148bc63d1fd1ce',
  },
];
async function download(path: string) {
  const response = await fetch(`${upstream}/${path}`);
  if (!response.ok) throw Error(`Asset HTTP ${response.status}: ${path}`);
  return Buffer.from(await response.arrayBuffer());
}
await mkdir(root, { recursive: true });
for (const [source, target] of [
  ['LICENSE.md', 'UPSTREAM-LICENSE.md'],
  ['LICENSES/CC-BY-4.0.md', 'LICENSE-ASSETS.md'],
  ['LICENSES/MIT.txt', 'LICENSE-PACKAGE.txt'],
])
  await writeFile(join(root, target), await download(source));
const clips = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
];
for (const role of roles) {
  const folder = join(root, role.id);
  await mkdir(folder, { recursive: true });
  const original = await download(`${role.name}/spritesheet.webp`);
  if (hash(original) !== role.sha256) throw Error(`Upstream hash mismatch: ${role.name}`);
  const metadata = await sharp(original).metadata();
  if (metadata.width !== 1536 || metadata.height !== 2288 || !metadata.hasAlpha)
    throw Error(`Unexpected atlas: ${role.name}`);
  await writeFile(join(folder, 'spritesheet.webp'), original);
  await writeFile(join(folder, 'pet.json'), await download(`${role.name}/pet.json`));
  const atlas = await sharp(original).png().toBuffer();
  await writeFile(join(folder, 'atlas.png'), atlas);
  const preview = await sharp(original)
    .extract({ left: 0, top: 0, width: 192, height: 208 })
    .png()
    .toBuffer();
  await writeFile(join(folder, 'preview.png'), preview);
  await writeFile(
    join(folder, 'portrait.webp'),
    await sharp(preview)
      .extract({ left: 28, top: 0, width: 140, height: 140 })
      .resize(256, 256)
      .webp({ quality: 90 })
      .toBuffer(),
  );
  const manifest = {
    format: 'frame-atlas-v1',
    image: 'atlas.png',
    name: role.name,
    author: 'Ryu JaeHyun',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    source: `${repository}/tree/${revision}/${role.name}`,
    sourceFormat: 'codex-sprite-v2',
    revision,
    source_sha256: role.sha256,
    atlas_sha256: hash(atlas),
    modifications:
      'Lossless PNG conversion, named animation mapping with trailing empty cells excluded, idle-frame preview and cropped/resized portrait. Original WebP included.',
    clips: Object.fromEntries(await Promise.all(
      clips.map(async (name, row) => {
        const frames=Array.from({length:8},(_,column)=>({x:column*192,y:row*208,w:192,h:208}));
        while(frames.length){
          const frame=frames.at(-1)!;
          const pixels=await sharp(original).extract({left:frame.x,top:frame.y,width:frame.w,height:frame.h}).ensureAlpha().raw().toBuffer();
          let opaque=false;for(let i=3;i<pixels.length;i+=4)if(pixels[i]){opaque=true;break;}
          if(opaque)break;frames.pop();
        }
        if(!frames.length)throw Error(`Empty animation: ${role.id}/${name}`);
        return [
        name,
        {
          fps: 8,
          frames,
        },
      ];}),
    )),
  };
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
await writeFile(
  join(root, 'CREDITS.txt'),
  roles
    .map(
      (role) =>
        `${role.name} Codex Pet by Ryu JaeHyun. Visual artwork: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).\nSource: ${repository}/tree/${revision}/${role.name}\nEcho adaptation: lossless PNG conversion, named animation mapping, idle-frame preview and cropped/resized portrait. Original artwork and character names retained. No endorsement implied.`,
    )
    .join('\n\n') + '\n',
);
console.log(
  JSON.stringify({
    characters: roles.map((role) => role.name),
    revision,
    license: 'CC-BY-4.0',
    root,
  }),
);
