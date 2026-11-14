import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { auditReleaseTree, privateReference } from './release-privacy.ts';
import { createUpdatePackage } from './update-package.ts';
import { fileInventory } from '../packages/kernel/update-files.ts';
import { availableSpace } from '../packages/kernel/update-transaction.ts';

const root = resolve(import.meta.dirname, '..');
const publicPlugins = new Set([
  'agenda', 'approvals', 'assets', 'asr', 'avatar', 'backup', 'care', 'channels', 'chatstick', 'delegation',
  'documents', 'embeddings', 'files', 'groups', 'knowledge', 'local-models', 'mail', 'mail-actions',
  'mail-triggers', 'memory', 'notifications', 'observation', 'persona', 'qq', 'reflections',
  'review', 'scheduler', 'semantic', 'worker-codex', 'worker-dsh',
]);
const policySchema = z.object({
  publicCheckout: z.string().refine(isAbsolute),
  privateRuntime: z.string().refine(isAbsolute),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  sevenZip: z.string().refine(isAbsolute),
  githubCli: z.string().refine(isAbsolute),
  excludedMarkers: z.array(z.string().trim().min(3)).min(1),
  approvedAssets: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
});
const phase = process.argv[2];
if (!['prepare', 'publish'].includes(phase) || process.argv.length !== 3) throw Error('Choose prepare or publish');
const policyPath = resolve(process.env.ECHO_RELEASE_POLICY ?? join(homedir(), '.echo', 'echo-release-policy.local.json'));
const policy = policySchema.parse(JSON.parse(await readFile(policyPath, 'utf8')));
const canonical = await realpath(root);
const inside = (path: string) => {
  const a = canonical.toLowerCase(), b = path.toLowerCase();
  return b === a || b.startsWith(a + sep);
};
if (canonical !== await realpath(policy.publicCheckout) || inside(await realpath(policyPath)) ||
    inside(await realpath(policy.privateRuntime))) throw Error('Public release requires the separate public checkout and local policy outside it');

function run(command: string, args: string[], inherit = false) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 20_000_000,
    stdio: inherit ? 'inherit' : 'pipe',
    shell: command === 'pnpm' && process.platform === 'win32',
    env: { ...process.env, ECHO_EDITION: 'public', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) throw Error(command + ' failed: ' + (result.error?.message ?? result.stderr ?? ''));
  return result.stdout?.trim() ?? '';
}
const git = (...args: string[]) => run('git', args);
const commit = git('rev-parse', 'HEAD');
const remoteHead = () => {
  const entry = git('ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/main');
  const match = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(entry);
  if (!match) throw Error('Cannot resolve the public main branch');
  return match[1];
};
function requireClean() {
  if (git('status', '--porcelain', '--untracked-files=all') || git('rev-parse', 'HEAD') !== commit ||
      git('rev-parse', '--show-prefix') || git('config', '--get', 'remote.origin.url').replace(/\.git$/, '') !==
      'https://github.com/' + policy.repository) throw Error('Public release requires the configured clean Git checkout');
}
requireClean();
const base = remoteHead();
git('merge-base', '--is-ancestor', base, commit);
const unpublished = git('rev-list', base + '..' + commit).split('\n').filter(Boolean);
const reference = await privateReference(policy.privateRuntime);
if (!reference.names.length || !reference.text.length || !reference.assets.size)
  throw Error('Public release requires a populated local private reference');
const escape = (value: string) => value.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
const forbidden = new RegExp(
  policy.excludedMarkers.map(value => value.length <= 4 ? '(?<![a-z0-9])' + escape(value) + '(?![a-z0-9])' : escape(value)).join('|'), 'i',
);
// Short ASCII words can appear by chance in native machine code.
const binaryMarkers = policy.excludedMarkers.filter(value => Buffer.byteLength(value) >= 5);
if (!binaryMarkers.length) throw Error('Public release requires full identifiers for native scanning');
const rules = {
  forbidden, forbiddenBinary: new RegExp(binaryMarkers.map(escape).join('|'), 'i'),
  approvedAssets: new Set(policy.approvedAssets),
};
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version as string;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid release version');
const tag = 'v' + version;
const source = 'Echo-' + version + '-source.zip';
const installer = 'Echo-Agent_' + version + '_x64-setup.exe';
const update = 'Echo-' + version + '-public-win-x64.echo-update';
const names = [source, installer, update];
const parent = resolve(process.env.ECHO_RELEASE_DIR ?? join(root, 'dist', 'release', 'public'));
const destination = join(parent, version);
const hashing = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const shaFile = 'SHA256SUMS.txt';
const sums = (hashes: Record<string, string>) => names.map(name => hashes[name] + '  ' + name).join('\n') + '\n';

