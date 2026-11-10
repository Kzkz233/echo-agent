import { z } from 'zod';
import { id, personaSchema, reasoning } from '../../packages/contracts/index.ts';
import { conversationPermissions } from '../../packages/contracts/interaction.ts';
import { contextCompaction } from '../../packages/contracts/compaction.ts';

export const characterTask = z.object({
  id,
  type: id,
  settings: z.record(z.string(), z.unknown()),
  templateId: id.optional(),
  enabledWhenAvailable: z.boolean().optional(),
});
export const characterDraft = z.object({
  persona: personaSchema.extend({ name: z.string().max(80) }),
  revision: z.number().int().min(0).default(0),
  features: z
    .array(id)
    .max(50)
    .refine((values) => new Set(values).size === values.length, '角色能力不可重复')
    .default([]),
  configurations: z.record(id, z.record(z.string(), z.unknown())).default({}),
  profileId: z.string().default(''),
  reasoning: reasoning.default('inherit'),
  routes: z.record(id, id).default({}),
  permissions: conversationPermissions.default(() => conversationPermissions.parse({})),
  compaction: contextCompaction.optional(),
  toolPermissions: z.array(id).max(200).default([]),
  independentToolGrants: z.boolean().default(false),
  tasks: z
    .array(characterTask)
    .max(50)
    .refine(
      (values) => new Set(values.map((task) => task.type + ':' + task.id)).size === values.length,
      '角色任务不可重复',
    )
    .default([]),
  package: z
    .object({
      id,
      version: z.string(),
      baseline: z.record(z.string(), z.unknown()),
      resolved: z.record(id, z.record(z.string(), z.unknown())).optional(),
    })
    .optional(),
});
export type CharacterDraft = z.infer<typeof characterDraft>;
export type CharacterRecord = {
  id: string;
  revision: number;
  features: string[];
  mainConversationId: string;
  routes: Record<string, string>;
  taskIds: { id: string; type: string; templateId?: string; enabledWhenAvailable?: boolean }[];
  toolPermissions?: string[];
  independentToolGrants?: boolean;
  state: 'configuring' | 'ready' | 'needs-attention';
  issue?: string;
  package?: CharacterDraft['package'];
};
export const characterPackage = z.object({
  format: z.literal('echo-character-v1'),
  id,
  version: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  description: z.string().max(2000).default(''),
  author: z.string().max(160).default(''),
  persona: personaSchema.omit({ id: true }),
  features: z
    .array(
      z.object({
        id,
        version: z.number().int().positive(),
        configuration: z.record(z.string(), z.unknown()),
        assets: z.record(z.string(), z.string().max(12000000)).optional(),
      }),
    )
    .max(50),
  tasks: z.array(characterTask).max(50).default([]),
});
export type CharacterPackage = z.infer<typeof characterPackage>;
