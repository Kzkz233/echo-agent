import { readdir, readFile, writeFile, mkdir, cp, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { configureNetwork } from '../packages/kernel/network.ts';
configureNetwork();
const root = resolve(import.meta.dirname, '..'),
  output = join(root, 'dist/runtime/licenses');
await mkdir(output, { recursive: true });
const records: {
    ecosystem: string;
    name: string;
    version: string;
    license: string;
    copied: number;
  }[] = [],
  seen = new Set<string>();
async function record(
  ecosystem: string,
  name: string,
  version: string,
  license: any,
  directory: string,
  explicit?: string,
  repository?: string,
) {
  const key = ecosystem + '/' + name + '@' + version;
  if (seen.has(key)) return;
  seen.add(key);
  const destination = join(output, ecosystem, (name + '-' + version).replace(/[^\w.-]/g, '_'));
  await mkdir(destination, { recursive: true });
  const files = (await readdir(directory)).filter((file) =>
    /^(licen[cs]e|copying|notice|third.party.notices)([.\-_]|$)/i.test(file),
  );
  if (explicit) files.push(explicit);
  let copied = 0;
  for (const file of [...new Set(files)]) {
    const path = resolve(directory, file);
    try {
      if ((await stat(path)).isFile()) {
        await cp(path, join(destination, file.split(/[\\/]/).at(-1)!));
        copied++;
      }
    } catch {}
  }
  if (!copied) {
    try {
      const readme = await readFile(join(directory, 'README.md'), 'utf8');
      if (readme.includes('Permission is hereby granted')) {
        await writeFile(join(destination, 'LICENSE_FROM_UPSTREAM_README.md'), readme);
        copied++;
      }
    } catch {}
  }
  if (ecosystem === 'rust' && String(license).includes('MPL-2.0')) {
    await cp(directory, join(output, 'corresponding-source', name + '-' + version), {
      recursive: true,
    });
  }
  if (!copied) {
    try {
      if ((await stat(join(destination, 'UPSTREAM_LICENSE'))).isFile()) copied++;
    } catch {}
  }
  if (!copied && name === 'guid-typescript') {
    // The npm publisher declares ISC but omits a license file. Keep its declared author and full standard grant.
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    await writeFile(
      join(destination, 'DECLARED_ISC_LICENSE.txt'),
      `ISC License\n\nCopyright (c) ${typeof manifest.author === 'string' ? manifest.author : manifest.author?.name}\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n\nPublisher metadata: ${manifest.repository.url}; ISC is declared in the original package.json.\n`,
    );
    copied++;
  }
  if (!copied && name === 'proxy-agent-negotiate') {
    const response = await fetch(
      'https://raw.githubusercontent.com/TooTallNate/proxy-agents/main/packages/proxy-agent/LICENSE',
      { signal: AbortSignal.timeout(10000) },
    );
    if (response.ok) {
      await writeFile(join(destination, 'UPSTREAM_LICENSE'), await response.text());
      copied++;
    }
  }
  if (!copied && name === 'selectors') {
    // This upstream omits the standard license text from its crate. Retain the
    // already collected version-specific license on incremental/offline builds.
    const cached = join(destination, 'MPL-2.0-LICENSE');
    const existing = await readFile(cached, 'utf8').catch(() => '');
    if (existing.includes('Mozilla Public License') && existing.length > 1000) copied++;
    else {
      const response = await fetch('https://www.mozilla.org/media/MPL/2.0/index.txt',
        { signal: AbortSignal.timeout(10000) });
      const text = response.ok ? await response.text() : '';
      if (text.includes('Mozilla Public License') && text.length > 10000) { await writeFile(cached, text); copied++; }
    }
  }
  if (!copied && repository) {
    const github = repository
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .match(/github\.com[/:]([^/]+\/[^/#]+)/)?.[1];
    if (github)
      for (const branch of ['main', 'master']) {
        for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
          const url = `https://raw.githubusercontent.com/${github}/${branch}/${file}`;
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!response.ok) continue;
            const content = await response.text();
            if (content.length < 100 || content.includes('<html')) continue;
            await writeFile(join(destination, 'UPSTREAM_LICENSE'), content);
            await writeFile(
              join(destination, 'UPSTREAM_SOURCE.json'),
              JSON.stringify(
                { url, sha256: createHash('sha256').update(content).digest('hex') },
                null,
                2,
              ),
            );
            copied++;
            break;
          } catch {}
        }
        if (copied) break;
      }
  }
  await writeFile(
    join(destination, 'PACKAGE.json'),
    JSON.stringify({ name, version, license, repository }, null, 2),
  );
  records.push({
    ecosystem,
    name,
    version,
    license: typeof license === 'string' ? license : (license?.type ?? 'UNKNOWN'),
    copied,
  });
}
async function modules(directory: string) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      await modules(path);
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      await record(
        'js',
        manifest.name,
        manifest.version,
        manifest.license,
        path,
        undefined,
        typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url,
      );
      await modules(join(path, 'node_modules'));
    } catch {}
  }
}
await modules(join(root, 'dist/runtime/node_modules'));
for (const manifest of ['native/Cargo.toml', 'apps/desktop/Cargo.toml']) {
  const result = spawnSync(
    'cargo',
    [
      'metadata',
      '--manifest-path',
      manifest,
      '--format-version',
      '1',
      '--locked',
      '--filter-platform',
      'x86_64-pc-windows-msvc',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 20000000, windowsHide: true },
  );
  if (result.status !== 0) throw Error(result.stderr);
  const metadata = JSON.parse(result.stdout),
    resolved = new Set(metadata.resolve.nodes.map((n: any) => n.id));
  for (const pkg of metadata.packages.filter((p: any) => resolved.has(p.id)))
    if (!pkg.name.startsWith('echo-'))
      await record(
        'rust',
        pkg.name,
        pkg.version,
        pkg.license,
        dirname(pkg.manifest_path),
        pkg.license_file ?? undefined,
        pkg.repository ?? undefined,
      );
}
const supplemental = join(output, 'native-libraries');
await mkdir(supplemental, { recursive: true });
for (const [file, url] of Object.entries({
  PI_LICENSE: 'https://raw.githubusercontent.com/earendil-works/pi/v1.5.0/LICENSE',
  'SHARP_LIBVIPS_THIRD_PARTY_NOTICES.md':
    'https://raw.githubusercontent.com/lovell/sharp-libvips/v1.3.4/THIRD-PARTY-NOTICES.md',
  'LGPL-3.0.txt': 'https://raw.githubusercontent.com/gcc-mirror/gcc/master/COPYING3.LIB',
  'GPL-3.0.txt': 'https://raw.githubusercontent.com/gcc-mirror/gcc/master/COPYING3',
  ONNX_LICENSE: 'https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE',
  'ONNX_THIRD_PARTY_NOTICES.txt':
    'https://raw.githubusercontent.com/microsoft/onnxruntime/main/ThirdPartyNotices.txt',
})) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Required license text unavailable: ${url}`);
  await writeFile(join(supplemental, file), await response.text());
}
await cp(
  join(root, 'dist/runtime/node_modules/@img/sharp-win32-x64/versions.json'),
  join(supplemental, 'SHARP_COMPONENT_VERSIONS.json'),
);
await writeFile(
  join(supplemental, 'SOURCES.md'),
  `# Native knowledge sources and replacement\n\nThe unmodified libvips Windows DLLs are dynamically loaded from runtime/node_modules/@img/sharp-win32-x64/lib. You may replace them with compatible rebuilt DLLs; Echo does not prohibit modification or reverse engineering required to debug such modifications. Keep this directory when redistributing.\n\nCorresponding upstream build recipes and version-pinned source URLs for libvips and its dependencies: https://github.com/lovell/sharp-libvips/tree/v1.3.4 ; libvips 8.18.7: https://github.com/libvips/libvips/tree/v8.18.7 . Exact component versions are in SHARP_COMPONENT_VERSIONS.json. The original projects retain their copyrights and LGPL/other notices.\n\nONNX Runtime sources, build recipes and notices: https://github.com/microsoft/onnxruntime . CPU runtime binaries are unmodified. The bundled BGE Small Chinese model has separate MIT licensing and provenance under runtime/models/Xenova/bge-small-zh-v1.5.\n`,
);
records.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
await writeFile(join(output, 'inventory.json'), JSON.stringify(records, null, 2));
await writeFile(
  join(output, 'README.md'),
  '# Dependency license inventory\n\nPackage license texts are collected below. Node.js notices are in ../NODE_LICENSE. Assets have separate notices in ../THIRD_PARTY_NOTICES.md.\n\n| Ecosystem | Package | Version | License | Included texts |\n|---|---|---|---|---|\n' +
    records
      .map((r) => `| ${r.ecosystem} | ${r.name} | ${r.version} | ${r.license} | ${r.copied} |`)
      .join('\n') +
    '\n',
);
console.log(
  JSON.stringify({
    packages: records.length,
    unknownLicense: records.filter((r) => r.license === 'UNKNOWN').map((r) => r.name),
    withoutStandaloneLicenseFile: records.filter((r) => !r.copied).map((r) => r.name),
  }),
);
