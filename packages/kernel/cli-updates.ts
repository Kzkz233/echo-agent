import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { updateRoot } from './update-transaction.ts';

/** Read-only receipt inspection also works while the backend is being replaced. */
export async function localUpdateStatus(executable?: string) {
  if (!executable)
    return {
      supported: false,
      backend: 'unavailable',
      issue: 'Installation not found. Pass --app PATH.',
    };
  const root = dirname(executable),
    updates = updateRoot(root);
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  const [installed, journal, prepared, rollback] = await Promise.all([
    read(join(root, 'runtime/dist/build-info.json')).catch(() => undefined),
    read(join(updates, 'journal.json')).catch(() => undefined),
    read(join(updates, 'prepared.json')).catch(() => undefined),
    read(join(updates, 'rollback.json')).catch(() => undefined),
  ]);
  return {
    supported: true,
    backend: 'unavailable',
    installed,
    journal,
    prepared: prepared
      ? {
          id: prepared.id,
          build: prepared.manifest?.build,
          rollback: prepared.rollback,
          origin: prepared.origin,
        }
      : undefined,
    rollback: rollback?.build,
  };
}
