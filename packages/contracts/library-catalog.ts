import { z } from 'zod';
import { id } from './index.ts';
import { knowledgeCollection } from './knowledge-collections.ts';

export const browseLibrary = z.object({
  query: z.string().trim().max(500).default(''),
  group: id.optional(),
  scope: id.optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(25),
  documentsOnly: z.boolean().optional(),
  refresh: z.boolean().default(false),
});
export type BrowseLibrary = z.infer<typeof browseLibrary>;
export const catalogResult = z.object({
  importDestination: z.string().optional(),
  knowledgeScopes: z
    .array(z.object({ vaultId: id, collectionId: id, title: z.string() }))
    .optional(),
  sync: z
    .object({
      updatedAt: z.string().optional(),
      pending: z.boolean(),
      issue: z.string().optional(),
    })
    .optional(),
  scopes: z.array(z.object({ id, title: z.string() })).optional(),
  scope: id.optional(),
  groups: z.array(knowledgeCollection),
  total: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      id,
      cells: z.record(z.string(), z.string()),
      files: z
        .array(
          z.object({
            id,
            title: z.string(),
            status: z.string().optional(),
            index: z.string().optional(),
            action: z
              .object({ label: z.string(), input: z.record(z.string(), z.unknown()) })
              .optional(),
          }),
        )
        .optional(),
      documents: z
        .array(
          z.object({
            vaultId: id,
            documentId: id,
            title: z.string().optional(),
            sourceState: z.enum(['changed', 'removed', 'check']).optional(),
          }),
        )
        .optional(),
    }),
  ),
});
export type CatalogResult = z.infer<typeof catalogResult>;

export const indexCoverageRequest = z.object({
  vaultId: id,
  documentIds: z.array(id).min(1).max(200),
});
export const indexCoverageResult = z.record(z.string(), z.enum(['ready', 'partial', 'missing']));
