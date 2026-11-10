import { z } from 'zod';

export const reasoningLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const reasoningLevel = z.enum(reasoningLevels);
export const reasoning = z.enum(['inherit', ...reasoningLevels]);
export const reasoningStyle = z.enum([
  'auto',
  'none',
  'effort',
  'enable_thinking',
  'chat_template',
  'deepseek',
]);
export const reasoningSupportSchema = z.object({
  source: z.enum(['host', 'upstream', 'catalog', 'manual']),
  kind: z.enum(['effort', 'toggle']).optional(),
  documentation: z.string().url().optional(),
  levels: z.array(reasoningLevel).max(7),
  default: reasoningLevel.optional(),
  style: reasoningStyle.optional(),
  wireValues: z.record(z.string(), z.string().nullable()).optional(),
  aliases: z.record(z.string(), reasoningLevel).optional(),
});
export const modelListingSchema = z.object({
  id: z.string().min(1).max(300),
  label: z.string().min(1).max(300),
  reasoning: reasoningSupportSchema.optional(),
});
export type ReasoningSupport = z.infer<typeof reasoningSupportSchema>;
export type ModelListing = z.infer<typeof modelListingSchema>;
