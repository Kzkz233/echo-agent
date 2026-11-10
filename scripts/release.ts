import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditReleaseTree } from './release-privacy.ts';
import { createUpdatePackage } from './update-package.ts';

const root = resolve(import.meta.dirname, '..');
const policyPath = resolve(process.env.ECHO_RELEASE_POLICY ?? join(homedir(), '.echo', 'echo-release-policy.local.json'));
const policy = JSON.parse(await readFile(policyPath, 'utf8'));
if (await realpath(root) !== await realpath(policy.privateCheckout) ||
    (await realpath(policyPath)).toLowerCase().startsWith((await realpath(root)).toLowerCase() + sep))
  throw Error('Private release requires the configured private checkout and local policy outside it');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Unexpected release version');
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: 'inherit',
    shell: command === 'pnpm' && process.platform === 'win32', env: { ...process.env, ECHO_EDITION: 'private' } });
  if (result.error || result.status !== 0) throw Error('Private packaging failed: ' + (result.error?.message ?? command));
}
const parent = resolve(process.env.ECHO_RELEASE_DIR ?? join(root, 'dist', 'release', 'private'));
const output = join(parent, version);
if (await access(output).then(() => true, () => false)) throw Error('Private release output already exists for this version');
run('pnpm', ['run', 'desktop:build']);
await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, '.checking-'));
try {
  const files = join(scratch, 'files');
  const portable = join(scratch, 'Echo-' + version + '-private-win-x64');
  await mkdir(files);
  await mkdir(portable);
  await cp(join(root, 'apps/desktop/target/release/echo-desktop.exe'), join(portable, 'Echo.exe'));
  await cp(join(root, 'dist/echo-agent.cmd'), join(portable, 'echo-agent.cmd'));
  await cp(join(root, 'dist/runtime'), join(portable, 'runtime'), { recursive: true, dereference: true });
  for (const name of ['README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'])
    await cp(join(root, name), join(portable, name));
  await auditReleaseTree(portable);
  await createUpdatePackage(portable, join(files, 'Echo-' + version + '-private-win-x64.echo-update'));
  const archive = join(files, 'Echo-' + version + '-private-win-x64.zip');
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  run('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(' +
    quote(portable) + ',' + quote(archive) + ',[System.IO.Compression.CompressionLevel]::Optimal,$true)']);
  const installer = join(files, 'Echo-Agent_' + version + '_private_x64-setup.exe');
  await cp(join(root, 'apps/desktop/target/release/bundle/nsis', 'Echo Agent_' + version + '_x64-setup.exe'), installer);
  const unpacked = join(scratch, 'installer');
  run(policy.sevenZip, ['x', '-y', '-bd', '-bso0', '-bsp0', '-o' + unpacked, '--', installer]);
  await auditReleaseTree(unpacked);
  await writeFile(join(files, 'PRIVATE-BUILD.txt'), 'Local build for personal use. This directory is not a public release input.\n');
  await rename(files, output);
  console.log('Verified private artifacts: ' + output);
} finally {
  if (!scratch.startsWith(parent + sep + '.checking-')) throw Error('Unsafe private scratch path');
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
