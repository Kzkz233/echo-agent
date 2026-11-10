import { z } from 'zod';
const operation = z.string().regex(/^[a-z][A-Za-z0-9_.-]{1,199}$/);
export const frontendField = z.object({
  key: z.string().regex(/^[a-zA-Z][A-Za-z0-9_.-]{0,79}$/),
  label: z.string().min(1).max(200),
  type: z.enum(['text', 'textarea', 'number', 'boolean', 'select']),
  options: z.array(z.object({ value: z.string(), label: z.string() })).max(100).optional(),
  min: z.number().optional(), max: z.number().optional(),
});
export const frontendPageSchema = z.object({
  id: operation,
  title: z.string().min(1).max(100),
  placement: z.enum(['workspace', 'character', 'settings', 'plugin-settings']).default('workspace'),
  section: z.string().regex(/^[a-z][A-Za-z0-9_-]{0,80}$/).optional(),
  order: z.number().int().min(-1000).max(1000).default(0),
  view: z.discriminatedUnion('type', [
    z.object({ type: z.literal('form'), load: operation, save: operation.optional(),
      fields: z.array(frontendField).max(100), personaField: z.string().max(80).optional() }),
    z.object({ type: z.literal('webview'), entry: z.string().min(1).max(300),
      operations: z.array(operation).max(100).default([]) }),
  ]),
});
export type FrontendPage = z.infer<typeof frontendPageSchema>;
export type FrontendPageEntry = FrontendPage & { owner: string; ownerName: string };
