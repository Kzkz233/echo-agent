import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export async function vendorBge(root: string) {
  const metadata = join(root, 'resources/models/bge-small-zh-v1.5');
  const manifest = JSON.parse(await readFile(join(metadata, 'manifest.json'), 'utf8'));
  const destination = join(root, 'dist/vendor/models', manifest.model);
  for (const file of manifest.files) {
    if (!/^[\w./-]+$/.test(file.path) || file.path.split('/').includes('..'))
      throw Error('Invalid model manifest path');
    const path = join(destination, file.path);
    const valid = (data: Buffer) =>
      data.length === file.bytes && createHash('sha256').update(data).digest('hex') === file.sha256;
    const existing = await readFile(path).catch(() => undefined);
    if (existing && valid(existing)) continue;
    const response = await fetch(
      `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${file.path}`,
      { signal: AbortSignal.timeout(180000) },
    );
    if (!response.ok) throw Error('Bundled BGE download failed: ' + file.path);
    const data = Buffer.from(await response.arrayBuffer());
    if (!valid(data)) throw Error('Bundled BGE checksum mismatch: ' + file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  await cp(join(metadata, 'LICENSE'), join(destination, 'LICENSE'));
  await cp(join(metadata, 'manifest.json'), join(destination, 'provenance.json'));
  return join(root, 'dist/vendor/models');
}