async function auditSource(archive: string, directory: string, revision: string) {
  for (const entry of git('ls-tree', '--name-only', revision + ':plugins').split('\n')) {
    if (entry !== 'shared.ts' && !publicPlugins.has(entry)) throw Error('Source contains an unapproved plugin');
  }
  const tracked = new Map<string, string>();
  for (const entry of git('ls-tree', '--full-tree', '-r', '-z', revision).split('\0').filter(Boolean)) {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t([^\r\n\\:]+)$/.exec(entry);
    if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..'))
      throw Error('Unsupported path or entry in the public Git tree');
    tracked.set(match[2], match[1]);
  }
  const entries = run('tar', ['-tf', archive]).split(/\r?\n/).filter(name => !name.endsWith('/'));
  if (entries.length !== tracked.size || new Set(entries).size !== tracked.size ||
      entries.some(name => !tracked.has(name))) throw Error('Source archive omits tracked files');
  await mkdir(directory);
  run('tar', ['-xf', archive, '-C', directory]);
  for (const [name, id] of tracked) {
    const bytes = await readFile(join(directory, name));
    if (createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== id)
      throw Error('Source archive differs from the committed bytes');
  }
  await auditReleaseTree(directory, reference, rules);
}
async function auditInstaller(archive: string, directory: string) {
  const listing = run(policy.sevenZip, ['l', '-slt', '-sccUTF-8', '--', archive]).split(/^----------\s*$/m)[1];
  const paths = [...(listing ?? '').matchAll(/^Path = ([^\r\n]+)$/gm)].map(match => match[1].replaceAll('\\', '/'));
  if (paths.some(path => path.startsWith('/') || path.includes(':') || path.split('/').includes('..')) ||
      !['echo-desktop.exe', 'echo-agent.cmd', 'runtime/dist/server.mjs', 'runtime/dist/cli.mjs',
        'runtime/node.exe', 'runtime/echo-native.exe', 'runtime/echo-avatar.exe'].every(path => paths.includes(path)))
    throw Error('Unexpected Windows installer payload');
  run(policy.sevenZip, ['x', '-y', '-bd', '-bso0', '-bsp0', '-o' + directory, '--', archive]);
  await auditReleaseTree(directory, reference, rules);
  if (JSON.parse(await readFile(join(directory, 'runtime', 'dist', 'build-info.json'), 'utf8')).version !== version)
    throw Error('Installer version does not match source');
}

