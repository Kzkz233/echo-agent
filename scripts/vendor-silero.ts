import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import manifest from '../resources/models/silero-vad/manifest.json' with { type: 'json' };

export async function vendorSilero(root: string) {
  const destination = join(root, 'dist/vendor/models/silero-vad');
  const path = join(destination, manifest.file);
  const valid = (data: Buffer) =>
    data.length === manifest.bytes &&
    createHash('sha256').update(data).digest('hex') === manifest.sha256;
  let data = await readFile(path).catch(() => undefined);
  if (!data || !valid(data)) {
    const response = await fetch(
      `https://raw.githubusercontent.com/snakers4/silero-vad/${manifest.revision}/${manifest.path}`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok) throw Error('Bundled speech detector download failed');
    data = Buffer.from(await response.arrayBuffer());
    if (!valid(data)) throw Error('Bundled speech detector checksum mismatch');
    await mkdir(destination, { recursive: true });
    await writeFile(path, data);
  }
  await cp(join(root, 'resources/models/silero-vad/LICENSE'), join(destination, 'LICENSE'));
  await writeFile(join(destination, 'provenance.json'), JSON.stringify(manifest, null, 2));
  return destination;
}
