import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { executionRequest } from '../../packages/contracts/work.ts';
import { conversationPermissions } from '../../packages/contracts/interaction.ts';
import { characterEnabled } from '../../packages/kernel/characters.ts';
import { contributeAutomation } from '../../packages/kernel/automation.ts';
import { configuredTimezone, localTime, nextDaily } from '../../packages/kernel/time.ts';
import type { Caller, PluginContext } from '../../packages/kernel/registry.ts';
import type { Clock } from '../../packages/kernel/clock.ts';
import type { Router } from '../../packages/kernel/router.ts';
import type { Deliveries } from '../../packages/kernel/delivery.ts';
import type { DelegationPolicy } from './config.ts';
import { authorizeExecution } from './authorization.ts';
import { selectedReasoning } from '../../packages/backends/model-metadata.ts';

const type = 'delegation.automations';
const schema = z.object({
  id, name: z.string().trim().min(1).max(80), personaId: id,
  prompt: z.string().trim().min(1).max(50000), enabled: z.boolean().default(false),
  mode: z.enum(['once', 'daily', 'interval']).default('daily'),
  at: z.string().optional(), hour: z.number().int().min(0).max(23).default(7),
  minute: z.number().int().min(0).max(59).default(0),
  minutes: z.number().int().min(1).max(525600).default(60),
  execution: executionRequest.default({}),
  report: z.boolean().default(true), reportPrompt: z.string().max(10000).default('简要汇报任务的实际结果、需要确认的事项。'),
  outputTargets: z.array(z.string().min(1)).max(20).default(['core.chat']),
});
type Task = z.infer<typeof schema> & { nextAt?: number; lastAt?: string; lastError?: string };

