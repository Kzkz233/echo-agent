import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect x="8" y="8" width="240" height="240" rx="48" fill="#242931"/><text x="128" y="188" fill="#ffffff" font-family="Segoe UI,sans-serif" font-weight="650" font-size="196" text-anchor="middle">e</text></svg>',
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
