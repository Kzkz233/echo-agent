import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildSchema } from '../packages/contracts/build.ts';
import { auditReleaseTree } from './release-privacy.ts';
import { createUpdatePackage } from './update-package.ts';

// CI artifact preparation. Publishing additionally applies release-public's local policy.
const root = resolve(import.meta.dirname, '..'),
  output = join(root, 'dist/release');
const info = buildSchema.parse(
  JSON.parse(await readFile(join(root, 'dist/runtime/dist/build-info.json'), 'utf8')),
);
if (info.edition !== 'public') throw Error('CI artifacts require a public build');
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(output, '.portable-'));
try {
  await cp(join(root, 'apps/desktop/target/release/echo-desktop.exe'), join(scratch, 'Echo.exe'));
  await cp(join(root, 'dist/runtime'), join(scratch, 'runtime'), {
    recursive: true,
    dereference: true,
  });
  await cp(join(root, 'dist/echo-agent.cmd'), join(scratch, 'echo-agent.cmd'));
  await auditReleaseTree(scratch);
  await createUpdatePackage(
    scratch,
    join(output, `Echo-${info.version}-public-win-x64.echo-update`),
  );
  await cp(
    join(
      root,
      'apps/desktop/target/release/bundle/nsis',
      `Echo Agent_${info.version}_x64-setup.exe`,
    ),
    join(output, `Echo-Agent_${info.version}_x64-setup.exe`),
  );
  console.log('Prepared public installer and update package.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
