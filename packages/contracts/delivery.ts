import { z } from 'zod';

const key = z.string().min(1).max(200);
export const outputTargets = z
  .array(key)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length);
export const outputTask = z.object({ type: key, id: key });
export const channelTextMode = z.enum(['auto', 'combined']);
export type ChannelTextMode = z.infer<typeof channelTextMode>;
export const replySubmission = z.object({
  targetId: key,
  phase: z.enum(['progress', 'final']),
  title: z.string().trim().min(1).max(200).optional(),
  messages: z.array(z.string().trim().min(1).max(20000)).min(1).max(3),
}).strict();
export type ReplySubmission = z.infer<typeof replySubmission>;
export const outputTarget = z.object({
  id: key,
  label: z.string().max(200),
  revision: z.string().max(200),
  ready: z.boolean().default(true),
  issue: z.string().max(500).optional(),
  portable: z.boolean().default(false),
  supportsImages: z.boolean().default(false),
  presentation: z.enum(['bubble', 'external']).optional(),
  style: key.optional(),
  initialStyle: z.string().max(600).optional(),
  legacySources: z.array(z.string()).default([]),
});
export const deliveryPlan = z.object({
  targets: z.array(outputTarget.extend({ provider: key, owner: key })).max(20),
  source: z.string().min(1).max(100),
  task: outputTask.optional(),
  replyTo: z.string().min(1).max(300).optional(),
});
export const outputEnvelope = z.object({
  id: key,
  personaId: key,
  conversationId: key,
  messageId: key.optional(),
  text: z.string().max(100000),
  title: z.string().max(200).optional(),
  parts: replySubmission.shape.messages.optional(),
  plan: deliveryPlan,
});
export const deliveryResult = z.object({
  state: z.enum(['delivered', 'queued', 'failed', 'unknown', 'skipped', 'closed']),
  reason: z.string().max(1000).optional(),
  receipt: z.unknown().optional(),
});
export const deliveryRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), personaId: key, conversationId: key }),
  z.object({
    action: z.enum(['deliver', 'inspect']),
    targetId: key,
    revision: key,
    envelope: outputEnvelope,
    idempotencyKey: key,
  }),
]);
export type DeliveryPlan = z.infer<typeof deliveryPlan>;
export type OutputEnvelope = z.infer<typeof outputEnvelope>;
export type OutputTarget = z.infer<typeof outputTarget>;
export type DeliveryResult = z.infer<typeof deliveryResult>;
export const deliveryPoint = 'core.outputs.targets@1';
