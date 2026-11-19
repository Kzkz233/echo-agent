import { z } from 'zod';
import { invariant } from '../contracts/index.ts';
import type { Capabilities } from './capabilities.ts';

type Scope = ReturnType<Capabilities['forOwner']>;
const point = 'core.lifecycle.participants@1';
const command = z.object({
  action: z.enum(['prepare', 'seal', 'resume']),
  requestId: z.string().uuid(),
});
const response = z.object({ blockers: z.array(z.string().min(1).max(300)).max(50) });
type Action = z.infer<typeof command>['action'];

export function contributeMaintenance(
  scope: Scope,
  id: string,
  label: string,
  participant: {
    prepare: () => void;
    blockers: () => string[];
    seal?: () => void;
    resume: () => void;
  },
) {
  let lease: string | undefined;
  let prepared = false;
  return scope.provide(point, id, label, (input: z.infer<typeof command>) => {
    if (input.action === 'resume') {
      if (lease === input.requestId) {
        participant.resume();
        lease = undefined;
        prepared = false;
      }
      return { blockers: [] };
    }
    invariant(!lease || lease === input.requestId, 'maintenance_busy', '已有重启请求');
    lease = input.requestId;
    if (!prepared) {
      participant.prepare();
      prepared = true;
    }
    const blockers = participant.blockers();
    if (!blockers.length && input.action === 'seal') participant.seal?.();
    return { blockers };
  });
}

/** One restart leases admission from each participant until cancellation or process exit. */
export class Maintenance {
  private contacted = new Map<string, string>();
  constructor(readonly core: Scope) {
    core.define({
      id: point,
      description: '暂停接收新工作、核验安全点和取消暂停',
      input: command,
      output: response,
      providePermission: 'lifecycle.contribute',
      consumePermission: 'system.write',
      ownerCallsOnly: true,
      cardinality: 'many',
    });
  }
  private members() {
    return this.core
      .list(point)
      .filter((p) => p.state !== 'denied')
      .map((p) => ({
        ...p,
        token: this.core.instanceKey(point, p.id),
      }));
  }
  async inspect(action: Action, requestId: string, signal?: AbortSignal) {
    const members = this.members();
    const problems = await Promise.all(
      members.map(async (p) => {
        if (action === 'resume' && this.contacted.get(p.id) !== p.token) return [];
        if (p.state !== 'active' || !p.token) return [p.label];
        this.contacted.set(p.id, p.token);
        // Commands acknowledge the gate immediately. Draining work is reported as blockers.
        const bounded = AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]);
        let abort!: () => void;
        try {
          bounded.throwIfAborted();
          const timedOut = new Promise<never>((_, reject) => {
            abort = () => reject(bounded.reason);
            bounded.addEventListener('abort', abort, { once: true });
          });
          const reply = await Promise.race([
            this.core.invoke(point, p.id, { action, requestId }, bounded),
            timedOut,
          ]);
          const { blockers } = response.parse(reply);
          if (action === 'resume' && !blockers.length) this.contacted.delete(p.id);
          return blockers;
        } catch {
          return [p.label];
        } finally {
          if (abort) bounded.removeEventListener('abort', abort);
        }
      }),
    );
    signal?.throwIfAborted();
    const same = () => {
      const now = this.members();
      return (
        members.length === now.length &&
        members.every(
          (p, i) => now[i].id === p.id && now[i].token === p.token && now[i].state === p.state,
        )
      );
    };
    if (action === 'resume')
      for (const [id, token] of this.contacted)
        if (this.core.instanceKey(point, id) !== token) this.contacted.delete(id);
    return { blockers: problems.flat(), same };
  }
}
