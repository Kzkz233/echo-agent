import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
export const nodeVersion = '24.22.1';
export async function vendorNode(root: string) {
  const directory = join(root, 'dist', 'toolchain', 'node-' + nodeVersion);
  const executable = join(directory, 'node.exe');
  try {
    const record = JSON.parse(await readFile(join(directory, 'verified.json'), 'utf8'));
    if (
      createHash('sha256')
        .update(await readFile(executable))
        .digest('hex') === record.executableSha256
    )
      return directory;
  } catch {}
  const filename = `node-v${nodeVersion}-win-x64.zip`;
  const base = `https://nodejs.org/dist/v${nodeVersion}/`;
  const sumsResponse = await fetch(base + 'SHASUMS256.txt');
  if (!sumsResponse.ok) throw Error('Cannot fetch official Node checksums');
  const sums = await sumsResponse.text();
  const expected = sums
    .split('\n')
    .find((line) => line.endsWith('  ' + filename))
    ?.split(/\s+/)[0];
  if (!expected) throw Error('Node platform archive not listed');
  const response = await fetch(base + filename);
  if (!response.ok) throw Error('Cannot download official Node runtime');
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw Error('Node archive checksum mismatch');
  const files = unzipSync(archive),
    prefix = `node-v${nodeVersion}-win-x64/`;
  const binary = files[prefix + 'node.exe'],
    license = files[prefix + 'LICENSE'];
  if (!binary || !license) throw Error('Official Node archive is incomplete');
  await mkdir(directory, { recursive: true });
  await writeFile(executable, binary);
  await writeFile(join(directory, 'LICENSE'), license);
  await writeFile(
    join(directory, 'verified.json'),
    JSON.stringify(
      {
        version: nodeVersion,
        source: base + filename,
        archiveSha256: actual,
        executableSha256: createHash('sha256').update(binary).digest('hex'),
      },
      null,
      2,
    ),
  );
  console.log('Verified official Node.js ' + nodeVersion);
  return directory;
}
if (process.argv[1]?.endsWith('vendor-node.ts'))
  await vendorNode(resolve(import.meta.dirname, '..'));
