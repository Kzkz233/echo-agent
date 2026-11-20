import { z } from 'zod';
import { id } from './index.ts';

export const taskFailure = z.object({
  stage: z.enum(['execution', 'compaction', 'handoff', 'finalization']),
  category: z.enum(['network', 'timeout', 'auth', 'quota', 'rate', 'upstream', 'limit', 'checkpoint', 'other']),
  error: z.string(),
  model: z.string().optional(),
  connectionId: id.optional(),
  connectionName: z.string().optional(),
});
export type TaskFailure = z.infer<typeof taskFailure>;

// Plugins expose saved checkpoints through their own read and write operations.
export const failedTaskRuns = z.array(z.object({
  id, createdAt: z.string(), failure: taskFailure,
  checkpoint: z.object({
    completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
    resumeOperation: id.optional(), expectedProfileId: id.optional(),
  }).optional(),
}));
export type FailedTaskRun = z.infer<typeof failedTaskRuns>[number];

