import { z } from 'zod';
import { invariant } from '../contracts/index.ts';
import type { Capabilities } from './capabilities.ts';
import type { PluginContext } from './registry.ts';
import { providerSnapshot } from './provider-snapshot.ts';

const point = 'core.jobs.sources@1';
export const jobSummary = z.object({
  id: z.string(),
  state: z.string(),
  title: z.string().optional(),
  phase: z.string().optional(),
  requestId: z.string().optional(),
  taskId: z.string().optional(),
  taskType: z.string().optional(),
  conversationId: z.string().optional(),
  parentId: z.string().optional(),
  personaId: z.string().optional(),
  completed: z.number().optional(),
  total: z.number().optional(),
  error: z.string().optional(),
  createdAt: z.string().optional(),
  controls: z.array(z.enum(['pause', 'resume', 'cancel'])).default([]),
});
export type JobSummary = z.infer<typeof jobSummary>;
export function contributeJobs(
  ctx: PluginContext,
  id: string,
  label: string,
  list: () => JobSummary[] | Promise<JobSummary[]>,
  control?: (action: string, id: string, signal: AbortSignal) => unknown,
) {
  return ctx.capabilities.provide(point, id, label, async (v, signal) => {
    if (v.action !== 'list') {
      const row = (await list()).find((j) => j.id === v.id);
      invariant(
        row?.controls.includes(v.action) && control,
        'job_control',
        '此任务当前不支持该操作',
      );
      await control(v.action, v.id, signal);
    }
    return { jobs: await list() };
  });
}
export class Jobs {
  constructor(readonly core: ReturnType<Capabilities['forOwner']>) {
    core.define({
      id: point,
      description: 'Unified projections of existing domain jobs; no second scheduler',
      input: z.object({
        action: z.enum(['list', 'pause', 'resume', 'cancel']),
        id: z.string().optional(),
      }),
      output: z.object({ jobs: z.array(jobSummary) }),
      providePermission: 'automation.contribute',
      consumePermission: 'automation.read',
    });
  }
  async list(signal?: AbortSignal) {
    const rows = await Promise.all(
      this.core
        .list(point)
        .filter((p) => p.state === 'active')
        .map(async (p) => {
          try {
            const result = (await providerSnapshot(
              (s) => this.core.invoke(point, p.id, { action: 'list' }, s),
              signal,
            )) as { jobs: JobSummary[] };
            return result.jobs.map((j) => ({
              ...j,
              source: p.id,
              nativeId: j.id,
              id: p.id + '/' + j.id,
            }));
          } catch (e) {
            return [
              {
                id: p.id + '/unavailable',
                nativeId: '',
                source: p.id,
                state: 'unavailable',
                controls: [],
                error: String((e as Error).message),
              },
            ];
          }
        }),
    );
    return rows.flat();
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel', signal: AbortSignal) {
    const row = (await this.list(signal)).find((j) => j.id === id);
    invariant(row && row.nativeId, 'job_missing', '任务记录不存在');
    invariant(row.controls.includes(action), 'job_control', '此任务当前不支持该操作');
    return this.core.invoke(point, row.source, { action, id: row.nativeId }, signal);
  }
}
