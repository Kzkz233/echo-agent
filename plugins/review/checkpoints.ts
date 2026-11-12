import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invariant } from '../../packages/contracts/index.ts';
import type { Store } from '../../packages/kernel/store.ts';
import type { ReviewJob } from './index.ts';

export const candidateSchema = z.object({ title: z.string().min(1).max(160),
  text: z.string().min(1).max(12000), sources: z.array(z.string()).min(1).max(50) });
export type Candidate = z.infer<typeof candidateSchema> & { id: string; jobId: string; packetIndex: number;
  state: 'pending' | 'changed' | 'unchanged'; reason?: string; receipts?: string[] };
const packetKey = (job: ReviewJob, index: number) => JSON.stringify([job.id, index]);
export const candidateNamespace = (jobId: string) => 'review-candidates.' + jobId;
export function checkpoint(store: Store, job: ReviewJob, index: number, candidates: z.infer<typeof candidateSchema>[]) {
  invariant(index >= 0 && index < job.nextPacket, 'review_packet', '只能为已读取的材料建立检查点。');
  const allowed = new Set(job.packets[index].sources);
  invariant(candidates.every(row => row.sources.every(source => allowed.has(source))), 'review_sources', '候选来源不属于本段材料。');
  const fingerprint = createHash('sha256').update(JSON.stringify(candidates)).digest('hex');
  const key = packetKey(job, index);
  const old = store.document<{ fingerprint: string; ids: string[] }>('review-checkpoints', key);
  if (old) {
    invariant(old.fingerprint === fingerprint, 'review_checkpoint_conflict', '本段检查点已保存，请沿用已保存的候选，勿覆盖。');
    return old.ids;
  }
  return store.transaction(() => {
    const ids = [...new Set(candidates.map(value => {
      const id = createHash('sha256').update(JSON.stringify([job.id, index, value])).digest('hex').slice(0, 32);
      store.put(candidateNamespace(job.id), id, { ...value, id, jobId: job.id, packetIndex: index, state: 'pending' } satisfies Candidate);
      return id;
    }))];
    store.put('review-checkpoints', key, { fingerprint, ids }); return ids;
  });
}
export function readingComplete(store: Store, job: ReviewJob) {
  return job.nextPacket === job.packets.length && (!job.checkpointFlow ||
    job.packets.every((_, index) => index < job.checkpointFlow!.startPacket || !!store.document('review-checkpoints', packetKey(job, index))));
}
export const candidatesFor = (store: Store, jobId: string) => store.documents<Candidate>(candidateNamespace(jobId))
  .sort((a, b) => a.packetIndex - b.packetIndex || a.id.localeCompare(b.id));
