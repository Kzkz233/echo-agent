import { z } from 'zod';
import { id, reasoning } from './index.ts';
import { contextCompaction } from './compaction.ts';

const optionalOutput = z.preprocess(
  value => value === '' || value === null ? undefined : value,
  z.number().int().min(64).max(131072).optional(),
);
/** Shared by delegated work and automation-owned agent sessions. */
export const executionRequest = z.object({
  profileId: id.optional(),
  reasoning: reasoning.optional(),
  projectDirectory: z.string().optional(),
  workspaces: z.array(z.object({ path: z.string().min(1), write: z.boolean().default(false) })).max(20).optional(),
  write: z.boolean().optional(),
  fullAccess: z.boolean().optional(),
  terminal: z.boolean().optional(),
  timeoutMinutes: z.number().int().min(1).max(120).optional(),
  prompt: z.string().max(12000).optional(),
  toolPermissions: z.array(id).max(200).optional(),
  compaction: contextCompaction.optional(),
  maxOutputTokens: optionalOutput,
  workerRecall: z.boolean().optional(),
  contextBlocks: z.array(id).max(200).optional(),
}).strict();
export type ExecutionRequest = z.infer<typeof executionRequest>;
export const resultReporting = z.object({
  report: z.boolean().default(true),
  reportPrompt: z.string().max(10000).default(''),
  outputTargets: z.array(z.string().min(1)).max(20).optional(),
});
export type WorkOrigin = { type: string; id: string; name: string; owner: string };
export type WorkAuthority = {
  owner: string;
  taskType: string;
  taskId: string;
  permissions: string[];
  memoryOperations?: string[];
  active: boolean;
  writeReady?: boolean;
  allowedSources?: string[];
  memoryReadRequired?: boolean;
  coreApproval?: { executor: string; payload: Record<string, unknown> };
};
