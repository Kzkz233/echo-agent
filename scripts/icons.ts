import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#655284"/><stop offset="1" stop-color="#242436"/></linearGradient></defs><rect x="8" y="8" width="240" height="240" rx="64" fill="url(#g)"/><rect x="8" y="8" width="240" height="240" rx="64" fill="none" stroke="#b5a1e3" stroke-width="5"/><text x="74" y="191" fill="#eee4ff" font-family="Georgia" font-style="italic" font-size="210">e</text></svg>',
);
const png = await sharp(svg).png().toBuffer();
await mkdir('apps/desktop/icons', { recursive: true });
await writeFile('apps/desktop/icons/icon.png', png);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await writeFile('apps/desktop/icons/icon.ico', Buffer.concat([header, png]));
