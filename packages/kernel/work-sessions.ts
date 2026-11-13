import { randomUUID } from 'node:crypto';
import { invariant, type Conversation, type Run, type Reasoning, type ModelInput, type GenerateResult } from '../contracts/index.ts';
import type { Task } from '../contracts/index.ts';
import { estimateTokens } from '../contracts/generation-metrics.ts';
import type { ContextCompaction } from '../contracts/compaction.ts';
import type { WorkAuthority, WorkOrigin } from '../contracts/work.ts';
import type { Router } from './router.ts';
import { conversationCompaction } from './compaction.ts';

export type WorkSession = {
  id: string;
  conversationId: string;
  personaId: string;
  parentConversationId: string;
  title: string;
  origin: WorkOrigin;
  state: 'idle' | 'running' | 'failed' | 'unknown' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  runId?: string;
  error?: string;
  persistent?: boolean;
  execution?: 'agent' | 'inference';
  profileId?: string;
};

/** Owns agent work sessions, independently of who triggered the work. */
export class WorkSessions {
  private active = new Map<string, AbortController>();
  constructor(readonly router: Router) {
    for (const row of router.store.documents<WorkSession>('work-sessions'))
      if (row.state === 'running') router.store.put('work-sessions', row.id, {
        ...row, state: 'unknown', error: '上次执行被中断，请核对运行记录。',
      });
    for (const [id, authority] of router.store.documents<WorkAuthority & { id?: string }>('work-authorities').map(row => [row.id, row] as const))
      if (id && authority.active) router.store.put('work-authorities', id, { ...authority, active: false });
  }
  list(personaId?: string) {
    return this.router.store.documents<WorkSession>('work-sessions')
      .filter(row => !personaId || row.personaId === personaId)
      .map(row => {
        const conversation = this.router.store.conversation(row.conversationId);
        const pending = this.router.interactions.list(row.conversationId);
        return { ...row, state: row.state === 'running' && pending.length ? 'waiting' : row.state,
          compaction: conversation ? conversationCompaction(this.router.store, conversation) : undefined,
          permissions: conversation?.permissions };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  cancelOrigin(type: string, id: string) {
    for (const row of this.router.store.documents<WorkSession>('work-sessions')) {
      if (row.origin.type !== type || row.origin.id !== id) continue;
      this.cancel(row.id);
    }
  }
  cancel(id: string) {
    const row = this.router.store.document<WorkSession>('work-sessions', id);
    if (!row) return;
    this.active.get(id)?.abort();
    const authority = this.router.store.document<WorkAuthority>('work-authorities', row.conversationId);
    if (authority) this.router.store.put('work-authorities', row.conversationId, { ...authority, active: false });
    this.router.cancel(row.conversationId);
  }
  register(input: {
    id: string; conversationId?: string; personaId: string; parentConversationId: string;
    title: string; origin: WorkOrigin; permissions?: Conversation['permissions'];
    compaction?: ContextCompaction; maxOutputTokens?: number;
    contextBlocks?: string[];
    persistent?: boolean;
    execution?: 'agent' | 'inference';
    profileId?: string;
  }) {
    const store = this.router.store;
    const parent = store.conversation(input.parentConversationId);
    invariant(parent?.personaId === input.personaId, 'work_owner', '工作会话必须属于同一角色。');
    const previous = store.document<WorkSession>('work-sessions', input.id);
    invariant(!previous || previous.personaId === input.personaId &&
      previous.origin.owner === input.origin.owner && previous.origin.type === input.origin.type &&
      previous.origin.id === input.origin.id, 'work_owner', '工作会话来源不一致。');
    const conversationId = input.conversationId ?? previous?.conversationId ?? 'work-' + randomUUID();
    const old = store.conversation(conversationId);
    invariant(!old || old.personaId === input.personaId, 'work_owner', '不能接管其他角色的会话。');
    const now = new Date().toISOString();
    store.saveConversation({ ...old, id: conversationId, title: input.title.slice(0, 160),
      ...(old?.contextProviders?.length === 1 && old.contextProviders[0] === 'delegation.context'
        ? { contextProviders: undefined } : {}),
      personaId: input.personaId, kind: 'worker', injection: true,
      createdAt: old?.createdAt ?? now,
      permissions: input.permissions ?? old?.permissions,
      compaction: input.compaction,
      maxOutputTokens: input.maxOutputTokens,
      contextBlocks: input.contextBlocks,
    });
    const row: WorkSession = { ...previous, id: input.id, conversationId, personaId: input.personaId,
      parentConversationId: input.parentConversationId, title: input.title, origin: input.origin,
      state: previous?.state ?? 'idle', persistent: input.persistent ?? true,
      execution: input.execution ?? previous?.execution ?? 'agent',
      profileId: input.profileId ?? previous?.profileId,
      createdAt: previous?.createdAt ?? now, updatedAt: now };
    store.put('work-sessions', row.id, row);
    this.router.events.emit('work.updated', { id: row.id, personaId: row.personaId });
    return row;
  }
  async run(input: {
    id: string; profileId: string; requestId: string; text: string; reasoning?: Reasoning;
    authority?: Omit<WorkAuthority, 'active'>; timeoutMs?: number;
  }, signal: AbortSignal): Promise<Run> {
    return this.execute(input.id, signal, async (row, life) => {
      invariant(row.execution !== 'inference', 'work_execution', '此子任务由来源自动化任务执行。');
      const store = this.router.store;
      if (input.authority) store.put('work-authorities', row.conversationId, { ...input.authority, id: row.conversationId, active: true });
      try {
        await this.router.bind(row.conversationId, input.profileId, life);
        const parent = store.conversation(row.parentConversationId);
        const inheritedReasoning = store.binding(row.parentConversationId)?.profileId === input.profileId ? parent?.reasoning : undefined;
        return await this.router.send({ conversationId: row.conversationId, requestId: input.requestId,
          source: 'delegation', text: input.text,
          reasoning: !input.reasoning || input.reasoning === 'inherit' ? inheritedReasoning ?? input.reasoning : input.reasoning,
          messageOrigin: { sender: 'system', task: row.origin.name } },
          input.timeoutMs ? AbortSignal.any([life, AbortSignal.timeout(input.timeoutMs)]) : life);
      } finally {
        if (input.authority) store.put('work-authorities', row.conversationId, { ...input.authority, id: row.conversationId, active: false });
      }
    });
  }
  /** API-backed task steps share the work lifecycle and history, without starting another agent. */
  async infer(input: {
    id: string; task: Task; requestId: string; messages: ModelInput[];
    profileId?: string; reasoning?: Reasoning;
    interpret?: (result: GenerateResult) => string;
  }, signal: AbortSignal): Promise<GenerateResult> {
    let result: GenerateResult | undefined;
    await this.execute(input.id, signal, async (row, life) => {
      const store = this.router.store;
      invariant(row.execution === 'inference', 'work_execution', '此工作会话不是 API 任务。');
      invariant(!store.run(input.requestId), 'work_replay', '这次执行已存在，请查看原运行记录。');
      await this.router.inference.refresh();
      const profile = input.profileId ? this.router.profile(input.profileId) : this.router.route(input.task, row.personaId);
      const binding = store.binding(row.conversationId);
      store.saveBinding({ conversationId: row.conversationId, profileId: profile.id,
        epoch: (binding?.epoch ?? 0) + 1, state: 'active' });
      let run: Run = { id: input.requestId, requestId: input.requestId, conversationId: row.conversationId,
        profileId: profile.id, epoch: (binding?.epoch ?? 0) + 1, state: 'running',
        source: 'delegation', input: input.messages.at(-1)?.text ?? '', createdAt: new Date().toISOString(),
        meta: { workSession: true, inferenceTask: input.task, contextLimit: profile.modelOptions.contextWindowTokens,
          contextWindowKind: 'model', reasoning: input.reasoning } };
      store.createRun(run);
      store.put('work-sessions', row.id, { ...store.document<WorkSession>('work-sessions', row.id)!, runId: run.id });
      // Images remain transient. Persist text and image counts, never screenshot data.
      for (const message of input.messages) store.append(row.conversationId, message.role === 'user' ? 'system' : message.role,
        'delegation', message.text, run.id, { workSession: true, modelRole: message.role, imageCount: message.images?.length ?? 0 });
      this.router.events.emit('run.started', { run });
      const started = Date.now();
      try {
        result = await this.router.infer(input.task, input.messages, life, input.reasoning, row.personaId, profile.id);
        life.throwIfAborted();
        const u = result.usage;
        const actualInput = u?.prompt_tokens ?? u?.input_tokens ?? (u?.input !== undefined ? u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : undefined);
        const output = u?.completion_tokens ?? u?.output_tokens ?? u?.output;
        const cached = u?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? u?.cacheRead;
        const system = input.messages.filter(m => m.role === 'system').reduce((n, m) => n + estimateTokens(m.text), 0);
        const messages = input.messages.filter(m => m.role !== 'system').reduce((n, m) => n + estimateTokens(m.text), 0);
        run = { ...run, state: 'succeeded', result: result.text, meta: { ...run.meta, usage: u,
          generationMetrics: result.metrics ?? { context: { system, tools: 0, messages },
            details: [{ group: 'prefix', source: 'task.instructions', tokens: system }, { group: 'turn', source: 'task.input', tokens: messages }],
            modelSteps: 1, ...(actualInput !== undefined ? { inputTokens: actualInput } : {}),
            ...(actualInput !== undefined && output !== undefined ? { totalUsage: { input: actualInput, output, cacheRead: cached ?? 0, cacheWrite: u?.cacheWrite ?? 0 } } : {}),
            ...(actualInput && cached !== undefined ? { cacheHitPercent: cached * 100 / actualInput } : {}),
            ...(output !== undefined ? { tokensPerSecond: output * 1000 / Math.max(1, Date.now() - started) } : {}) } } };
        store.append(row.conversationId, 'assistant', 'delegation', input.interpret?.(result) ?? result.text, run.id, { workSession: true });
      } catch (error) {
        run = { ...run, state: life.aborted ? 'cancelled' : 'failed', error: String(error) };
        store.updateRun(run);
        this.router.events.emit('run.completed', { run });
        throw error;
      }
      store.updateRun(run);
      this.router.events.emit('message.posted', { conversationId: row.conversationId });
      this.router.events.emit('run.completed', { run });
      return run;
    });
    return result!;
  }
  private async execute(id: string, signal: AbortSignal, work: (row: WorkSession, signal: AbortSignal) => Promise<Run>): Promise<Run> {
    const store = this.router.store;
    const row = store.document<WorkSession>('work-sessions', id);
    invariant(row, 'work_missing', '工作会话不存在。');
    invariant(!this.active.has(row.id) && !this.router.isBusy(row.conversationId), 'work_busy', '工作会话正在执行。');
    const persist = (state: WorkSession['state'], extra: Partial<WorkSession> = {}) => {
      store.put('work-sessions', row.id, { ...store.document<WorkSession>('work-sessions', row.id)!, ...extra, state, updatedAt: new Date().toISOString() });
      this.router.events.emit('work.updated', { id: row.id, personaId: row.personaId });
    };
    const controller = new AbortController();
    this.active.set(row.id, controller);
    const life = AbortSignal.any([signal, controller.signal, this.router.characterSignal(row.personaId)]);
    persist('running');
    try {
      life.throwIfAborted();
      const run = await work(row, life);
      persist(run.state === 'succeeded' ? 'idle' : run.state === 'running' ? 'unknown' : run.state,
        { runId: run.id, error: run.error });
      return run;
    } catch (error) {
      persist(life.aborted ? 'cancelled' : 'failed', { error: String(error) });
      throw error;
    } finally {
      this.active.delete(row.id);
    }
  }
}
