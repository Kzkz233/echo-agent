import { z } from 'zod';
import { id, reasoning, profileSchema } from './index.ts';
import { replySubmission } from './delivery.ts';
import { transcriptMessage } from './transcript.ts';
import { reasoningStyle, reasoningLevel } from './reasoning.ts';
export const modality = z.enum(['text', 'image', 'audio', 'video']);
export const modelProfileSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    connectionId: id,
    model: z.string().default(''),
    generation: z
      .object({
        enabled: z.boolean().default(true),
        inputs: z.array(modality).min(1).default(['text']),
      })
      .default({ enabled: true, inputs: ['text'] }),
    embedding: z
      .object({
        enabled: z.boolean().default(false),
        inputs: z.array(modality).min(1).default(['text']),
        dimensions: z.number().int().positive().max(65536).optional(),
      })
      .default({ enabled: false, inputs: ['text'] }),
    reranking: z
      .object({ enabled: z.boolean(), inputs: z.array(modality).min(1).default(['text']) })
      .optional(),
    transcription: z
      .object({ enabled: z.boolean(), inputs: z.array(modality).min(1).default(['audio']) })
      .optional(),
    reasoning: reasoning.default('inherit'),
    reasoningStyle: reasoningStyle.default('auto'),
    reasoningLevels: z.array(reasoningLevel).min(1).max(7).optional(),
    maxOutputTokens: z.number().int().min(64).max(131072).default(65536),
    contextChars: z.number().int().min(4000).max(4000000).default(120000),
    timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const connectionSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    adapterId: id,
    purposes: z
      .array(z.enum(['generation', 'embedding', 'reranking', 'transcription']))
      .min(1)
      .max(4)
      .optional(),
    deployment: z.enum(['cloud', 'local', 'remote', 'harness']).default('cloud'),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const field = z.object({
  key: id,
  label: z.string(),
  type: z.enum(['text', 'textarea', 'string-list', 'number', 'boolean', 'path', 'select']),
  options: z.array(z.string()).optional(),
  optionLabels: z.record(z.string(), z.string()).optional(),
  pathMode: z.enum(['file', 'directory']).optional(),
});
export const adapterSchema = z.object({
  id,
  engine: id,
  label: z.string(),
  family: z.enum(['api', 'harness', 'local-runtime']),
  workerOnly: z.boolean().default(false),
  sessionBackend: z.boolean().default(false),
  connectionSchema: z.record(z.string(), z.unknown()),
  modelSchema: z.record(z.string(), z.unknown()),
  connectionFields: z.array(field),
  modelFields: z.array(field),
  generation: z.array(z.enum(['text', 'image'])),
  embedding: z.array(modality),
  embeddingProvider: id.optional(),
  reranking: z.array(modality).optional(),
  rerankingProvider: id.optional(),
  transcription: z.array(modality).optional(),
  transcriptionProvider: id.optional(),
  generationProvider: id.optional(),
  prepareModelProvider: id.optional(),
  modelCatalogProvider: id.optional(),
  modelIdentityField: z.string().optional(),
  embeddingIdentityFields: z.array(z.string()).optional(),
  presets: z
    .array(
      z.object({
        id,
        name: z.string(),
        model: z.string().optional(),
        generation: modelProfileSchema.shape.generation,
        embedding: modelProfileSchema.shape.embedding,
        options: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
});
export const taskSchema = z.object({
  id,
  owner: id.optional(),
  label: z.string(),
  operation: z.enum(['generate', 'embed', 'rerank', 'transcribe']),
  scope: z.enum(['character', 'shared']),
  inputs: z.array(modality).min(1),
  description: z.string().default(''),
});
export const generationInput = z.object({
  profile: profileSchema,
  messages: z.array(
    z.object({
      id: z.string().optional(),
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      text: z.string(),
      context: z.enum(['turn', 'event']).optional(),
      reply: replySubmission.optional(),
      native: transcriptMessage.optional(),
      images: z.array(z.object({ mimeType: z.string(), data: z.string() })).optional(),
    }),
  ),
  reasoning: reasoning.optional(),
  toolPolicy: z.enum(['none', 'scoped']).optional(),
});
export const generationOutput = z.object({
  text: z.string(),
  usage: z.record(z.string(), z.number()).optional(),
  nativeRunId: z.string().optional(),
  execution: z
    .object({
      model: z.string().optional(),
      requested: z.string().optional(),
      effort: z.string().optional(),
    })
    .optional(),
});
export const contentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(200000) }),
  ...(['image', 'audio', 'video'] as const).map((type) =>
    z.object({
      type: z.literal(type),
      mimeType: z.string().min(1),
      data: z
        .string()
        .min(1)
        .max(16000000)
        .refine(
          (s) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s),
          '媒体数据必须为 Base64 编码',
        ),
    }),
  ),
]);
export const embeddingItem = z.object({ content: z.array(contentPart).min(1).max(16) });
export const embeddingInput = z.object({
  profile: profileSchema,
  inputs: z.array(embeddingItem).min(1).max(256),
  purpose: z.enum(['query', 'document']).default('document'),
});
export const embeddingOutput = z.object({
  vectors: z.array(z.array(z.number().finite()).min(1)).min(1),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type AdapterDescriptor = z.infer<typeof adapterSchema>;
export type InferenceTask = z.infer<typeof taskSchema>;
export type Modality = z.infer<typeof modality>;
export const inferenceTasks = {
  chat: 'core.chat',
  vision: 'observation.vision',
  query: 'memory.query',
  semanticQuery: 'semantic.query',
  review: 'review.generate',
  embedding: 'embeddings.encode',
  rerank: 'semantic.rerank',
  rerankLanguage: 'semantic.rerank-language',
} as const;

export const modelKindSchema = z.object({
  id,
  label: z.string(),
  operation: z.enum(['generate', 'embed', 'rerank', 'transcribe']),
  capability: z.enum(['generation', 'embedding', 'reranking', 'transcription']),
  order: z.number().default(0),
});
export const rerankInput = z.object({
  profile: profileSchema,
  query: z.string().min(1).max(2000),
  documents: z.array(z.string().max(4000)).min(1).max(64),
});
export const rerankOutput = z
  .array(z.object({ index: z.number().int().min(0), score: z.number().finite() }))
  .max(64);
