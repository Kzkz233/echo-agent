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
