import { auditReleaseTree, privateReference } from './release-privacy.ts';
import { mkdir, cp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Unexpected release version');
// Rust panic locations may contain absolute Cargo registry paths even with
// debug symbols stripped. Reject those before creating any release output.
for (const path of [
  'apps/desktop/target/release/echo-desktop.exe',
  'native/target/release/echo-avatar.exe',
  'native/target/release/echo-native.exe',
]) {
  const binary = await readFile(join(root, path));
  if (
    [homedir(), homedir().replaceAll('\\', '/'), homedir().replaceAll('\\', '\\\\')].some(
      (prefix) =>
        binary.includes(Buffer.from(prefix)) || binary.includes(Buffer.from(prefix, 'utf16le')),
    )
  )
    throw Error('Builder-specific path in executable; rebuild with pnpm desktop:build: ' + path);
}
const release = join(root, 'dist', 'release');
await mkdir(release, { recursive: true });
const portable = resolve(release, `Echo-${version}-win-x64`),
  source = resolve(release, `Echo-${version}-source`);
for (const path of [portable, source]) {
  if (!path.startsWith(resolve(root, 'dist/release') + sep)) throw Error('Unsafe release path');
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}
await cp(join(root, 'apps/desktop/target/release/echo-desktop.exe'), join(portable, 'Echo.exe'));
await cp(join(root, 'dist/echo-agent.cmd'), join(portable, 'echo-agent.cmd'));
await cp(join(root, 'dist/runtime'), join(portable, 'runtime'), {
  recursive: true,
  dereference: true,
});
for (const file of ['README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'])
  await cp(join(root, file), join(portable, file));
await mkdir(join(portable, 'docs/screenshots'), { recursive: true });
for (const name of await readdir(join(root, 'docs'))) if (name.endsWith('.md')) await cp(join(root, 'docs', name), join(portable, 'docs', name));
for (const name of ['starter-studio.png', 'starter-character.png', 'character-paused.png']) await cp(join(root, 'docs/screenshots', name), join(portable, 'docs/screenshots', name));
await writeFile(
  join(portable, 'START_HERE.txt'),
  `Echo ${version}\r\n\r\nRun Echo.exe. Keep runtime beside the executable.\r\nAdd a language model in Model Services, then create or import a character. DSH and Codex are optional task workers.\r\nCapture, automated Review, conversation injection and avatar display start off.\r\nNo private configuration or credentials are included. The offline BGE Small Chinese embedding model is included under its MIT license.\r\nSee README.md and docs/VERIFICATION.md.\r\n`,
);
const excluded = new Set([
  'node_modules',
  'target',
  'dist',
  '.git',
  'test-results',
  'playwright-report',
  'gen',
]);
async function copySource(from: string, to: string) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (
      excluded.has(entry.name) ||
      entry.name === '.env' ||
      /\.sqlite|\.log$|\.local\./.test(entry.name)
    )
      continue;
    const path = join(from, entry.name),
      destination = join(to, entry.name);
    if (entry.isSymbolicLink()) throw Error('Unexpected source symlink: ' + relative(root, path));
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copySource(path, destination);
    } else if (entry.isFile()) await cp(path, destination);
  }
}
// Closed top-level release allowlist. Runtime databases, caches, audit directories,
// ad-hoc local files and unreviewed screenshots never enter the source archive.
const sourceDirectories = ['packages','plugins','scripts','tests','examples','resources/models','apps/server','apps/cli','apps/workbench/src','apps/desktop/src','apps/desktop/capabilities','apps/desktop/icons','native/src'];
const sourceFilesAtRoot = ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','.gitignore','.prettierignore','.prettierrc.json','AGENTS.md','README.md','CONTRIBUTING.md','SECURITY.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','apps/workbench/index.html','apps/workbench/vite.config.ts','apps/desktop/Cargo.toml','apps/desktop/Cargo.lock','apps/desktop/build.rs','apps/desktop/tauri.conf.json','native/Cargo.toml','native/Cargo.lock'];
for (const directory of sourceDirectories) { await mkdir(join(source,directory),{recursive:true}); await copySource(join(root,directory),join(source,directory)); }
for (const file of sourceFilesAtRoot) await cp(join(root,file),join(source,file));
for (const asset of ['cute-girl','starter-characters']) await cp(join(root,'apps/workbench/public/assets',asset),join(source,'apps/workbench/public/assets',asset),{recursive:true});
await cp(join(portable,'docs'),join(source,'docs'),{recursive:true});
const builderHome = homedir(),
  privatePaths = [
    builderHome,
    builderHome.replaceAll('\\', '/'),
    builderHome.replaceAll('\\', '\\\\'),
  ];
async function inspectRuntime(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspectRuntime(path);
    else if (entry.isFile() && /\.(?:json|yaml|yml|md|js|mjs|txt|cmd|ps1)$/.test(entry.name)) {
      const contents = await readFile(path, 'utf8');
      if (privatePaths.some((prefix) => contents.includes(prefix)))
        throw Error('Builder-specific path in runtime: ' + relative(portable, path));
    }
  }
}
await inspectRuntime(join(portable, 'runtime'));
// Explicitly enumerate source files and reject machine-specific paths or accidental credentials.
const sourceFiles: string[] = [];
async function scan(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else {
      sourceFiles.push(relative(source, path).split(sep).join('/'));
      if (/\.(?:ts|tsx|rs|json|md|yaml|yml|mjs|toml|txt)$/.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        if (/C:[\\/]Users[\\/](?!Public[\\/])\w+[\\/]/i.test(text))
          throw Error('Machine-specific path in source: ' + relative(source, path));
        if (/(?:sk-[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----)/.test(text))
          throw Error('Possible secret in source: ' + relative(source, path));
      }
    }
  }
}
await scan(source);
const reference=await privateReference(process.env.ECHO_RELEASE_PRIVATE_REFERENCE);
const privacy={source:await auditReleaseTree(source,reference),runtime:await auditReleaseTree(join(portable,'runtime'),reference)};
await writeFile(join(release,'privacy-audit.json'),JSON.stringify(privacy,null,2));
await writeFile(join(release, 'source-manifest.json'), JSON.stringify(sourceFiles.sort(), null, 2));
for (const directory of [portable, source]) {
  const destination = directory + '.zip';
  // PowerShell variables are passed as literal single-quoted paths, never string-built filesystem targets.
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  await rm(destination, { force: true });
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash',$false); [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(directory)},${quote(destination)},[System.IO.Compression.CompressionLevel]::Optimal,$true)`,
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 2000000 },
  );
  if (result.status !== 0) throw Error(result.stderr);
}
const installer = `Echo Agent_${version}_x64-setup.exe`;
await cp(
  join(root, 'apps/desktop/target/release/bundle/nsis', installer),
  join(release, installer),
);
const files = [`Echo-${version}-win-x64.zip`, `Echo-${version}-source.zip`, installer];
const hashes = [];
for (const file of files) {
  const path = join(release, file);
  hashes.push({
    file,
    bytes: (await stat(path)).size,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  });
}
await writeFile(
  join(release, 'SHA256SUMS.txt'),
  hashes.map((h) => `${h.sha256}  ${h.file}`).join('\n') + '\n',
);
await writeFile(
  join(release, 'release.json'),
  JSON.stringify({ version, builtAt: new Date().toISOString(), files: hashes }, null, 2),
);
console.log(JSON.stringify(hashes, null, 2));
