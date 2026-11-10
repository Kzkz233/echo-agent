import { contributeAutomation, type AutomationField } from '../../packages/kernel/automation.ts';
import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { z } from 'zod';
import { id, invariant, SafeTaskFailure } from '../../packages/contracts/index.ts';
import { Clock } from '../../packages/kernel/clock.ts';
import { nextDaily } from '../../packages/kernel/time.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Events } from '../../packages/kernel/events.ts';
import type { Plugin, PluginContext } from '../../packages/kernel/registry.ts';
import { operations } from '../shared.ts';
export const jobSchema = z.object({
  id,
  name: z.string().min(1).max(160),
  provider: z.string(),
  input: z.unknown().default({}),
  enabled: z.boolean().default(false),
  mode: z.enum(['interval', 'daily']),
  minutes: z.number().int().min(1).max(525600).default(60),
  hour: z.number().int().min(0).max(23).default(7),
  minute: z.number().int().min(0).max(59).default(0),
  timezone: z.string().default('Asia/Shanghai'),
});
type Job = z.infer<typeof jobSchema> & { nextAt?: number; blocked?: string };
type Execution = {
  id: string;
  jobId: string;
  provider: string;
  slot: number;
  state: 'running' | 'succeeded' | 'failed' | 'unknown';
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
};
export class Scheduler {
  private ctx?: PluginContext;
  private running = new Set<string>();
  private disposers = new Map<string, () => void>();
  constructor(
    readonly store: Store,
    readonly events: Events,
    readonly clock: Clock,
  ) {
    for (const e of store.documents<Execution>('scheduler-runs'))
      if (e.state === 'running')
        store.put('scheduler-runs', e.id, { ...e, state: 'unknown', error: '进程中断，未重放。' });
  }
  jobs() {
    return this.store.documents<Job>('scheduler-jobs');
  }
  private next(job: Job, now = Date.now()) {
    return job.mode === 'interval'
      ? now + job.minutes * 60000
      : nextDaily(new Date(now), job.hour, job.minute, job.timezone);
  }
  save(value: unknown) {
    const job = jobSchema.parse(value);
    new Intl.DateTimeFormat('en', { timeZone: job.timezone });
    const old = this.store.document<Job>('scheduler-jobs', job.id);
    const next = { ...job, nextAt: this.next(job), blocked: old?.blocked };
    this.store.put('scheduler-jobs', job.id, next);
    this.refresh();
    return next;
  }
  refresh() {
    for (const off of this.disposers.values()) off();
    this.disposers.clear();
    if (!this.ctx) return;
    const available = new Set(
      this.ctx.capabilities
        .list('scheduler.handlers@1')
        .filter((p) => p.state === 'active')
        .map((p) => p.id),
    );
    for (const j of this.jobs())
      if (j.enabled && !j.blocked && available.has(j.provider) && !this.running.has(j.id)) {
        const nextAt = j.nextAt ?? this.next(j);
        this.store.put('scheduler-jobs', j.id, { ...j, nextAt });
        this.disposers.set(
          j.id,
          this.clock.at('scheduler.' + j.id, nextAt, () => this.execute(j.id, nextAt)),
        );
      }
  }
  async execute(jobId: string, slot = Date.now()) {
    invariant(this.ctx, 'plugin_disabled', '调度插件未启用');
    const job = this.store.document<Job>('scheduler-jobs', jobId);
    invariant(job, 'job_missing', '任务不存在');
    const key = job.id + '.' + slot;
    const existing = this.store.document<Execution>('scheduler-runs', key);
    if (existing) return existing;
    invariant(!this.running.has(jobId), 'job_busy', '任务正在执行');
    invariant(!job.blocked, 'job_unknown', '请先核对未知执行');
    this.running.add(jobId);
    let execution: Execution = {
      id: key,
      jobId,
      provider: job.provider,
      slot,
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    this.store.put('scheduler-runs', key, execution);
    try {
      const result = await this.ctx.capabilities.invoke('scheduler.handlers@1', job.provider, {
        input: job.input,
        executionId: key,
        scheduledAt: new Date(slot).toISOString(),
      });
      execution = { ...execution, state: 'succeeded', result };
    } catch (e) {
      const knownFailure = e instanceof SafeTaskFailure;
      execution = {
        ...execution,
        state: knownFailure ? 'failed' : 'unknown',
        error: e instanceof Error ? e.message.slice(0, 500) : '没有取得确定回执',
      };
      if (!knownFailure)
        this.store.put('scheduler-jobs', jobId, {
          ...this.store.document<Job>('scheduler-jobs', jobId)!,
          blocked: key,
        });
    } finally {
      execution.finishedAt = new Date().toISOString();
      this.store.put('scheduler-runs', key, execution);
      const current = this.store.document<Job>('scheduler-jobs', jobId);
      if (current)
        this.store.put('scheduler-jobs', jobId, { ...current, nextAt: this.next(current) });
      this.running.delete(jobId);
      this.refresh();
      this.events.emit('scheduler.updated', { id: key, state: execution.state });
    }
    return execution;
  }
  private runOnce(id: string, requestId: string) {
            const key = 'scheduler.request.' + requestId;
            const found = this.store.get<{ jobId: string; slot: number } | undefined>(
              key,
              undefined,
            );
            invariant(
              !found || found.jobId === id,
              'idempotency_conflict',
              '同一请求编号不能执行不同任务',
            );
            const slot = found?.slot ?? Date.now();
            if (!found) this.store.set(key, { jobId: id, slot });
            return this.execute(id, slot);
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(packageManifest),
      references: (id) => this.jobs().filter((job) =>
        (job.input as { conversationId?: string } | undefined)?.conversationId === id)
        .map((job) => ({ label: job.name, page: 'automation', role: 'report',
          enabled: job.enabled, type: 'scheduler.timed', taskId: job.id })),
      activate: (ctx) => {
        this.ctx = ctx;
        ctx.capabilities.define({
          id: 'scheduler.handlers@1',
          description: '业务插件可提供的任务处理器',
          input: z.object({
            input: z.unknown(),
            executionId: z.string(),
            scheduledAt: z.iso.datetime(),
          }),
          output: z.unknown(),
          providePermission: 'scheduler.contribute',
          consumePermission: 'scheduler.execute',
          cardinality: 'many',
        });
        const describe = (mail: boolean) => {
          const providers = ctx.capabilities.list('scheduler.handlers@1').filter((p) => p.state === 'active');
          const accounts = this.store.documents<{ id: string; name?: string; address?: string; username?: string }>('mail-accounts');
          const jobs = this.jobs().filter((job) => (job.provider === 'mail.sync') === mail);
          if (mail && !jobs.length && !providers.some((p) => p.id === 'mail.sync')) return;
          const fields: AutomationField[] = [
            ...(mail ? [{ key: 'accountId', label: '邮箱账户', kind: 'select' as const,
              options: accounts.map((a) => ({ value: a.id, label: a.name ?? a.address ?? a.username ?? a.id })) }]
              : [{ key: 'provider', label: '任务处理器', kind: 'select' as const,
                options: providers.filter((p) => p.id !== 'mail.sync').map((p) => ({ value: p.id, label: p.label })) },
                { key: 'input', label: '任务参数', kind: 'json' as const }]),
            { key: 'mode', label: '执行周期', kind: 'select', options: [{ value: 'interval', label: '按间隔' }, { value: 'daily', label: '每日' }] },
            { key: 'minutes', label: '间隔（分钟）', kind: 'number', min: 1, max: 525600, when: { key: 'mode', value: 'interval' } },
            { key: 'hour', label: '小时', kind: 'number', min: 0, max: 23, when: { key: 'mode', value: 'daily' } },
            { key: 'minute', label: '分钟', kind: 'number', min: 0, max: 59, when: { key: 'mode', value: 'daily' } },
            { key: 'timezone', label: '时区', kind: 'text', when: { key: 'mode', value: 'daily' } },
          ];
          const executions = this.store.documents<Execution>('scheduler-runs')
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
          return {
            defaults: { mode: 'interval', minutes: 60, hour: 7, minute: 0, timezone: 'Asia/Shanghai', input: {} },
            fields,
            items: jobs.map((job) => {
              const latest = executions.find((run) => run.jobId === job.id);
              const accountId = (job.input as { accountId?: string } | undefined)?.accountId;
              return {
                id: job.id, name: job.name, enabled: job.enabled,
                state: (this.running.has(job.id) ? 'running' : job.blocked ? 'failed' :
                  !job.enabled ? 'paused' : !providers.some((p) => p.id === job.provider) ? 'unavailable' :
                  latest?.state === 'failed' ? 'failed' : 'waiting') as import('../../packages/kernel/automation.ts').AutomationItem['state'],
                subject: mail ? accounts.find((a) => a.id === accountId)?.name ?? accountId : job.provider,
                nextAt: job.enabled && !job.blocked ? job.nextAt : undefined,
                lastAt: latest?.finishedAt,
                settings: { ...job, ...(mail ? { accountId } : {}) },
              };
            }),
          };
        };
        for (const mail of [true, false]) {
          const getJob = (id: string) => {
            const job = this.store.document<Job>('scheduler-jobs', id);
            invariant(job && (job.provider === 'mail.sync') === mail, 'job_missing', '未找到此类定时任务。');
            return job;
          };
          contributeAutomation(ctx, mail ? 'scheduler.mail' : 'scheduler.timed', mail ? '邮件同步' : '通用定时任务', {
            describe: () => describe(mail),
            save: (id, settings) => {
              if (this.store.document('scheduler-jobs', id)) getJob(id);
              const accountId = mail ? z.string().min(1).parse(settings.accountId) : undefined;
              invariant(!mail || this.store.document('mail-accounts', accountId!), 'mail_account_missing', '请选择有效邮箱账户。');
              invariant(mail || settings.provider !== 'mail.sync', 'job_provider', '请使用邮件同步任务类型。');
              return this.save({ ...settings, id, ...(mail ? { provider: 'mail.sync', input: { accountId } } : {}) });
            },
            remove: (id) => {
              const job = getJob(id);
              invariant(!this.running.has(id) && !job.blocked, 'job_busy', '请先结束执行或核对未知结果。');
              this.store.remove('scheduler-jobs', id);
              this.refresh();
              this.events.emit('scheduler.updated', { id });
            },
            run: (id, requestId) => {
              getJob(id);
              return this.runOnce(id, requestId);
            },
          });
        }
        const op = operations(ctx, 'scheduler');
        op('list', '任务和执行记录', z.object({}), 'scheduler.read', () => ({
          jobs: this.jobs(),
          runs: this.store.documents('scheduler-runs').slice(-500),
          providers: ctx.capabilities.list('scheduler.handlers@1'),
        }));
        op(
          'save',
          '保存一个默认关闭的任务',
          jobSchema,
          'scheduler.write',
          (v) => this.save(v),
          false,
        );
        op(
          'run',
          '明确执行一次任务',
          z.object({ id, requestId: id }),
          'scheduler.write',
          (v) => {
            return this.runOnce(v.id, v.requestId);
          },
          false,
        );
        op(
          'resolve',
          '确认已核对未知执行，不重新执行',
          z.object({ id, confirmed: z.literal(true) }),
          'scheduler.write',
          (v) => {
            const e = this.store.document<Execution>('scheduler-runs', v.id);
            invariant(e?.state === 'unknown', 'execution_state', '仅未知执行可核对');
            this.store.put('scheduler-runs', v.id, {
              ...e,
              state: 'failed',
              error: '使用者已核对并结束；未重放。',
            });
            const j = this.store.document<Job>('scheduler-jobs', e.jobId);
            if (j)
              this.store.put('scheduler-jobs', j.id, {
                ...j,
                blocked: undefined,
                nextAt: this.next(j),
              });
            this.refresh();
            return { resolved: true };
          },
          false,
        );
        for (const e of this.store.documents<Execution>('scheduler-runs'))
          if (e.state === 'unknown') {
            const j = this.store.document<Job>('scheduler-jobs', e.jobId);
            if (j) this.store.put('scheduler-jobs', j.id, { ...j, blocked: e.id });
          }
        ctx.capabilities.subscribe(() => this.refresh());
        queueMicrotask(() => this.refresh());
        ctx.dispose(() => {
          this.ctx = undefined;
          for (const off of this.disposers.values()) off();
          this.disposers.clear();
        });
      },
    };
  }
}
