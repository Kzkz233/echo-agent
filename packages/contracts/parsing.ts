import { z } from 'zod';
import { id } from './index.ts';
import { parsedDocument } from './documents.ts';

export const sourceReference = z.object({
  vaultId: id,
  fileId: id,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().max(1000),
  requestId: id,
});
export const parserDescriptor = z.object({
  id,
  label: z.string(),
  version: z.string(),
  contract: z.enum(['files.extract@1', 'files.extract@2', 'files.extract@3']),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).min(1),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 ** 3),
  prepare: id.optional(),
});
export const parsePlan = z.object({
  format: z.literal('echo-parse-plan-v1'),
  parser: parserDescriptor,
  // Provider-owned, serializable configuration. Credentials must remain references.
  options: z.record(z.string(), z.unknown()).default({}),
  provenance: z.record(z.string(), z.unknown()).default({}),
});
export const parsedContent = parsedDocument.extend({
  segments: z
    .array(
      z
        .object({
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
          text: z.string(),
          language: z.string().optional(),
        })
        .refine((v) => v.end >= v.start),
    )
    .max(100000)
    .optional(),
});
export type ParserDescriptor = z.infer<typeof parserDescriptor>;
export type ParsePlan = z.infer<typeof parsePlan>;
export type ParsedContent = z.infer<typeof parsedContent>;
export function parserAccepts(parser: ParserDescriptor, name: string, bytes: number) {
  const extension = /\.[^.\\/]+$/.exec(name)?.[0].toLowerCase();
  return !!extension && parser.extensions.includes(extension) && bytes <= parser.maxBytes;
}
