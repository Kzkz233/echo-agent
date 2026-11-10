import { cp, mkdir, readFile, writeFile, access, rm, readdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { vendorNode } from './vendor-node.ts';
import { vendorBge } from './vendor-bge.ts';
const root = resolve(import.meta.dirname, '..'),
  stage = join(root, 'dist', 'runtime');
await mkdir(stage, { recursive: true });
const lock = await readFile(join(root, 'pnpm-lock.yaml'));
const hash = createHash('sha256').update(lock).update('hoisted-layout-1').digest('hex');
let installed = '';
try {
  installed = await readFile(join(stage, '.deps-hash'), 'utf8');
} catch {}
await cp(join(root, 'package.json'), join(stage, 'package.json'));
await cp(join(root, 'pnpm-lock.yaml'), join(stage, 'pnpm-lock.yaml'));
await writeFile(
  join(stage, 'pnpm-workspace.yaml'),
  'nodeLinker: hoisted\nallowBuilds:\n  "@google/genai": false\n  protobufjs: false\n  onnxruntime-node: false\n',
);
if (installed !== hash) {
  const modules = resolve(stage, 'node_modules');
  if (modules !== resolve(root, 'dist', 'runtime', 'node_modules'))
    throw Error('Unsafe staging path');
  await rm(modules, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  const install = (offline: boolean) =>
    spawnSync(
      `pnpm install --prod ${offline ? '--offline ' : ''}--frozen-lockfile --ignore-scripts`,
      {
        cwd: stage,
        shell: true,
        stdio: 'inherit',
        windowsHide: true,
        env: { ...process.env, CI: 'true' },
      },
    );
  let result = install(true);
  if (result.status !== 0) result = install(false);
  if (result.status !== 0) throw Error('Production dependency installation failed');
  await writeFile(join(stage, '.deps-hash'), hash);
}
// This artifact targets Windows x64. Keep the complete matching CPU/DirectML runtime,
// but do not ship unrelated macOS, Linux or Windows ARM binaries from the npm tarball.
const nativeBins = join(stage, 'node_modules/onnxruntime-node/bin');
for (const metadata of ['.modules.yaml', '.pnpm-workspace-state-v1.json'])
  await rm(join(stage, 'node_modules', metadata), { force: true });
for (const version of await readdir(nativeBins)) {
  if (!/^napi-v\d+$/.test(version)) continue;
  for (const suffix of ['darwin', 'linux', 'win32/arm64']) {
    const target = resolve(nativeBins, version, suffix);
    try {
      const actual = await realpath(target),
        approved = await realpath(stage);
      if (!actual.toLowerCase().startsWith(approved.toLowerCase() + sep))
        throw Error('Unsafe native staging path');
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
const webStage = resolve(stage, 'dist', 'web');
if (webStage !== resolve(root, 'dist/runtime/dist/web')) throw Error('Unsafe web staging path');
await rm(webStage, { recursive: true, force: true });
await cp(join(root, 'dist', 'web'), webStage, { recursive: true });
for (const name of [
  'server.mjs',
  'cli.mjs',
  'embedding-worker.mjs',
  'process-guardian.mjs',
  'document-result-worker.mjs',
  'semantic-search-worker.mjs',
  'avatar-import-worker.mjs',
  'parse-worker.mjs',
  'library-export-worker.mjs',
  'backup-worker.mjs',
  'restore-worker.mjs',
  'build-info.json',
  'update-helper.mjs',
  'update-archive.ps1',
])
  await cp(join(root, 'dist', name), join(stage, 'dist', name));
const node = await vendorNode(root);
await cp(await vendorBge(root),join(stage,'models'),{recursive:true});
await cp(join(root, 'native/target/release/echo-avatar.exe'), join(stage, 'echo-avatar.exe'));
await cp(join(node, 'node.exe'), join(stage, 'node.exe'));
await cp(join(root, 'scripts/echo-agent.cmd'), join(root, 'dist/echo-agent.cmd'));
await cp(join(node, 'LICENSE'), join(stage, 'NODE_LICENSE'));
await cp(
  join(
    root,
    'native',
    'target',
    'release',
    process.platform === 'win32' ? 'echo-native.exe' : 'echo-native',
  ),
  join(stage, process.platform === 'win32' ? 'echo-native.exe' : 'echo-native'),
);
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md']) {
  try {
    await access(join(root, name));
    await cp(join(root, name), join(stage, name));
  } catch {}
}
const publicDocs=resolve(stage,'docs');
if(publicDocs!==resolve(root,'dist/runtime/docs'))throw Error('Unsafe docs staging path');
await rm(publicDocs,{recursive:true,force:true});await mkdir(join(publicDocs,'screenshots'),{recursive:true});
for(const name of await readdir(join(root,'docs')))if(name.endsWith('.md'))await cp(join(root,'docs',name),join(publicDocs,name));
for(const name of ['starter-studio.png','starter-character.png','character-paused.png'])await cp(join(root,'docs/screenshots',name),join(publicDocs,'screenshots',name));
console.log('Prepared portable desktop runtime. No application data or credentials are included.');
