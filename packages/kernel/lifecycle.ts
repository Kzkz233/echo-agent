import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { invariant } from '../contracts/index.ts';
import type { Application } from '../../apps/server/application.ts';

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
  constructor(readonly app: Application) {}
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
    invariant(!this.controller, 'maintenance_busy', '已有重启或退出请求');
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
    this.app.router.pauseAdmission();
    this.app.clock.pause();
    this.app.events.emit('system.maintenance', { paused: true });
    this.task = (async () => {
      try {
        // Domain providers decide which work has a safe checkpoint. No generic replay.
        for (const job of await this.app.jobs.list())
          if (['running', 'queued'].includes(job.state) && job.controls.includes('pause')) {
            await this.app.jobs.control(job.id, 'pause', controller.signal);
            this.app.store.set('system.maintenance.paused-jobs', [
              ...new Set([
                ...this.app.store.get<string[]>('system.maintenance.paused-jobs', []),
                job.id,
              ]),
            ]);
          }
        const deadline = Date.now() + timeoutSeconds * 1000;
        while (!controller.signal.aborted) {
          const jobs = await this.app.jobs.list();
          request.blockers = [
            ...(this.dirty.size ? ['有尚未保存的编辑'] : []),
            ...jobs
              .filter((j) => ['running', 'queued', 'pausing', 'unavailable'].includes(j.state))
              .map((j) => j.id),
            ...(!this.app.router.idle || this.app.clock.active ? ['后台执行尚未到达安全点'] : []),
            ...(this.app.store.documents<any>('channel-outbound').some((j) => j.state === 'sending')
              ? ['消息仍在投递']
              : []),
          ];
          if (!request.blockers.length) {
            request.state = 'ready';
            this.app.events.emit('system.lifecycle', { ...request });
            return;
          }
          if (Date.now() >= deadline) throw Error('等待安全点超时：' + request.blockers.join('；'));
          await delay(250, undefined, { signal: controller.signal });
        }
      } catch (error) {
        if (request.state !== 'cancelled') {
          request.state = 'failed';
          (request as any).error = controller.signal.aborted
            ? '请求已取消'
            : String((error as Error).message);
        }
        if (!this.closed) this.restore();
      }
    })();
    return request;
  }
  restore() {
    this.controller?.abort();
    this.controller = undefined;
    this.app.clock.resume();
    this.app.router.resumeAfterUpdateFailure();
    this.app.registry.resumeAfterUpdateFailure();
    this.app.events.emit('system.maintenance', { paused: false });
    void this.resumeSaved();
  }
  async close() {
    this.closed = true;
    this.app.events.emit('system.lifecycle.closed', {});
    this.controller?.abort();
    await this.task;
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
        if (job?.state === 'paused' && job.controls.includes('resume'))
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
  handoff(id: string) {
    invariant(
      this.requestValue?.id === id && this.requestValue.state === 'ready' && !this.dirty.size,
      'maintenance_stale',
      '请等待任务结束并保存编辑',
    );
    this.app.router.pauseForUpdate();
    this.app.registry.beginUpdate();
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
    op('cancel', z.object({}), true, () => {
      if (this.requestValue) this.requestValue.state = 'cancelled';
      this.restore();
      return this.status();
    });
    op('fail', z.object({ id: z.string(), error: z.string().max(2000) }), true, (v) => {
      const request = this.requestValue;
      if (request && request.id === v.id) {
        request.state = 'failed';
        request.error = v.error;
        this.restore();
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