await mkdir(parent, { recursive: true });
const staging = await mkdtemp(join(parent, '.checking-'));
try {
  const freshArchive = join(staging, source);
  git('archive', '--format=zip', '--output=' + freshArchive, commit);
  await auditSource(freshArchive, join(staging, 'source'), commit);
  for (const [index, revision] of unpublished.filter(revision => revision !== commit).entries()) {
    const previousArchive = join(staging, 'source-' + index + '.zip');
    git('archive', '--format=zip', '--output=' + previousArchive, revision);
    await auditSource(previousArchive, join(staging, 'source-' + index), revision);
  }
  if (phase === 'prepare') {
    if (await access(destination).then(() => true, () => false)) throw Error('Release output already exists for this version');
    run('pnpm', ['run', 'desktop:build'], true);
    requireClean();
    const runtimeBytes = (await fileInventory(join(root, 'dist/runtime'))).reduce((sum, file) => sum + file.bytes, 0);
    await availableSpace(parent, runtimeBytes * 4);
    const files = join(staging, 'files');
    await mkdir(files);
    await cp(freshArchive, join(files, source));
    await cp(join(root, 'apps/desktop/target/release/bundle/nsis', 'Echo Agent_' + version + '_x64-setup.exe'), join(files, installer));
    await auditInstaller(join(files, installer), join(staging, 'installer'));
    const portable = join(staging, 'portable');
    await mkdir(portable);
    await cp(join(root, 'apps/desktop/target/release/echo-desktop.exe'), join(portable, 'Echo.exe'));
    await cp(join(root, 'dist/runtime'), join(portable, 'runtime'), { recursive: true, dereference: true });
    await cp(join(root, 'dist/echo-agent.cmd'), join(portable, 'echo-agent.cmd'));
    await auditReleaseTree(portable, reference, rules);
    await createUpdatePackage(portable, join(files, update));
    const hashes = Object.fromEntries(await Promise.all(names.map(async name => [name, await hashing(join(files, name))])));
    await writeFile(join(files, shaFile), sums(hashes));
    await writeFile(join(files, 'verified.local.json'), JSON.stringify({ commit, hashes }, null, 2));
    await rename(files, destination);
    console.log('Verified public artifacts: ' + destination);
  } else {
    const verified = JSON.parse(await readFile(join(destination, 'verified.local.json'), 'utf8'));
    for (const name of names) {
      if (verified.commit !== commit || verified.hashes?.[name] !== await hashing(join(destination, name)))
        throw Error('Public artifacts changed or belong to a different commit');
    }
    if (verified.hashes[source] !== await hashing(freshArchive) ||
        await readFile(join(destination, shaFile), 'utf8') !== sums(verified.hashes))
      throw Error('Source archive or checksums do not match the audited commit');
    await auditInstaller(join(destination, installer), join(staging, 'installer'));
    const checked = join(staging, 'update');
    const { extractArchive } = await import('../packages/kernel/updates.ts');
    const { readUpdateManifest, verifyApp } = await import('../packages/kernel/update-files.ts');
    const { buildSchema } = await import('../packages/contracts/build.ts');
    await extractArchive(join(destination, update), checked, join(root, 'resources/update-archive.ps1'));
    const installed = buildSchema.parse(JSON.parse(await readFile(join(checked, 'app/runtime/dist/build-info.json'), 'utf8')));
    if (installed.edition !== 'public' || installed.version !== version) throw Error('Update package has the wrong channel or version');
    await verifyApp(join(checked, 'app'), await readUpdateManifest(checked, installed));
    await auditReleaseTree(checked, reference, rules);
    requireClean();
    const gh = (...args: string[]) => run(policy.githubCli, args);
    if (remoteHead() !== base) throw Error('Public main changed during verification');
    const remoteTag = git('ls-remote', '--tags', 'origin', 'refs/tags/' + tag);
    if (remoteTag && remoteTag !== commit + '\trefs/tags/' + tag)
      throw Error('The remote tag points to a different commit');
    const helper = 'credential.helper=!"' + policy.githubCli.replaceAll('\\', '/') + '" auth git-credential';
    git('-c', 'credential.helper=', '-c', helper, 'push', '--atomic', 'origin',
      commit + ':refs/heads/main', commit + ':refs/tags/' + tag);
    gh('release', 'create', tag, '--repo', policy.repository, '--verify-tag', '--title', 'Echo Agent ' + version,
      '--notes', 'Verified Windows x64 installer and source archive.', ...[...names, shaFile].map(name => join(destination, name)));
    const release = JSON.parse(gh('api', 'repos/' + policy.repository + '/releases/tags/' + tag)) as {
      draft: boolean; assets: { name: string; digest: string }[];
    };
    const hashes = { ...verified.hashes, [shaFile]: await hashing(join(destination, shaFile)) };
    if (release.draft || release.assets.length !== names.length + 1 ||
        release.assets.some(asset => asset.digest !== 'sha256:' + hashes[asset.name]))
      throw Error('GitHub release asset verification failed');
    console.log('Published verified public release ' + tag);
  }
} finally {
  if (!staging.startsWith(parent + sep + '.checking-')) throw Error('Unsafe release scratch path');
  await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
