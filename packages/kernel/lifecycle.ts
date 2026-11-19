import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { invariant } from '../contracts/index.ts';
import type { Store } from './store.ts';
import type { Registry } from './registry.ts';
import type { Events } from './events.ts';
import type { Jobs } from './jobs.ts';
import type { Updates } from './updates.ts';
import type { Maintenance } from './maintenance.ts';
type Services = { store:Store; registry:Registry; events:Events; jobs:Jobs; updates:Pick<Updates,'status'> };

/** Desktop owns process exit. The backend drains work and hands over an identified request. */
export class Lifecycle {
  private controller?: AbortController;
  private dirty = new Set<string>();
  private closed = false;
  private task?: Promise<void>;
  private recovery?: Promise<void>;
  private requestValue?: {
    id: string;
    action: 'restart' | 'stop' | 'update';
    updateId?: string;
    state: string;
    blockers: string[];
    error?: string;
  };
  private lease?:string;
  private releasing?:Promise<void>;
  constructor(readonly app: Services, readonly maintenance:Maintenance) {}
  status(): {
    id?: string;
    action?: string;
    updateId?: string;
    state: string;
    blockers: string[];
    error?: string;
  } {
    return this.requestValue ?? { state: 'idle', blockers: [] };
  }
  setDirty(window: string, dirty: boolean) {
    if (dirty) this.dirty.add(window);
    else this.dirty.delete(window);
    return { accepted: true };
  }
  request(action: 'restart' | 'stop' | 'update', timeoutSeconds = 300, updateId?: string) {
    invariant(process.env.ECHO_DESKTOP_PID, 'desktop_required', '此安装没有可管理的桌面宿主');
    invariant(!this.controller && !this.lease && !this.releasing, 'maintenance_busy', '已有重启或退出请求');
    const request = {
      id: randomUUID(),
      action,
      updateId,
      state: 'waiting',
      blockers: [] as string[],
    };
    this.requestValue = request;
    const controller = new AbortController();
    this.controller = controller;
    this.lease = request.id;
    this.app.events.emit('system.maintenance', { paused: true });
    this.task = (async () => {
      try {
        const wait = AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutSeconds*1000)]);
        await this.maintenance.inspect('prepare',request.id,wait);
        // Domain providers decide which work has a safe checkpoint. No generic replay.
        for (const job of await this.app.jobs.list(wait))
          if (['running', 'queued'].includes(job.state) && job.controls.includes('pause')) {
            wait.throwIfAborted();
            this.app.store.set('system.maintenance.paused-jobs', [
              ...new Set([
                ...this.app.store.get<string[]>('system.maintenance.paused-jobs', []),
                job.id,
              ]),
            ]);
            await this.app.jobs.control(job.id, 'pause', wait);
          }
        const deadline = Date.now() + timeoutSeconds * 1000;
        while (!controller.signal.aborted) {
          const [jobs,participants] = await Promise.all([this.app.jobs.list(wait),this.maintenance.inspect('prepare',request.id,wait)]);
          wait.throwIfAborted();
          request.blockers = [
            ...(this.dirty.size ? ['有尚未保存的编辑'] : []),
            ...jobs
              .filter((j) => ['running', 'queued', 'pausing', 'unavailable'].includes(j.state))
              .map((j) => j.id),
            ...participants.blockers,
          ];
          if (!request.blockers.length && participants.same()) {
            request.state = 'ready';
            this.app.events.emit('system.lifecycle', { ...request });
            return;
          }
          if (Date.now() >= deadline) throw Error('等待安全点超时：' + request.blockers.join('；'));
          await delay(250, undefined, { signal: controller.signal });
        }
      } catch (error) {
        if (this.lease !== request.id || controller.signal.aborted) return;
        if (request.state !== 'cancelled') {
          request.state = 'failed';
          (request as any).error = controller.signal.aborted
            ? '请求已取消'
            : String((error as Error).message);
        }
        if (!this.closed) await this.restore().catch(e => { (request as any).error = String(e); });
      }
    })();
    return request;
  }
  async freeze() {
    invariant(!this.releasing, 'update_busy','正在恢复任务。');
    const lease = this.lease ??= randomUUID();
    const signal = this.controller?.signal;
    const [jobs, participants] = await Promise.all([this.app.jobs.list(signal),this.maintenance.inspect('prepare',lease,signal)]);
    signal?.throwIfAborted();
    invariant(this.lease === lease && !this.dirty.size && !participants.blockers.length && participants.same() &&
      !jobs.some(j => ['running','queued','pausing','unavailable'].includes(j.state)),
      'update_busy','后台任务或消息投递仍在执行，请完成后再更新。');
    const sealed = await this.maintenance.inspect('seal',lease,signal);
    invariant(this.lease === lease && !this.dirty.size && !sealed.blockers.length && sealed.same() && participants.same(),'update_busy','后台任务仍在执行。');
    this.app.registry.beginUpdate();
  }
  restore() {
    if (this.releasing) return this.releasing;
    const lease = this.lease;
    this.controller?.abort();
    this.releasing = (async () => {
      this.app.registry.resumeAfterUpdateFailure();
      if (lease) {
        const {blockers} = await this.maintenance.inspect('resume',lease);
        invariant(!blockers.length,'maintenance_recovery','尚未恢复：'+blockers.join('、'));
      }
      this.controller = undefined;
      this.lease = undefined;
      this.app.events.emit('system.maintenance', { paused: false });
      await this.resumeSaved();
    })().finally(() => { this.releasing = undefined; });
    return this.releasing;
  }
  async close() {
    this.closed = true;
    this.app.events.emit('system.lifecycle.closed', {});
    this.controller?.abort();
    await this.task;
    await this.releasing;
    await this.recovery;
  }
  resumeSaved() {
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      if (process.env.ECHO_UPDATE_TRANSACTION)
        for (let n = 0; n < 360 && !this.closed; n++) {
          const status = await this.app.updates.status();
          if (status.journal?.phase === 'complete') break;
          await delay(250);
        }
      if (this.closed) return;
      const ids = this.app.store.get<string[]>('system.maintenance.paused-jobs', []);
      for (const id of ids) {
        if (this.closed) return;
        const job = (await this.app.jobs.list()).find((j) => j.id === id);
        if (!job || job.state === 'unavailable' || job.state === 'pausing') continue;
        if (job.state === 'paused' && job.controls.includes('resume'))
          await this.app.jobs.control(id, 'resume', new AbortController().signal);
        this.app.store.set(
          'system.maintenance.paused-jobs',
          this.app.store
            .get<string[]>('system.maintenance.paused-jobs', [])
            .filter((j) => j !== id),
        );
      }
    })()
      .catch((error) => {
        if (!this.closed)
          this.app.store.set('system.maintenance.recovery-issue', String((error as Error).message));
      })
      .finally(() => {
        this.recovery = undefined;
      });
    return this.recovery;
  }
  async host(pid: number, signal: AbortSignal) {
    invariant(pid === Number(process.env.ECHO_DESKTOP_PID), 'desktop_identity', '桌面实例不匹配');
    if (this.requestValue?.state === 'ready') return this.requestValue;
    if (this.closed) return null;
    return new Promise<unknown>((resolve, reject) => {
      let off = () => {};
      let timer: ReturnType<typeof setTimeout>;
      const done = (value: unknown, error = false) => {
        off();
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(value);
        else resolve(value);
      };
      const abort = () => done(signal.reason, true);
      off = this.app.events.subscribe((event) => {
        if (event.type === 'system.lifecycle' && this.requestValue?.state === 'ready')
          done(this.requestValue);
        else if (event.type === 'system.lifecycle.closed') done(null);
      });
      timer = setTimeout(() => done(null), 25000);
      timer.unref();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async handoff(id: string) {
    invariant(
      this.requestValue?.id === id && this.requestValue.state === 'ready' && !this.dirty.size,
      'maintenance_stale',
      '请等待任务结束并保存编辑',
    );
    await this.freeze();
    this.requestValue.state = 'handed-off';
    return { accepted: true };
  }
  register() {
    const op = (
      name: string,
      input: z.ZodType,
      write: boolean,
      run: (v: any, signal: AbortSignal) => unknown,
    ) =>
      this.app.registry.register({
        name: 'system.lifecycle.' + name,
        owner: 'core',
        description: 'Echo 安全生命周期管理',
        mcp: false,
        permission: write ? 'system.write' : 'system.read',
        input,
        output: z.unknown(),
        run: (v, _c, s) => run(v, s),
      });
    op('status', z.object({}), false, () => this.status());
    op(
      'request',
      z.object({
        action: z.enum(['restart', 'stop', 'update']),
        timeoutSeconds: z.number().int().min(1).max(1800).default(300),
        updateId: z.string().optional(),
      }),
      true,
      (v) => this.request(v.action, v.timeoutSeconds, v.updateId),
    );
    op('cancel', z.object({}), true, async () => {
      if (this.requestValue) this.requestValue.state = 'cancelled';
      await this.restore();
      return this.status();
    });
    op('fail', z.object({ id: z.string(), error: z.string().max(2000) }), true, async (v) => {
      const request = this.requestValue;
      if (request && request.id === v.id) {
        request.state = 'failed';
        request.error = v.error;
        await this.restore();
      }
      return this.status();
    });
    op('dirty', z.object({ window: z.string().min(1).max(200), dirty: z.boolean() }), true, (v) =>
      this.setDirty(v.window, v.dirty),
    );
    op('host', z.object({ pid: z.number().int().positive() }), true, (v, s) => this.host(v.pid, s));
    op('handoff', z.object({ id: z.string() }), true, (v) => this.handoff(v.id));
  }
}
