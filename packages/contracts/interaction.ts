import { z } from 'zod';

export const conversationPermissions = z.object({
  echoTools: z.array(z.string().min(1).max(160)).max(200).optional(),
  projectDirectory: z.string().max(4096).default(''),
  primaryReadOnly: z.boolean().optional(),
  readRoots: z.array(z.string().min(1).max(4096)).max(20).optional(),
  writeRoots: z.array(z.string().min(1).max(4096)).max(20).optional(),
  codex: z
    .object({
      sandbox: z.enum(['read-only', 'workspace-write']).default('read-only'),
      approvals: z.enum(['deny', 'ask']).default('deny'),
    })
    .default({ sandbox: 'read-only', approvals: 'deny' }),
  dsh: z
    .object({ approvals: z.enum(['deny', 'ask']).default('deny') })
    .default({ approvals: 'deny' }),
  pi: z
    .object({
      tools: z.enum(['none', 'read', 'ask']).default('read'),
      echoTools: z.enum(['none', 'read', 'ask', 'granted']).optional(),
      projectWrite: z.boolean().default(false),
      fullAccess: z.boolean().optional(),
      fileApproval: z.enum(['ask', 'allow']).optional(),
      terminal: z.boolean().optional(),
    })
    .default({ tools: 'read', projectWrite: false }),
});
export type ConversationPermissions = z.infer<typeof conversationPermissions>;

const bounded = z.string().min(1).max(1200);
const question = z.object({
  id: z.string().min(1).max(160),
  text: bounded,
  detail: z.string().max(32000).optional(),
  options: z
    .array(z.object({ label: bounded, description: z.string().max(2400).optional() }))
    .max(12),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
  secret: z.boolean().optional(),
});
export const hostInteractionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approval'),
    title: bounded,
    detail: z.string().max(32000).optional(),
    canAllow: z.boolean().default(true),
    workspaceWrite: z.object({ path: z.string().max(4096), operation: z.enum(['edit', 'write']) }).optional(),
  }),
  z.object({ kind: z.literal('questions'), questions: z.array(question).min(1).max(8) }),
]);
export type HostInteraction = z.input<typeof hostInteractionSchema>;
export const hostAnswerSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }),
  z.object({ decision: z.literal('deny') }),
  z.object({ decision: z.literal('cancel') }),
  z.object({
    decision: z.literal('answer'),
    answers: z
      .array(
        z.object({
          id: z.string().min(1).max(160),
          selected: z.array(bounded).max(12),
          custom: z.string().trim().min(1).max(4000).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
]);
export type HostAnswer = z.infer<typeof hostAnswerSchema>;
export type PendingInteraction = z.infer<typeof hostInteractionSchema> & {
  id: string;
  conversationId: string;
  runId: string;
};
