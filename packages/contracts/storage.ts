import { z } from 'zod';

/** Explicit JSON pointers only; migration never recursively guesses which strings are paths. */
export const storagePathSchema = z.object({
  table: z.enum(['documents', 'kv']),
  collection: z.string().regex(/^[a-zA-Z0-9_.-]{1,160}$/),
  pointers: z.array(z.string().regex(/^(\/(?:[a-zA-Z0-9_.-]+|\*))+$/)).min(1).max(40),
});
export type StoragePaths = z.infer<typeof storagePathSchema>;
export const coreStoragePaths: StoragePaths[] = [
  { table: 'documents', collection: 'profiles', pointers: ['/model', '/options/projector', '/options/modelPath', '/options/tokenizerFile', '/options/modelFile'] },
  { table: 'documents', collection: 'connections', pointers: ['/config/cwd', '/config/command', '/config/args/*'] },
  ...['extensions', 'module-extensions', 'extension-rollback'].map((collection) => ({ table: 'documents' as const, collection, pointers: ['/directory', '/manifest/command', '/manifest/args/*'] })),
];