/** General prompt automation is a stock task type using the same worker contract. */
export class AgentAutomations {
  private running = new Map<string, AbortController>();
  constructor(readonly router: Router, readonly clock: Clock,
    readonly policy: (personaId: string) => DelegationPolicy, readonly deliveries?: Deliveries) {}
  tasks() { return this.router.store.documents<Task>('agent-automations'); }
  private next(task: Task, now = Date.now()) {
    if (task.mode === 'once') {
      const local = task.at?.match(/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)$/);
      return local ? localTime(local[1], Number(local[2]), Number(local[3]), configuredTimezone(this.router.store)) :
        task.at ? Date.parse(task.at) : NaN;
    }
    return task.mode === 'interval' ? now + task.minutes * 60000 :
      nextDaily(new Date(now), task.hour, task.minute, configuredTimezone(this.router.store));
  }
  private parent(personaId: string) {
    const role = this.router.store.document<{ mainConversationId: string }>('characters', personaId);
    invariant(role, 'persona_missing', '请选择已有角色。');
    return role.mainConversationId;
  }
  private async authorize(task: Task) {
    const parent = this.parent(task.personaId);
    const execution = await authorizeExecution(this.router.store, task.personaId,
      this.router.store.binding(parent)?.profileId, this.policy(task.personaId), task.execution);
    const profile = await this.router.inference.prepare(this.router.profile(execution.profileId), execution.reasoning);
    selectedReasoning(profile, execution.reasoning);
    invariant(this.router.inference.eligibility(this.router.inference.models().find(model => model.id === profile.id)!).worker,
      'worker_backend', '请选择支持工具执行的工作模型。');
    invariant(!execution.fullAccess || ['api', 'pi'].includes(profile.kind), 'worker_full_backend', '本机完全访问需要使用内置执行器。');
    return execution;
  }
  async save(raw: unknown, caller?: Caller) {
    const task = schema.parse(raw);
    invariant(!caller?.personaId || caller.personaId === task.personaId, 'task_owner', '只能管理当前角色的任务。');
    const old = this.router.store.document<Task>('agent-automations', task.id);
    invariant(!old || old.personaId === task.personaId, 'task_owner', '不能覆盖其他角色的任务。');
    // Character creation saves disabled task drafts before binding its main model.
    // Activation and every execution still validate the complete execution grant.
    if (task.enabled || this.router.store.binding(this.parent(task.personaId))) await this.authorize(task);
    const nextAt = this.next(task);
    invariant(Number.isFinite(nextAt) && (task.mode !== 'once' || nextAt > Date.now()), 'task_time', '请填写未来的有效执行时间。');
    this.running.get(task.id)?.abort();
    this.router.workSessions.cancelOrigin(type, task.id);
    const saved = { ...task, nextAt };
    this.router.store.put('agent-automations', task.id, saved);
    this.schedule(saved);
    this.router.events.emit('automation.changed', { owner: 'delegation' });
    return saved;
  }
  private schedule(task: Task) {
    this.clock.cancel('agent-task.' + task.id);
    if (!task.enabled || !characterEnabled(this.router.store, task.personaId, 'delegation') || this.running.has(task.id)) return;
    const nextAt = task.nextAt ?? this.next(task);
    this.clock.at('agent-task.' + task.id, Math.max(Date.now(), nextAt), () =>
      this.run(task.id, 'auto-' + createHash('sha256').update(task.id + ':' + nextAt).digest('hex').slice(0, 40)));
  }
  async run(id: string, requestId: string) {
    const task = this.router.store.document<Task>('agent-automations', id);
    invariant(task, 'task_missing', '任务不存在。');
    invariant(characterEnabled(this.router.store, task.personaId, 'delegation'), 'character_disabled', '角色或任务功能已停用。');
    invariant(!this.running.has(id), 'task_busy', '任务正在执行。');
    const receiptKey = 'agent-task.' + requestId;
    const old = this.router.store.receipt(receiptKey);
    if (old) return old;
    const controller = new AbortController();
    this.running.set(id, controller);
    let error: string | undefined;
    try {
      const execution = await this.authorize(task), parent = this.parent(task.personaId);
      const delivery = task.report ? await this.deliveries?.plan(parent, 'handoff', task.outputTargets,
        { task: { type, id: task.id } }, controller.signal) : undefined;
      const work = this.router.workSessions.register({ id: 'agent-task-' + id,
        personaId: task.personaId, parentConversationId: parent, title: task.name,
        origin: { type, id: task.id, name: task.name, owner: 'delegation' },
        compaction: execution.compaction, maxOutputTokens: execution.maxOutputTokens,
        contextBlocks: execution.contextBlocks,
        permissions: conversationPermissions.parse({ echoTools: execution.toolPermissions,
          projectDirectory: execution.projectDirectory, readRoots: execution.workspaces.filter(root => !root.write).map(root => root.path),
          writeRoots: execution.workspaces.filter(root => root.write).map(root => root.path),
          codex: { sandbox: execution.write ? 'workspace-write' : 'read-only', approvals: execution.approvals },
          dsh: { approvals: execution.approvals }, pi: { tools: execution.approvals === 'ask' ? 'ask' : 'read',
            echoTools: execution.approvals === 'ask' ? 'ask' : 'read', projectWrite: execution.write,
            terminal: execution.terminal, fullAccess: execution.fullAccess } }),
      });
      this.router.store.saveReceipt(receiptKey, { state: 'running', taskId: id });
      const run = await this.router.workSessions.run({ id: work.id, profileId: execution.profileId,
        requestId, reasoning: execution.reasoning, timeoutMs: execution.timeoutMinutes * 60000,
        authority: { owner: 'delegation', taskType: type, taskId: id, permissions: execution.toolPermissions ?? [] },
        text: [execution.prompt, task.prompt,
          '这是自动化任务。本轮执行上述任务并核验结果，结束后说明实际成果和未完成事项。',
          task.report ? '用户渠道由主角色按任务设置汇报。' : '本次只保存结果，不主动向用户渠道发消息。'].filter(Boolean).join('\n\n'),
      }, controller.signal);
      const text = run.state === 'succeeded' ? run.result ?? '任务执行完成。' : run.error ?? '任务执行未完成。';
      if (run.state !== 'succeeded') error = text;
      await this.router.taskResults.submit({ id: 'agent-result-' + requestId, conversationId: parent,
        source: 'handoff', task: task.name, text, report: task.report,
        reportPrompt: task.report ? task.reportPrompt : undefined, delivery }, controller.signal);
      const receipt = { state: run.state, taskId: id, runId: run.id };
      this.router.store.saveReceipt(receiptKey, receipt);
      return receipt;
    } catch (reason) {
      error = String(reason);
      if (!controller.signal.aborted && !this.router.store.receipt('task-result.agent-result-' + requestId)) {
        // Execution errors remain visible to later conversation, without starting another failing report run.
        await this.router.taskResults.submit({ id: 'agent-result-' + requestId,
          conversationId: this.parent(task.personaId), source: 'handoff', task: task.name,
          text: '任务未完成：' + error, report: false }).catch(() => {});
      }
      const receipt = { state: controller.signal.aborted ? 'cancelled' : 'failed', taskId: id, error };
      this.router.store.saveReceipt(receiptKey, receipt);
      return receipt;
    } finally {
      this.running.delete(id);
      const current = this.router.store.document<Task>('agent-automations', id);
      if (current) {
        const saved = { ...current, lastAt: new Date().toISOString(), lastError: error,
          ...(task.mode === 'once' && current.nextAt === task.nextAt ? { enabled: false } : {}),
          nextAt: current.nextAt !== task.nextAt ? current.nextAt : this.next(current) };
        this.router.store.put('agent-automations', id, saved);
        this.schedule(saved);
      }
      this.router.events.emit('automation.changed', { owner: 'delegation' });
    }
  }
  install(ctx: PluginContext) {
    contributeAutomation(ctx, type, '自定义任务', {
      describe: () => ({ scope: 'character', defaults: { prompt: '', execution: {}, report: true,
        reportPrompt: '简要汇报任务的实际结果、需要确认的事项。', outputTargets: ['core.chat'],
        mode: 'daily', hour: 7, minute: 0, minutes: 60 },
        fields: [
          { key: 'personaId', label: '所属角色', kind: 'select', options: this.router.store.documents<any>('characters').map(role =>
            ({ value: role.id, label: this.router.store.document<any>('personas', role.id)?.name ?? role.id })) },
          { key: 'prompt', label: '任务要求', kind: 'textarea' },
          { key: 'mode', label: '执行周期', kind: 'select', options: [
            { value: 'once', label: '执行一次' }, { value: 'daily', label: '每日' }, { value: 'interval', label: '按间隔' }] },
          { key: 'at', label: '执行时间', kind: 'datetime', description: '使用应用时区。', when: { key: 'mode', value: 'once' } },
          { key: 'hour', label: '小时', kind: 'number', min: 0, max: 23, when: { key: 'mode', value: 'daily' } },
          { key: 'minute', label: '分钟', kind: 'number', min: 0, max: 59, when: { key: 'mode', value: 'daily' } },
          { key: 'minutes', label: '间隔（分钟）', kind: 'number', min: 1, when: { key: 'mode', value: 'interval' } },
          { key: 'execution', label: '执行设置', kind: 'execution' },
          { key: 'report', label: '结果汇报', kind: 'boolean' },
          { key: 'reportPrompt', label: '汇报要求', kind: 'textarea', when: { key: 'report', value: true } },
          { key: 'outputTargets', label: '汇报渠道', kind: 'outputs', outputSource: 'handoff', when: { key: 'report', value: true } },
        ], items: this.tasks().map(task => ({ id: task.id, name: task.name, enabled: task.enabled,
          personaId: task.personaId, state: this.running.has(task.id) ? 'running' : !task.enabled ? 'paused' : task.lastError ? 'failed' : 'waiting',
          nextAt: task.nextAt, lastAt: task.lastAt, settings: task })) }),
      save: (id, value) => this.save({ ...value, id }),
      remove: id => { invariant(!this.running.has(id), 'task_busy', '请先停止正在执行的任务。');
        this.clock.cancel('agent-task.' + id); this.router.store.remove('agent-automations', id); },
      run: (id, requestId) => this.run(id, requestId),
    });
    ctx.registry.register({ owner: 'delegation', name: 'delegation.schedule',
      description: '创建或编辑当前角色的自动化子任务：任务要求、执行时间、已授权执行配置和汇报渠道',
      permission: 'delegation.write', mcp: true,
      input: schema.omit({ id: true, personaId: true }).extend({ id: id.optional(), enabled: z.boolean().default(true) }), output: z.unknown(),
      run: (value, caller) => {
        invariant(caller.personaId && caller.conversationId, 'task_owner', '请从角色工作会话创建任务。');
        invariant(caller.conversationId === this.parent(caller.personaId), 'task_owner', '请由主角色创建自动化任务。');
        invariant(this.policy(caller.personaId).autonomous, 'delegation_policy', '角色未获准自主创建子任务。');
        return this.save({ ...value, id: value.id ?? randomUUID(), personaId: caller.personaId }, caller);
      } });
    ctx.registry.register({ owner: 'delegation', name: 'delegation.automations',
      description: '查看、启停、移除或立即执行当前角色的自定义任务', permission: 'delegation.write', mcp: true,
      input: z.object({ action: z.enum(['list', 'pause', 'resume', 'run', 'remove']), id: id.optional(), requestId: id.optional() }),
      output: z.unknown(), run: async (value, caller) => {
        invariant(caller.personaId && caller.conversationId === this.parent(caller.personaId), 'task_owner', '请从主角色管理任务。');
        if (value.action === 'list') return this.tasks().filter(task => task.personaId === caller.personaId);
        const task = this.tasks().find(task => task.id === value.id && task.personaId === caller.personaId);
        invariant(task, 'task_missing', '任务不存在。');
        if (value.action === 'run') return this.run(task.id, value.requestId ?? randomUUID());
        if (value.action === 'remove') {
          this.running.get(task.id)?.abort(); this.clock.cancel('agent-task.' + task.id);
          this.router.store.remove('agent-automations', task.id); return { removed: true };
        }
        return this.save({ ...task, enabled: value.action === 'resume' }, caller);
      } });
    for (const task of this.tasks()) {
      if (task.nextAt && task.nextAt < Date.now()) {
        const nextAt = this.next(task);
        const current = { ...task, nextAt, ...(task.mode === 'once' ? { enabled: false, lastError: '已错过执行时间，请重新安排。' } : {}) };
        this.router.store.put('agent-automations', task.id, current); this.schedule(current);
      } else this.schedule(task);
    }
    ctx.dispose(this.router.events.subscribe(event => {
      if (['character.activity.changed', 'characters.updated'].includes(event.type)) {
        for (const task of this.tasks()) if (event.data.personaId === task.personaId) {
          // A running request was authorized against the previous role configuration.
          if (event.type === 'characters.updated' || !event.data.enabled) {
            this.running.get(task.id)?.abort();
            this.router.workSessions.cancelOrigin(type, task.id);
          }
          this.schedule(task);
        }
      }
    }));
    ctx.dispose(() => { for (const task of this.tasks()) this.clock.cancel('agent-task.' + task.id);
      for (const controller of this.running.values()) controller.abort(); });
  }
}
