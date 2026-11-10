import { invariant } from '../contracts/index.ts';
import type { Caller } from './registry.ts';

export type ResourceReader = Pick<Caller, 'kind' | 'personaId'>;
type EntryIdentity = { kind: string; logicalPath?: string; metadata: Record<string, unknown> };
const privateKinds = new Set(['persona', 'memory', 'observation', 'review']);
export const privateLibraryOwners = new Set(['persona', 'memory', 'observation', 'review']);

export function entryPersona(entry: EntryIdentity): string | undefined {
  const metadata = entry.metadata;
  const value = metadata.personaId ?? (metadata.memory as any)?.personaId ??
    (metadata.persona as any)?.id;
  return typeof value === 'string' ? value : /^Personas\/([^/]+)\//.exec(entry.logicalPath ?? '')?.[1];
}

export function canReadEntry(entry: EntryIdentity, reader?: ResourceReader): boolean {
  if (!reader || reader.kind !== 'mcp') return true;
  const personaId = entryPersona(entry);
  if (!privateKinds.has(entry.kind) && !personaId) return true;
  return Boolean(reader.personaId && personaId === reader.personaId);
}

export function ownPersona(reader: ResourceReader, requested?: string): string | undefined {
  invariant(!reader.personaId || !requested || requested === reader.personaId,
    'resource_scope', '只能访问当前角色的数据。');
  return reader.personaId ?? requested;
}
