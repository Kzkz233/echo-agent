import { z } from 'zod';
import { id } from './index.ts';

export const ingestionPolicy = z
  .object({
    format: z.literal('echo-ingestion-v1').default('echo-ingestion-v1'),
    documentParser: z.string().default('documents.local'),
    mediaParser: z.string().default(''),
    imageParser: z.string().default(''),
    imageProcessor: z.string().default(''),
    mediaProcessor: z.string().default(''),
    chunkChars: z.number().int().min(200).max(6000).default(1200),
    overlapChars: z.number().int().min(0).max(1000).default(200),
    mediaSeconds: z.number().int().min(5).max(60).default(30),
    modalities: z
      .array(z.enum(['text', 'image', 'audio', 'video']))
      .min(1)
      .default(['text', 'image', 'audio', 'video']),
    modelId: z.string().default(''),
    indexOnImport: z.boolean().default(false),
  })
  .refine((v) => v.overlapChars < v.chunkChars, '重叠长度必须小于片段长度');
export type IngestionPolicy = z.infer<typeof ingestionPolicy>;
export const evidenceNode = z.object({
  id,
  parentId: id.optional(),
  kind: z.enum(['document', 'section', 'segment', 'text', 'image', 'audio', 'video']),
  text: z.string(),
  offset: z.number().int().nonnegative().optional(),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  start: z.number().nonnegative().optional(),
  end: z.number().nonnegative().optional(),
  page: z.number().int().positive().optional(),
});
export type EvidenceNode = z.infer<typeof evidenceNode>;
export function contentPolicy(policy: IngestionPolicy) {
  return {
    version: 2,
    chunkChars: policy.chunkChars,
    overlapChars: policy.overlapChars,
    mediaSeconds: policy.mediaSeconds,
    modalities: [...policy.modalities].sort(),
  };
}
export const mediaReference = z
  .object({
    vaultId: id,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    modality: z.enum(['image', 'audio', 'video']),
    start: z.number().nonnegative().default(0),
    end: z.number().positive().max(86400).optional(),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(
    (v) => v.end === undefined || (v.end > v.start && v.end - v.start <= 60),
    '媒体片段范围无效',
  );
export const mediaProcessor = z.object({
  id,
  label: z.string(),
  version: z.string(),
  modalities: z.array(z.enum(['image', 'audio', 'video'])).min(1),
});
export const mediaPlan = z.object({
  processor: mediaProcessor,
  options: z.record(z.string(), z.unknown()).default({}),
});
