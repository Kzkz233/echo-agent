import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { invariant } from '../../packages/contracts/index.ts';
export const maxOriginalBytes = 8 * 1024 ** 3;
export async function hashOriginal(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const block of createReadStream(path, { signal })) {
    bytes += block.length;
    invariant(bytes <= maxOriginalBytes, 'source_size', '原件需不超过8 GiB');
    hash.update(block);
  }
  return { hash: hash.digest('hex'), bytes };
}
