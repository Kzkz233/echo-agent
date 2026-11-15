import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// The public vector sources also drive the UI masks. Do not redraw the symbol
// separately for desktop, browser or installer assets.
const root = resolve(import.meta.dirname, '..');
const brand = join(root, 'apps/workbench/public/brand');
const icons = join(root, 'apps/desktop/icons');
const master = await readFile(join(brand, 'echo-mark.svg'), 'utf8');
const small = await readFile(join(brand, 'echo-mark-small.svg'), 'utf8');
const group = (svg: string) => svg.slice(svg.indexOf('<g '), svg.lastIndexOf('</svg>'));
function tile(source: string) {
  // Center the actual silhouette with a small optical offset, keeping its
  // internal geometry intact and a 76% silhouette height inside the tile.
  const scale = 780 / (678.1 - 35.8);
  const x = 522 - (26.9 + 649) / 2 * scale;
  const y = 518 - (35.8 + 678.1) / 2 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>Echo</title><rect width="1024" height="1024" rx="224" fill="#242931"/><g transform="translate(${x} ${y}) scale(${scale})">${group(source).replace('fill="#000000"', 'fill="#ffffff"')}</g></svg>`;
}
await mkdir(icons, { recursive: true });
const mainTile = tile(master), smallTile = tile(small);
await writeFile(join(brand, 'echo-app.svg'), mainTile);
await sharp(Buffer.from(mainTile)).resize(256, 256).png().toFile(join(icons, 'icon.png'));
await sharp(Buffer.from(smallTile)).resize(32, 32).png().toFile(join(icons, 'tray.png'));
const frames = await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async size => ({
  size,
  png: await sharp(Buffer.from(size <= 24 ? smallTile : mainTile)).resize(size, size).png().toBuffer(),
})));
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (const [index, { size, png }] of frames.entries()) {
  const start = 6 + index * 16;
  header[start] = header[start + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, start + 4);
  header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(png.length, start + 8);
  header.writeUInt32LE(offset, start + 12);
  offset += png.length;
}
const ico = Buffer.concat([header, ...frames.map(frame => frame.png)]);
await writeFile(join(icons, 'icon.ico'), ico);
await writeFile(join(brand, 'favicon.ico'), ico);
console.log('Generated Echo desktop, tray and browser icons from the shared brand vectors.');
