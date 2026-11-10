import { z } from 'zod';
import { id } from './index.ts';

export const knowledgeCollection = z.object({
  id,
  title: z.string().min(1).max(500),
  parentId: id.optional(),
  kind: z.enum(['library', 'group-set', 'group']),
  snapshot: z.boolean().optional(),
});
export type KnowledgeCollection = z.infer<typeof knowledgeCollection>;

export const collectionRequest = z.object({ vaultId: id, collectionId: id.optional() });
export const collectionResult = z.object({
  nodes: z.array(knowledgeCollection),
  documentIds: z.array(id).optional(),
});
