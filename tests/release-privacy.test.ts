import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.ts';
import { auditReleaseTree } from '../scripts/release-privacy.ts';

test('release privacy checks reject runtime data and synthetic private-role text without echoing the content', async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, 'credentials'));
  await writeFile(join(root, 'credentials', 'fixture'), 'synthetic');
  await assert.rejects(auditReleaseTree(root), /runtime\/private data path/);
  const clean = await temporary(t);
  await writeFile(join(clean, 'README.md'), 'Public example');
  assert.equal((await auditReleaseTree(clean)).findings, 0);
  await writeFile(
    join(clean, 'profile.json'),
    JSON.stringify({ name: 'PRIVATE_ROLE_CANARY', prompt: 'not public' }),
  );
  await assert.rejects(
    auditReleaseTree(clean, { names: ['PRIVATE_ROLE_CANARY'], text: [], assets: new Set() }),
    (error) => {
      assert.match(String(error), /private character content/);
      assert(!String(error).includes('PRIVATE_ROLE_CANARY'));
      return true;
    },
  );
});

test('public audit refuses excluded names, compiled identifiers, renamed databases and unapproved media', async (t) => {
  const cases: [string, string | Buffer, RegExp][] = [
    ['fixture-extension.js', 'export {};', /excluded release content in path/],
    ['workbench.js', 'const bundled = "fixture-extension";', /excluded release content/],
    ['launcher.exe', Buffer.concat([Buffer.from([0]), Buffer.from('fixture-extension', 'utf16le')]), /in executable/],
    ['cache.bin', Buffer.from('SQLite format 3\0'), /embedded database/],
    ['library.enl', 'synthetic data', /runtime\/private data path/],
    ['example.webp', 'unapproved image', /unapproved public media asset/],
    ['extra.zip', 'uninspected archive', /unapproved embedded archive/],
  ];
  for (const [file, body, reason] of cases) {
    const root = await temporary(t);
    await writeFile(join(root, file), body);
    await assert.rejects(
      auditReleaseTree(root, undefined, { forbidden: /fixture-extension/i, approvedAssets: new Set() }),
      reason,
    );
  }
});
