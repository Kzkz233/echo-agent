import { replySubmission, type DeliveryPlan, type ReplySubmission } from '../contracts/delivery.ts';
import { randomUUID, createHash } from 'node:crypto';
import { Interactions } from './interactions.ts';
import {
  EchoError,
  invariant,
  observationSilence,
  type Backend,
  type Binding,
  type GenerateResult,
  type Message,
  type ModelInput,
  type Persona,
  type Profile,
  type Reasoning,
  type Run,
  type Task,
} from '../contracts/index.ts';
import { Store } from './store.ts';
import { Events } from './events.ts';
import { Capabilities } from './capabilities.ts';
import { InferenceCatalog } from './inference.ts';
import { inferenceTasks, generationOutput } from '../contracts/inference.ts';
import { characterEnabled, characterActive } from './characters.ts';
import { ExecutionLedger } from './execution.ts';
import { Attachments } from './attachments.ts';
import {
  contextPoint,
  orderContext,
  type ContextBlock,
  type ContextItem,
  type ContextProvider,
  type ContextTurn,
} from './context.ts';
import type { ReplyImage } from '../contracts/index.ts';
import { compactConversation, eligibleHistory, conversationCompaction } from './compaction.ts';
import { WorkSessions } from './work-sessions.ts';
import { TaskResults } from './task-results.ts';
import { estimateTokens, type ContextDetail } from '../contracts/generation-metrics.ts';
import { messageContextRules, renderMessageText, type MessageOrigin } from '../contracts/message-context.ts';
import { captureMessageContext, storedMessageContext, messageSourcePoint } from './message-context.ts';
import { configuredTimezone } from './time.ts';

type Submission = {
  conversationId: string;
  text: string;
  requestId: string;
  source?: Message['source'];
  reasoning?: Reasoning;
  bubble?: boolean;
  origin?: { bindingId: string; remoteMessageId?: string };
  attachmentIds?: string[];
  triggerKind?: string;
  localOnly?: boolean;
  workSession?: true;
  delivery?: DeliveryPlan;
  messageOrigin?: MessageOrigin;
  recordedInputId?: string;
  expiresAt?: number;
};
export class Router {
  readonly workSessions: WorkSessions;
  readonly taskResults: TaskResults;
  readonly inference: InferenceCatalog;
  readonly interactions: Interactions;
  readonly execution: ExecutionLedger;
  readonly attachments: Attachments;
  readonly backends = new Map<string, Backend>();
  private conversationRuntimes = new WeakMap<Backend, Backend>();
  private inferenceTransports = new WeakMap<Backend, Backend>();
  useConversationRuntime(provider: Backend, runtime: Backend) {
    this.conversationRuntimes.set(provider, runtime);
    this.inferenceTransports.set(runtime, provider);
  }
  executionBackend(profile: Profile, conversationId?: string): Backend {
    const backend = this.backend(profile);
    if (
      conversationId &&
      this.store.conversation(conversationId)?.kind === 'worker' &&
      this.inference.adapter(profile.adapterId!).workerOnly
    )
      return backend;
    invariant(
      !conversationId ||
        !['main', 'group-member'].includes(this.store.conversation(conversationId)?.kind ?? '') ||
        !this.inference.adapter(profile.adapterId!).workerOnly,
      'worker_only',
      '此外部执行器仅用于子任务，请在角色配置中选择语言模型。',
    );
    return this.conversationRuntimes.get(backend) ?? backend;
  }
  private contextController = new AbortController();
  private locks = new Set<string>();
  private running = new Map<string, AbortController>();
  private tasks = new Set<Promise<Run>>();
  private draining = new Set<string>();
  private closing = false;
  private updating = false;
  private inferenceCalls = 0;
  pauseForUpdate() {
    invariant(!this.tasks.size && !this.running.size && !this.locks.size && !this.inferenceCalls,
      'update_busy', '会话或推理任务仍在执行，请完成后再更新。');
    this.updating = true;
  }
  resumeAfterUpdateFailure() { this.updating = false; }
  private characterControllers = new Map<string,AbortController>();
  characterSignal(personaId:string) {
    if(!characterActive(this.store,personaId))return AbortSignal.abort(new EchoError('character_disabled','角色已停用。'));
    let controller=this.characterControllers.get(personaId);
    if(!controller||controller.signal.aborted){controller=new AbortController();this.characterControllers.set(personaId,controller);}
    return controller.signal;
  }
  suspendCharacter(personaId:string) {
    this.characterControllers.get(personaId)?.abort(new EchoError('character_disabled','角色已停用。'));
    const ids=new Set(this.store.conversations().filter(c=>c.personaId===personaId).map(c=>c.id));
    for(const conversationId of ids)this.cancel(conversationId);
    for(const receipt of this.store.receipts()) {
      const conversationId=receipt.input?.conversationId??receipt.conversationId;
      if(!ids.has(conversationId))continue;
      if(receipt.kind==='input'&&receipt.state==='queued')this.store.saveReceipt(receipt.id,{...receipt,state:'cancelled',reason:'character_disabled'});
      if(receipt.kind==='bubble'&&['pending','claimed'].includes(receipt.state))this.store.saveReceipt(receipt.id,{...receipt,state:'expired',reason:'character_disabled'});
    }
  }
  private deleting = new Set<string>();
  private deliveryStages = new Set<(message: Message, run?: Run) => void>();
  planLocalReply?: (id: string, bubble: boolean, signal: AbortSignal) => Promise<DeliveryPlan>;
  private replyDecorator?: (run: Run, text: string, target?: DeliveryPlan['targets'][number]) => { text: string; image?: ReplyImage };
  constructor(
    readonly store: Store,
    readonly events: Events,
    readonly capabilities = new Capabilities(),
  ) {
    this.workSessions = new WorkSessions(this);
    this.taskResults = new TaskResults(this);
    this.interactions = new Interactions(events);
    this.execution = new ExecutionLedger(store, events);
    this.attachments = new Attachments(store);
    this.inference = new InferenceCatalog(store, capabilities, () =>
      events.emit('inference.changed', {}),
    );
    const core = this.capabilities.forOwner(
      { id: 'core', permissions: new Set(['*']), signal: this.contextController.signal },
      () => {},
    );
    core.define(contextPoint);
    core.define(messageSourcePoint);
    this.context(
      {
        id: 'core',
        blocks: [
          { id: 'core.message-context', layer: 'stable', worker: 'required', label: '消息来源与时间' },
          {
            id: 'core.presentation',
            worker: 'required',
            layer: 'turn',
            after: ['memory.recall', 'reflections.current', 'delegation.turn'],
          },
        ],
        prepare: ({ conversation, presentation, replyStyles }) => {
          const base = { 'core.message-context': [{ text: messageContextRules }] };
          if (replyStyles?.length) {
            return { ...base, 'core.presentation': [{ text: [
              presentation === 'external' ? '本轮通过消息渠道回复。' : presentation === 'bubble' ? '本轮显示在桌宠小气泡。' : '',
              '发给渠道的内容必须用 echo_respond 提交。普通正文只属于执行过程。messages 的每项是一条独立消息，普通换行留在同一项内。progress 是可选的中途说明，final 是正式交付。',
              '每个目标每阶段只能提交一次。开场白后还有正文时，开场使用 progress；final 的 messages 必须一次包含该目标的全部正文与分段，不可先用 final 发开场再追加另一条 final。',
              '一旦开始回复，必须为下列全部目标分别提交 final，共用同一次工作的结果。目标已由用户或任务配置选定，不按入站渠道自行删减。工具回执会列出尚未完成的目标。',
              ...(replyStyles.some((style) => style.id === 'core.chat') ? ['聊天中的闲聊省略 title；想分条说时，把每条分别写进 messages。'] : []),
              ...replyStyles.map(({ id, label, text }) => `${id}（${label}）${text ? '：' + text : ''}`),
            ].filter(Boolean).join('\n') }] };
          }
          if (!presentation) return { ...base, 'core.presentation': [] };
          const expression = this.store.document<Persona>(
            'personas',
            conversation.personaId,
          )?.expression;
          const text =
            presentation === 'external'
              ? '本轮通过消息渠道回复。' +
                (expression?.external ?? '')
              : '本轮显示在桌宠小气泡。' +
                (expression?.bubble ?? '');
          return { ...base, 'core.presentation': [{ text: '[Echo 本轮展示约定] ' + text }] };
        },
      },
      core,
    );
  }
  context(provider: ContextProvider, scope: ReturnType<Capabilities['forOwner']>) {
    orderContext(provider.blocks);
    return scope.provide(contextPoint.id, provider.id + '.context', provider.id, (v, signal) =>
      v.action === 'describe' ? provider.blocks : provider.prepare(v, signal),
    );
  }
  private async prepareContext(
    input: ContextTurn,
    signal: AbortSignal,
    cache = new Map<string, Record<string, ContextItem[]>>(),
  ) {
    const { conversation } = input;
    const owner = { id: 'core', permissions: new Set(['context.read']), signal };
    const providers = this.capabilities
      .list(contextPoint.id)
      .filter(
        (p) =>
          p.state === 'active' &&
          (p.id === 'core.context' ||
            (conversation.injection &&
              characterEnabled(this.store, conversation.personaId, p.owner) &&
              (!conversation.contextProviders || conversation.contextProviders.includes(p.id)))),
      );
    const describe = await Promise.all(
      providers.map(async (p) => {
        const value = await this.capabilities.invoke(
          owner,
          contextPoint.id,
          p.id,
          { action: 'describe' },
          signal,
        );
        invariant(
          Array.isArray(value),
          'context_block_descriptor',
          '插件必须声明上下文块：' + p.id,
        );
        return (value as ContextBlock[]).map((block) => {
          invariant(
            block.id.startsWith(p.owner + '.'),
            'context_block_namespace',
            '上下文块必须使用插件自己的命名空间。',
          );
          return { ...block, provider: p.id };
        });
      }),
    );
    const defaults = this.store.document<{ contextBlocks?: string[] }>('character-settings.delegation', conversation.personaId);
    const selected = conversation.contextBlocks ?? defaults?.contextBlocks;
    if (conversation.kind === 'worker' && selected) input = { ...input, conversation: { ...conversation, contextBlocks: selected } };
    const declared = describe.flat();
    const ordered = orderContext(declared.filter(block => conversation.kind !== 'worker' ||
      block.worker === 'required' || (selected ? selected.includes(block.id) :
        (block.worker ?? (block.layer === 'stable' ? 'default' : 'optional')) === 'default')));
    const prepared = new Map<string, Record<string, ContextItem[]>>();
    const result = { prefix: [] as (ContextItem & { source: string })[], turn: [] as (ContextItem & { source: string })[] };
    for (const block of ordered.filter((block) => !input.phase || block.layer === input.phase)) {
      let items = prepared.get(block.provider);
      if (!items) {
        const key = input.phase + ':' + block.provider;
        const reusable = !ordered.some(
          (candidate) => candidate.provider === block.provider && candidate.historyDependent,
        );
        const value =
          (reusable && cache.get(key)) ||
          (await this.capabilities.invoke(owner, contextPoint.id, block.provider, input, signal));
        invariant(
          !Array.isArray(value),
          'context_block_content',
          '插件必须按上下文块编号返回内容。',
        );
        items = value as Record<string, ContextItem[]>;
        invariant(
          Object.keys(items).every((id) =>
            declared.some((item) => item.provider === block.provider && item.id === id),
          ),
          'context_block_undeclared',
          '插件返回了未声明的上下文块：' + block.provider,
        );
        prepared.set(block.provider, items);
        if (reusable) cache.set(key, items);
      }
      for (const item of items[block.id] ?? []) {
        if (!item.text.trim()) continue;
        if (block.layer === 'turn') result.turn.push({ ...item, source: block.id });
        else {
          invariant(!item.record, 'context_stable_record', '固定上下文不能作为历史资料写入。');
          result.prefix.push({ ...item, source: block.id });
        }
      }
    }
    return result;
  }
  async workerContextOptions(personaId: string, signal = new AbortController().signal, features?: string[]) {
    const rows = this.capabilities.list(contextPoint.id).filter(provider => provider.state === 'active' &&
      (provider.id === 'core.context' || provider.owner === 'persona' ||
        (features ? features.includes(provider.owner) : characterEnabled(this.store, personaId, provider.owner))));
    const options = await Promise.all(rows.map(async provider => {
      const blocks = await this.capabilities.invoke({ id: 'core', permissions: new Set(['context.read']), signal },
        contextPoint.id, provider.id, { action: 'describe' }, signal) as ContextBlock[];
      return blocks.map(block => ({ id: block.id, label: block.label ?? block.id,
        owner: provider.owner, required: block.worker === 'required',
        default: (block.worker ?? (block.layer === 'stable' ? 'default' : 'optional')) !== 'optional' }));
    }));
    return options.flat();
  }
  profiles() {
    return this.inference.models().map((model) => {
      const connection = this.inference.connections().find((c) => c.id === model.connectionId);
      try {
        const profile = this.inference.resolve(model.id);
        return {
          ...model,
          kind: profile.kind,
          adapterId: profile.adapterId,
          ...(profile.kind === 'dsh'
            ? { dshSdkMode: profile.args.includes('sdk-minimal') ? 'minimal' : 'full' }
            : {}),
          connectionName: connection?.name,
          available: true,
          workerOnly: this.inference.adapter(profile.adapterId!).workerOnly,
          eligibility: this.inference.eligibility(model),
          sessionCapabilities: (model.generation.enabled
            ? this.executionBackend(profile).capabilities?.(profile)
            : undefined) ?? {
            events: false,
            steer: false,
            images: profile.vision,
            projectTools: false,
          },
        };
      } catch {
        return {
          ...model,
          connectionName: connection?.name,
          available: false,
          eligibility: { conversation: false, worker: false, tasks: [] },
        };
      }
    });
  }
  isBusy(conversationId: string) {
    return this.locks.has(conversationId) || this.draining.has(conversationId);
  }
  isDeleting(conversationId: string) {
    return this.deleting.has(conversationId);
  }
  profile(id: string) {
    return this.inference.resolve(id);
  }
  backend(profile: Profile): Backend {
    const backend = this.backends.get(profile.kind);
    if (
      backend &&
      (!profile.adapterId ||
        profile.adapterId === 'core.' + profile.kind ||
        this.inference.adapter(profile.adapterId).sessionBackend)
    )
      return backend;
    const model = this.inference.models().find((m) => m.id === profile.id)!;
    const connection = this.inference.connections().find((c) => c.id === model.connectionId)!;
    const descriptor = this.inference.adapter(connection.adapterId);
    invariant(descriptor.generationProvider, 'missing_backend', '此接入器不提供生成能力');
    return {
      kind: profile.kind,
      generate: async (request) => {
        const result = generationOutput.parse(
          await this.capabilities.invoke(
            this.inference.owner,
            'core.inference.generate@1',
            descriptor.generationProvider!,
            {
              profile: request.profile,
              messages: request.messages,
              reasoning: request.reasoning,
              toolPolicy: request.toolPolicy,
            },
            request.signal,
          ),
        );
        request.onDelta?.(result.text);
        return result;
      },
    } satisfies Backend;
  }
  route(task: Task, personaId?: string) {
    invariant(
      this.capabilities
        .list('core.inference.tasks@1')
        .some((p) => p.id === task && p.state === 'active'),
      'task_unavailable',
      '推理任务当前未注册：' + task,
    );
    const role =
      this.inference.task(task)?.scope === 'character' && personaId
        ? this.store.document<{ routes: Record<string, string>; mainConversationId: string }>(
            'characters',
            personaId,
          )
        : undefined;
    const selected = role
      ? role.routes[task] || this.store.binding(role.mainConversationId)?.profileId
      : this.store.get<Partial<Record<Task, string>>>('routes', {})[task];
    invariant(selected, 'missing_route', `请先为「${task}」选择模型。`);
    return this.profile(selected);
  }
  enqueue(input: Submission) {
    invariant(!this.updating, 'updating', 'Echo 正在重启更新，请稍后发送。');
    const personaId=this.store.conversation(input.conversationId)?.personaId;
    invariant(!personaId||characterActive(this.store,personaId),'character_disabled','角色已停用，请先启用角色。');
    if (input.attachmentIds?.length)
      this.attachments.metadata(input.attachmentIds, input.conversationId);
    invariant(
      input.text.trim() || input.attachmentIds?.length,
      'empty_input',
      '请填写消息或添加附件。',
    );
    invariant(
      !this.deleting.has(input.conversationId),
      'conversation_busy',
      '会话正在删除，请稍后操作。',
    );
    invariant(
      this.store.conversation(input.conversationId),
      'missing_conversation',
      input.conversationId,
    );
    const profileId =
      this.store.binding(input.conversationId)?.profileId ?? this.route(inferenceTasks.chat).id;
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const key = 'input-' + input.requestId;
    const old = this.store.receipt(key);
    if (old) {
      invariant(old.hash === hash, 'idempotency_conflict', '同一请求编号不能对应不同内容。');
      return { accepted: true, requestId: input.requestId, state: old.state };
    }
    this.store.saveReceipt(key, {
      kind: 'input',
      state: 'queued',
      hash,
      input,
      profileId,
      createdAt: new Date().toISOString(),
    });
    this.events.emit('input.changed', { conversationId: input.conversationId });
    queueMicrotask(() => void this.drain(input.conversationId));
    return { accepted: true, requestId: input.requestId, state: 'queued' };
  }
  inputs(conversationId: string) {
    return this.store
      .receipts()
      .filter(
        (r) =>
          ['input', 'steer'].includes(r.kind) &&
          (r.input?.conversationId ?? r.conversationId) === conversationId &&
          ['queued', 'running', 'unknown', 'accepted', 'failed'].includes(r.state),
      )
      .slice(-30)
      .map((r) => ({
        id: r.id,
        requestId: r.input?.requestId ?? r.requestId,
        kind: r.kind,
        state: r.state,
        text: r.input?.text ?? r.text,
        runId: r.runId,
        error: r.error,
      }));
  }
  cancelInput(requestId: string, conversationId: string) {
    const key = 'input-' + requestId,
      receipt = this.store.receipt(key);
    invariant(
      receipt?.input.conversationId === conversationId && receipt.state === 'queued',
      'input_state',
      '仅可移除当前会话尚未执行的排队消息。',
    );
    this.store.saveReceipt(key, { ...receipt, state: 'cancelled' });
    this.events.emit('input.changed', { conversationId });
    return { cancelled: true };
  }
  async steer(input: {
    conversationId: string;
    runId: string;
    requestId: string;
    text: string;
    attachmentIds?: string[];
    workSession?: true;
  }) {
    const roleSignal = this.characterSignal(this.store.conversation(input.conversationId)?.personaId ?? '');
    roleSignal.throwIfAborted();
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      key = 'steer-' + input.requestId;
    const old = this.store.receipt(key);
    if (old) {
      invariant(old.hash === hash, 'idempotency_conflict', '补充请求内容已变化。');
      return { state: old.state };
    }
    const run = this.store.run(input.runId);
    invariant(
      run?.conversationId === input.conversationId &&
        run.state === 'running' &&
        this.running.has(input.conversationId),
      'run_not_active',
      '当前运行已结束，请将消息排队到下一轮。',
    );
    const profile = this.profile(run.profileId),
      backend = this.executionBackend(profile, run.conversationId);
    invariant(
      backend.steer && backend.capabilities?.(profile).steer,
      'steer_unsupported',
      '此后端当前支持排队下一条，不支持运行中补充。',
    );
    const ids = input.attachmentIds ?? [],
      attachments = this.attachments.metadata(ids, input.conversationId);
    const content = await this.attachments.content(ids, input.conversationId);
    invariant(
      !content.images?.length || profile.vision,
      'vision_required',
      '当前模型未启用图片输入。',
    );
    const receipt = {
      kind: 'steer',
      hash,
      state: 'running',
      ...input,
      createdAt: new Date().toISOString(),
    };
    const messageContext = await captureMessageContext(this.capabilities, {
      role: 'user', source: 'human', time: receipt.createdAt, timezone: configuredTimezone(this.store),
      origin: { channel: input.workSession ? 'Role workbench' : 'App chat' }, preparedAt: receipt.createdAt,
    }, roleSignal);
    this.store.saveReceipt(key, receipt);
    try {
      await backend.steer({
        requestId: run.requestId,
        text: renderMessageText({ text: [input.text, content.text].filter(Boolean).join('\n\n'), messageContext }),
        images: content.images,
      });
      roleSignal.throwIfAborted();
      const message = this.store.transaction(() => {
        const message = this.store.append(
          input.conversationId,
          'user',
          'human',
          input.text,
          run.id,
          { steer: true, attachments, messageContext, ...(input.workSession ? { workSession: true } : {}) },
        );
        this.store.saveReceipt(key, { ...receipt, state: 'accepted' });
        return message;
      });
      this.events.emit('message.posted', {
        conversationId: input.conversationId,
        messageId: message.id,
      });
      return { state: 'accepted' };
    } catch (error) {
      const state = error instanceof EchoError && !error.uncertain ? 'failed' : 'unknown';
      this.store.saveReceipt(key, { ...receipt, state, error: String(error).slice(0, 1000) });
      throw error;
    } finally {
      this.events.emit('input.changed', { conversationId: input.conversationId });
    }
  }
  notice(input: {
    conversationId: string;
    requestId: string;
    title: string;
    text: string;
    bubble?: boolean;
    triggerKind?: string;
  }) {
    invariant(
      this.store.conversation(input.conversationId),
      'missing_conversation',
      '通知绑定的会话不存在',
    );
    const key = 'notice-' + input.requestId,
      hash = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      old = this.store.receipt(key);
    if (old) {
      invariant(old.hash === hash, 'idempotency_conflict', '同一通知编号对应不同内容');
      return old;
    }
    if (!characterActive(this.store, this.store.conversation(input.conversationId)!.personaId)) {
      const receipt = { kind: 'notice', state: 'suppressed', hash, conversationId: input.conversationId, reason: 'character_disabled' };
      this.store.saveReceipt(key, receipt);
      return receipt;
    }
    const receipt = this.store.transaction(() => {
      const message = this.store.append(
        input.conversationId,
        'system',
        'notification',
        input.title + '\n' + input.text,
        undefined,
        { author: 'notification', title: input.title, triggerKind: input.triggerKind },
      );
      if (input.bubble)
        this.store.saveReceipt('bubble-' + message.id, {
          kind: 'bubble',
          state: 'pending',
          conversationId: input.conversationId,
          messageId: message.id,
          text: message.text,
          createdAt: message.createdAt,
        });
      const record = {
        kind: 'notice',
        state: 'recorded',
        hash,
        messageId: message.id,
        conversationId: input.conversationId,
      };
      this.store.saveReceipt(key, record);
      for (const stage of this.deliveryStages) stage(message);
      return record;
    });
    this.events.emit('message.posted', {
      conversationId: input.conversationId,
      messageId: receipt.messageId,
    });
    return receipt;
  }
  registerDeliveryStage(stage: (message: Message, run?: Run) => void) {
    this.deliveryStages.add(stage);
    return () => { this.deliveryStages.delete(stage); };
  }

  registerReplyDecorator(
    decorate: (run: Run, text: string, target?: DeliveryPlan['targets'][number]) => { text: string; image?: ReplyImage },
  ) {
    invariant(!this.replyDecorator, 'reply_presentation', '回复呈现已注册。');
    this.replyDecorator = decorate;
    return () => {
      if (this.replyDecorator === decorate) this.replyDecorator = undefined;
    };
  }
  resumeSubmissions() {
    for (const receipt of this.store
      .receipts()
      .filter((r) => r.kind === 'steer' && r.state === 'running'))
      this.store.saveReceipt(receipt.id, {
        ...receipt,
        state: 'unknown',
        error: '进程中断，未重新投递补充指令。',
      });
    for (const receipt of this.store.receipts().filter((r) => r.kind === 'input')) {
      if (receipt.state === 'running' && !this.store.run(receipt.input.requestId)) {
        const input = receipt.input as Submission;
        this.store.createRun({
          id: randomUUID(),
          requestId: input.requestId,
          conversationId: input.conversationId,
          profileId: receipt.profileId,
          epoch: this.store.binding(input.conversationId)?.epoch ?? 0,
          state: 'unknown',
          input: input.text,
          source: input.source ?? 'human',
          createdAt: receipt.createdAt,
          error: '准备请求期间进程结束；未自动重放。',
          meta: { submission: true },
        });
      }
      if (receipt.state === 'queued')
        queueMicrotask(() => void this.drain(receipt.input.conversationId));
    }
  }
  async drain(conversationId: string) {
    if (
      this.closing ||
      this.draining.has(conversationId) ||
      this.locks.has(conversationId) ||
      this.store
        .unresolved()
        .some(
          (r) => r.conversationId === conversationId && ['running', 'unknown'].includes(r.state),
        )
    )
      return;
    const receipt = this.store.queuedInput(conversationId);
    if (!receipt) return;
    if (receipt.input.expiresAt !== undefined && receipt.input.expiresAt <= Date.now()) {
      this.store.saveReceipt(receipt.id, { ...receipt, state: 'expired' });
      queueMicrotask(() => void this.drain(conversationId));
      return;
    }
    this.draining.add(conversationId);
    this.store.saveReceipt(receipt.id, { ...receipt, state: 'running' });
    try {
      const run = await this.send(receipt.input);
      this.store.saveReceipt(receipt.id, { ...receipt, state: run.state, runId: run.id });
    } catch (e) {
      this.store.saveReceipt(receipt.id, {
        ...receipt,
        state: 'failed',
        error: e instanceof Error ? e.message : '投递失败。',
      });
      this.events.emit('request.failed', {
        requestId: receipt.input.requestId,
        message: e instanceof Error ? e.message : '投递失败。',
      });
    } finally {
      this.draining.delete(conversationId);
      this.events.emit('input.changed', { conversationId });
      queueMicrotask(() => void this.drain(conversationId));
    }
  }
  private effective(messages: Message[], limit: number, tokenLimit = Infinity) {
    const timezone = configuredTimezone(this.store);
    let size = 0;
    let tokens = 0;
    const selected: Message[] = [];
    for (const m of [...messages].reverse()) {
      if (!eligibleHistory(m)) continue;
      const text = renderMessageText({ text: m.text, messageContext: storedMessageContext(m, timezone) });
      if (size + text.length > limit) break;
      if (tokenLimit !== Infinity) {
        tokens += estimateTokens(text) + 4;
        if (tokens > tokenLimit) break;
      }
      size += text.length;
      selected.unshift(m);
    }
    return selected;
  }
  private async input(messages: Message[]): Promise<ModelInput[]> {
    const timezone = configuredTimezone(this.store);
    return Promise.all(
      messages
        .filter((m) => !m.meta.presentationOnly && !(m.source === 'import' && typeof m.meta.knowledgeVersion === 'string'))
        .map(async (m) => {
          const content = await this.attachments.content(
            ((m.meta.attachments as any[]) ?? []).map((a) => a.id),
            m.conversationId,
          );
          const target = (m.meta.delivery as DeliveryPlan | undefined)?.targets[0];
          const reply = m.role === 'assistant' && target && ['progress', 'final'].includes(String(m.meta.replyPhase))
            ? replySubmission.safeParse({ targetId: target.id, phase: m.meta.replyPhase,
                ...(m.meta.replyTitle ? { title: m.meta.replyTitle } : {}), messages: m.meta.replyParts ?? [m.text] })
            : undefined;
          return {
            id: m.id,
            role: m.role,
            ...(m.role === 'system' ? { context: 'event' as const } : {}),
            text: [m.text, content.text].filter(Boolean).join('\n\n'),
            images: content.images,
            messageContext: storedMessageContext(m, timezone),
            ...(reply?.success ? { reply: reply.data } : {}),
          };
        }),
    );
  }
  async infer(
    task: Task,
    messages: ModelInput[],
    signal: AbortSignal,
    override?: Reasoning,
    personaId?: string,
    profileId?: string,
    limits?: { maxOutputTokens?: number },
  ): Promise<GenerateResult> {
    invariant(!this.updating, 'updating', 'Echo 正在重启更新，请稍后执行。');
    this.inferenceCalls++;
    try { return await this.inferTask(task, messages, signal, override, personaId, profileId, limits); }
    finally { this.inferenceCalls--; }
  }
  private async inferTask(
    task: Task, messages: ModelInput[], signal: AbortSignal, override?: Reasoning,
    personaId?: string, profileId?: string, limits?: { maxOutputTokens?: number },
  ): Promise<GenerateResult> {
    if(personaId)signal=AbortSignal.any([signal,this.characterSignal(personaId)]);
    await this.inference.refresh();
    signal.throwIfAborted();
    const profile = await this.inference.prepare(
      profileId ? this.profile(profileId) : this.route(task, personaId),
      override,
      signal,
    );
    const review = task === inferenceTasks.review;
    // Thinking effort and output length are independent. Inherit the saved model
    // budget unless this task explicitly overrides it; never silently shrink a
    // non-thinking Review to 8K or enlarge an intentional user limit.
    const requestedOutput = limits?.maxOutputTokens ?? profile.maxOutputTokens;
    const contextWindow = profile.modelOptions.contextWindowTokens;
    const availableOutput =
      typeof contextWindow === 'number'
        ? contextWindow -
          messages.reduce((sum, message) => sum + estimateTokens(message.text) + 4, 256)
        : undefined;
    const maxOutputTokens =
      availableOutput === undefined
        ? requestedOutput
        : Math.min(requestedOutput, Math.max(64, availableOutput));
    if (maxOutputTokens !== undefined) {
      invariant(
        Number.isInteger(maxOutputTokens) && maxOutputTokens >= 64 && maxOutputTokens <= 131072,
        'output_budget',
        '任务输出上限必须为 64–131072 tokens。',
      );
      profile.maxOutputTokens = maxOutputTokens;
    }
    invariant(
      review || !this.inference.adapter(profile.adapterId!).workerOnly,
      'worker_only',
      '此辅助推理任务需要 API 模型；外部宿主仅用于 Worker。',
    );
    const model = this.inference.models().find((model) => model.id === profile.id),
      purpose = this.inference.task(task);
    invariant(
      model && purpose && this.inference.compatible(model, purpose),
      'route_capability',
      '所选模型当前不支持此推理用途。',
    );
    invariant(
      this.inference.models().find((m) => m.id === profile.id)?.generation.enabled,
      'generation_unsupported',
      '此模型未启用生成能力',
    );
    invariant(
      messages.reduce((n, m) => n + renderMessageText(m).length, 0) <= profile.contextChars,
      'context_limit',
      '任务内容超过此后端的上下文字符预算，请调整预算或分段。',
    );
    invariant(
      !messages.some((m) => m.images?.length) || profile.vision,
      'vision_unsupported',
      '此后端尚未声明支持图像。',
    );
    // Review is an agent task: Pi by default, or a separately configured host
    // Worker. Plain API transport remains available for observation and recall.
    const provider = this.backend(profile);
    const backend = review
      ? this.executionBackend(profile)
      : (this.inferenceTransports.get(provider) ?? provider);
    const result = await backend.generate({
      profile,
      messages,
      requestId: randomUUID(),
      toolPolicy: 'none',
      signal,
      reasoning: override,
    });
    signal.throwIfAborted();
    return result;
  }
  async bind(conversationId: string, profileId: string, signal: AbortSignal) {
    const conversation = this.store.conversation(conversationId);
    invariant(conversation, 'missing_conversation', conversationId);
    invariant(!this.locks.has(conversationId), 'conversation_busy', '会话正在执行或切换。');
    invariant(
      !this.store
        .unresolved()
        .some(
          (r) => r.conversationId === conversationId && ['running', 'unknown'].includes(r.state),
        ),
      'unresolved_run',
      '请先核对未完成或结果未知的运行。',
    );
    const profile = this.profile(profileId),
      backend = this.executionBackend(profile, conversationId),
      old = this.store.binding(conversationId);
    const model = this.inference.models().find((model) => model.id === profileId);
    invariant(
      model &&
        this.inference.supports(
          model,
          { operation: 'generate', inputs: ['text'] },
          !['main', 'group-member'].includes(conversation.kind ?? ''),
        ),
      'route_capability',
      '所选模型当前不支持此会话用途。',
    );
    invariant(
      !['main', 'group-member'].includes(conversation.kind ?? '') ||
        !this.inference.adapter(profile.adapterId!).workerOnly,
      'worker_only',
      '此外部执行器仅用于子任务，请为主会话选择语言模型。',
    );
    invariant(
      this.inference.models().find((m) => m.id === profileId)?.generation.enabled,
      'generation_unsupported',
      '向量模型不能绑定会话',
    );
    if (old?.profileId === profileId && old.state === 'active') {
      return old;
    }
    const pending = {
      conversationId,
      profileId,
      epoch: (old?.epoch ?? 0) + 1,
      state: 'switching' as const,
    };
    this.locks.add(conversationId);
    let switching = false;
    try {
      const history = await this.input(this.store.allMessages(conversationId));
      invariant(
        profile.vision || !history.some((message) => message.images?.length),
        'vision_required',
        '此会话含图片，请选择支持图片输入的目标模型。',
      );
      invariant(
        history.reduce((n, m) => n + renderMessageText(m).length, 0) <= profile.contextChars,
        'migration_context_limit',
        '完整历史超过目标后端预算；未截断或切换，请先调整预算。',
      );
      signal.throwIfAborted();
      this.store.saveBinding(pending);
      switching = true;
      if (old?.sessionId)
        await this.backend(this.profile(old.profileId)).archiveSession?.(
          this.profile(old.profileId),
          old.sessionId,
        );
      const sessionId = await backend.createSession?.(profile, history, signal);
      const binding = { ...pending, sessionId, state: 'active' as const };
      this.store.saveBinding(binding);
      this.events.emit('binding.changed', { conversationId, profileId, epoch: binding.epoch });
      return binding;
    } catch (e) {
      if (switching) this.store.saveBinding({ ...pending, state: 'unknown' });
      throw e;
    } finally {
      this.locks.delete(conversationId);
      setImmediate(() => void this.drain(conversationId));
    }
  }
  async deleteConversation(
    conversationId: string,
    assertUnreferenced: () => void,
    signal: AbortSignal,
  ) {
    invariant(this.store.conversation(conversationId), 'missing_conversation', '此会话已不存在。');
    invariant(
      !this.locks.has(conversationId) && !this.draining.has(conversationId),
      'conversation_busy',
      '请先停止此会话的运行，再删除。',
    );
    invariant(
      !this.store.unresolved(conversationId).length,
      'unresolved_run',
      '请先在诊断中核对未完成或结果未知的运行，再删除。',
    );
    const binding = this.store.binding(conversationId);
    invariant(
      !binding || binding.state === 'active',
      'binding_not_ready',
      '请先处理尚未确认的后端切换。',
    );
    assertUnreferenced();
    this.locks.add(conversationId);
    this.deleting.add(conversationId);
    try {
      if (binding?.sessionId) {
        const profile = this.profile(binding.profileId);
        this.store.saveBinding({ ...binding, state: 'unknown' });
        await this.backend(profile).archiveSession?.(profile, binding.sessionId);
      }
      signal.throwIfAborted();
      assertUnreferenced();
      this.store.deleteConversation(conversationId);
      await this.attachments.cleanupOrphans();
      this.events.emit('conversation.deleted', { conversationId, id: conversationId });
      return { deleted: true, id: conversationId };
    } finally {
      this.locks.delete(conversationId);
      this.deleting.delete(conversationId);
    }
  }
  send(input: Submission, signal?: AbortSignal): Promise<Run> {
    if (this.updating) return Promise.reject(new EchoError('updating', 'Echo 正在重启更新，请稍后执行。'));
    if (this.store.documents<{ conversationId: string; execution?: string }>('work-sessions')
      .some(work => work.conversationId === input.conversationId && work.execution === 'inference'))
      return Promise.reject(new EchoError('work_managed', '此子任务由来源自动化任务执行，请在来源任务中配置。'));
    const task = this.execute(input, signal);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  private async execute(input: Submission, signal?: AbortSignal): Promise<Run> {
    const source = input.source ?? 'human';
    const existing = this.store.run(input.requestId);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          input.conversationId,
          input.text,
          source,
          input.reasoning ?? null,
          input.bubble ?? false,
          input.origin ?? null,
          input.attachmentIds ?? null,
          ...((input.delivery ?? (!existing?.meta.implicitDelivery && existing?.meta.delivery))
            ? [input.delivery ?? existing?.meta.delivery] : []),
          ...(input.triggerKind && (!existing || existing.meta.triggerKind)
            ? [input.triggerKind]
            : []),
          ...(input.localOnly || existing?.meta.localOnly ? [Boolean(input.localOnly)] : []),
          ...(input.workSession || existing?.meta.workSession ? [Boolean(input.workSession)] : []),
          ...((!existing || existing.meta.messageOrigin) && (input.messageOrigin ?? existing?.meta.messageOrigin)
            ? [input.messageOrigin ?? existing?.meta.messageOrigin] : []),
        ]),
      )
      .digest('hex');
    if (existing) {
      invariant(
        existing.meta.fingerprint === fingerprint,
        'idempotency_conflict',
        '同一请求编号不能对应不同内容。',
      );
      return existing;
    }
    const conversation = this.store.conversation(input.conversationId);
    invariant(conversation, 'missing_conversation', input.conversationId);
    invariant(characterActive(this.store,conversation.personaId),'character_disabled','角色已停用，请先启用角色。');
    invariant(!this.locks.has(conversation.id), 'conversation_busy', '会话正在运行，请稍后发送。');
    invariant(
      !this.store
        .unresolved()
        .some(
          (r) => r.conversationId === conversation.id && ['unknown', 'running'].includes(r.state),
        ),
      'unresolved_run',
      '上次执行结果未知，请先在诊断中核对。',
    );
    let binding = this.store.binding(conversation.id);
    invariant(
      binding ||
        conversation.kind !== 'main' ||
        !this.store.document('characters', conversation.personaId),
      'character_backend',
      '请先在角色配置中选择主会话运行后端。',
    );
    if (!binding)
      binding = await this.bind(
        conversation.id,
        this.route(inferenceTasks.chat).id,
        signal ?? new AbortController().signal,
      );
    invariant(!this.locks.has(conversation.id), 'conversation_busy', '会话正在运行，请稍后发送。');
    invariant(
      this.store.binding(conversation.id)?.epoch === binding.epoch,
      'stale_epoch',
      '会话连接已变化，请重新提交。',
    );
    invariant(binding.state === 'active', 'binding_not_ready', '会话后端切换尚未确认。');
    const workerDefaults = conversation.kind === 'worker'
      ? this.store.document<{ maxOutputTokens?: number }>('character-settings.delegation', conversation.personaId) : undefined;
    const outputLimit = conversation.maxOutputTokens ?? workerDefaults?.maxOutputTokens;
    const profile = { ...this.profile(binding.profileId),
        ...(outputLimit ? { maxOutputTokens: outputLimit } : {}) },
      backend = this.executionBackend(profile, conversation.id);
    const attachments = this.attachments.metadata(input.attachmentIds ?? [], conversation.id);
    invariant(
      profile.vision || !attachments.some((item) => item.kind === 'image'),
      'vision_required',
      '当前模型未启用图片输入。',
    );
    invariant(
      this.inference.models().find((m) => m.id === profile.id)?.generation.enabled,
      'generation_unsupported',
      '此模型未启用生成能力',
    );
    this.locks.add(conversation.id);
    const controller = new AbortController();
    this.running.set(conversation.id, controller);
    const combined = AbortSignal.any([controller.signal,this.characterSignal(conversation.personaId),...(signal?[signal]:[])]);
    let run: Run | undefined;
    try {
      const preparedAt = new Date().toISOString();
      const messageContext = await captureMessageContext(this.capabilities, {
        role: source === 'human' ? 'user' : 'system', source,
        time: this.store.receipt('input-' + input.requestId)?.createdAt ?? preparedAt,
        timezone: configuredTimezone(this.store), preparedAt,
        origin: {
          ...(source === 'human' && !input.origin ? { channel: input.bubble ? 'Desktop pet' : input.workSession ? 'Role workbench' : 'App chat' } : {}),
          ...(input.triggerKind ? { task: input.triggerKind } : {}),
          ...input.messageOrigin,
        },
      }, combined);
      const currentText = renderMessageText({ text: input.text, messageContext });
      const delivery = input.delivery ?? ((input.bubble || (conversation.kind === 'main' && source === 'human')) && !input.origin && !input.workSession
        ? await this.planLocalReply?.(conversation.id, Boolean(input.bubble), combined)
        : undefined);
      const targets = delivery?.targets.filter((target) => target.ready) ?? [];
      const expression = this.store.document<Persona>('personas', conversation.personaId)?.expression;
      const replyStyles = targets.map((target) => {
        const style = target.style ?? (target.presentation === 'bubble' ? 'bubble' : target.presentation === 'external' ? 'external' : 'chat');
        const text = style === 'external' || style === 'bubble' || style === 'chat'
          ? expression?.[style]
          : expression?.channels?.[style] ?? (target.presentation === 'external' ? expression?.external : undefined);
        return { id: target.id, label: target.label, text: text ?? '', supportsImages: target.supportsImages };
      });
      const recent = this.store.recentMessages(conversation.id).filter(message => message.id !== input.recordedInputId);
      const contextInput = {
        action: 'prepare',
        conversation,
        text: input.text,
        source,
        outputTargets: delivery?.targets.map(target=>target.id),
        replyStyles,
        presentation:
          delivery ? targets.length === 1 ? targets[0].presentation : undefined :
          source === 'human' && input.origin
            ? 'external'
            : input.bubble && (source === 'human' || source === 'care')
              ? 'bubble'
              : undefined,
      } as const;
      const contextCache = new Map<string, Record<string, ContextItem[]>>();
      const stable = await this.prepareContext(
        { ...contextInput, effective: [], phase: 'stable' },
        combined,
        contextCache,
      );
      const prefix = stable.prefix.map((item) => item.text).join('\n\n');
      const compacted = await compactConversation({
        store: this.store,
        events: this.events,
        conversation,
        backend,
        profile,
        recent,
        base: prefix + '\n' + currentText,
        generate: true,
        signal: combined,
      });
      const summary = compacted.summary;
      let budget = profile.contextChars - prefix.length - currentText.length - summary.length;
      const historyTokenBudget = compacted.tokenBudget === undefined
        ? Infinity
        : compacted.tokenBudget - (summary ? estimateTokens(summary) + 4 : 0);
      let tokenBudget = historyTokenBudget;
      let effective = this.effective(compacted.recent, budget, tokenBudget);
      let context: Awaited<ReturnType<Router['prepareContext']>> = { prefix: [], turn: [] };
      // Recompute history-dependent contributors when turn references evict
      // history. The budget only decreases; expensive independent blocks cache.
      for (let pass = 0; pass < 6; pass++) {
        context = await this.prepareContext(
          { ...contextInput, effective, phase: 'turn' },
          combined,
          contextCache,
        );
        const available =
          profile.contextChars -
          prefix.length -
          currentText.length -
          summary.length -
          context.turn.reduce((size, item) => size + item.text.length, 0);
        budget = Math.min(budget, available);
        if (historyTokenBudget !== Infinity)
          tokenBudget = Math.min(
            tokenBudget,
            historyTokenBudget - context.turn.reduce((size, item) => size + estimateTokens(item.text) + 4, 0),
          );
        const next = this.effective(compacted.recent, budget, tokenBudget);
        if (next.map((m) => m.id).join() === effective.map((m) => m.id).join()) break;
        effective = next;
        if (pass === 5) {
          effective = [];
          context = await this.prepareContext(
            { ...contextInput, effective, phase: 'turn' },
            combined,
            contextCache,
          );
        }
      }
      const turnSize = context.turn.reduce((size, item) => size + item.text.length, 0);
      invariant(
        prefix.length + currentText.length + summary.length + turnSize <= profile.contextChars,
        'context_limit',
        '当前输入与固定上下文超过此后端的字符预算，未发送模型请求。',
      );
      run = {
        id: randomUUID(),
        requestId: input.requestId,
        conversationId: conversation.id,
        profileId: profile.id,
        epoch: binding.epoch,
        state: 'running',
        input: input.text,
        source,
        createdAt: new Date().toISOString(),
        meta: {
          fingerprint,
          bubble: input.bubble ?? false,
          ...(delivery ? { delivery, implicitDelivery: !input.delivery } : {}),
          ...(input.workSession ? { workSession: true } : {}),
          origin: input.origin,
          triggerKind: input.triggerKind,
          ...(input.messageOrigin ? { messageOrigin: input.messageOrigin } : {}),
          ...(input.localOnly ? { localOnly: true } : {}),
        },
      };
      const { current, turn } = this.store.transaction(() => {
        const turn = context.turn.map((item): ModelInput => ({
          role: 'system',
          context: 'turn',
          text: item.text,
          ...(item.record
            ? {
                id: this.store.append(
                  conversation.id,
                  'system',
                  'import',
                  item.text,
                  undefined,
                  item.record,
                ).id,
              }
            : {}),
        }));
        const recorded = input.recordedInputId ? this.store.message(input.recordedInputId) : undefined;
        invariant(!input.recordedInputId || recorded?.conversationId === conversation.id && recorded.text === input.text,
          'result_message', '已登记的任务结果与本次输入不一致。');
        const current = recorded ?? this.store.append(
          conversation.id,
          source === 'human' ? 'user' : 'system',
          source,
          input.text,
          run!.id,
          {
            ...(delivery ? { delivery } : {}),
            ...(input.workSession ? { workSession: true } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
            ...(input.triggerKind ? { triggerKind: input.triggerKind } : {}),
            ...(attachments.length ? { attachments } : {}),
            messageContext,
          },
        );
        this.store.createRun(run!);
        return { current, turn };
      });
      this.events.emit('run.started', { run });
      this.execution.open(run.id, conversation.id);
      const history = effective;
      const historyInput = await this.input(history);
      const [currentInput] = await this.input([current]);
      const messages: ModelInput[] = [
        ...(prefix ? [{ role: 'system' as const, text: prefix }] : []),
        ...(summary ? [{ role: 'user' as const, context: 'turn' as const, text: summary }] : []),
        ...historyInput,
        ...turn,
        currentInput,
      ];
      const details = new Map<string, ContextDetail>();
      if (compacted.inputLimit !== undefined) {
        const add = (group: ContextDetail['group'], source: string, text: string, overhead = 0) => {
          const key = group + ':' + source;
          const previous = details.get(key)?.tokens ?? 0;
          details.set(key, { group, source, tokens: previous + estimateTokens(text) + overhead });
        };
        for (const item of stable.prefix) add('prefix', item.source, item.text);
        if (summary) add('history', 'summary', summary, 4);
        historyInput.forEach((message, index) => {
          const stored = history[index];
          add('history', stored.meta.memoryVersion ? 'memory.recall' : stored.source, renderMessageText(message), 4);
        });
        for (const item of context.turn) add('turn', item.source, item.text, 4);
        add(current.role === 'user' ? 'history' : 'turn', current.source, renderMessageText(currentInput), 4);
      }
      invariant(
        messages.reduce((n, m) => n + renderMessageText(m).length, 0) <= profile.contextChars,
        'context_limit',
        '消息与附件超过当前上下文预算，未发送模型请求。',
      );
      if (compacted.inputLimit !== undefined) {
        const contextInputTokens = messages.reduce((n, m) => n + estimateTokens(renderMessageText(m)) + 4, 0);
        invariant(
          contextInputTokens <= compacted.inputLimit,
          'context_limit',
          '消息与附件超过模型上下文的估算输入预算，未发送模型请求。',
        );
        run.meta.contextInputTokens = contextInputTokens;
      }
      const interactionLife = new AbortController();
      const submitted = new Map<string, Message>();
      const replyReceipt = () => ({
        accepted: true as const,
        completedTargets: targets.filter(target => submitted.has(target.id + ':final')).map(target => target.id),
        remainingTargets: targets.filter(target => !submitted.has(target.id + ':final')).map(target => target.id),
      });
      const respond = (value: ReplySubmission) => {
        combined.throwIfAborted();
        invariant(this.store.binding(conversation.id)?.epoch === run!.epoch, 'stale_epoch', '旧绑定结果不再投递。');
        const reply = replySubmission.parse(value);
        const target = targets.find(({ id }) => id === reply.targetId);
        invariant(delivery && target, 'reply_target', '该目标不在本轮授权范围内。');
        const key = reply.targetId + ':' + reply.phase;
        const old = submitted.get(key);
        if (old) {
          invariant(old.meta.replyTitle === reply.title && JSON.stringify(old.meta.submittedParts) === JSON.stringify(reply.messages), 'reply_duplicate', '该目标已提交同阶段回复。');
          return replyReceipt();
        }
        invariant(!submitted.has(reply.targetId + ':final'), 'reply_complete', '该目标已提交最终答复。');
        invariant(reply.messages.every((part) => part !== observationSilence), 'reply_control', '跳过信号应直接作为本轮结果。');
        const message = this.store.transaction(() => this.recordReply(run!, reply.messages.join('\n\n'), {
          delivery: { ...delivery, targets: [target] },
          replyPhase: reply.phase,
          ...(reply.title ? { replyTitle: reply.title } : {}),
          submittedParts: reply.messages,
        }));
        submitted.set(key, message);
        this.events.emit('message.posted', { conversationId: conversation.id });
        return replyReceipt();
      };
      const result = await backend
        .generate({
          profile: await this.inference.prepare(
            profile,
            input.reasoning ?? conversation.reasoning,
            combined,
          ),
          messages,
          ...(details.size ? { contextDetails: [...details.values()] } : {}),
          sessionId: binding.sessionId,
          requestId: input.requestId,
          principal: {
            conversationId: conversation.id,
            personaId: conversation.personaId,
          },
          compaction: conversationCompaction(this.store, conversation),
          reasoning: input.reasoning ?? conversation.reasoning,
          signal: combined,
          onMetrics: metrics => {
            if (combined.aborted || !run || this.store.run(run.id)?.state !== 'running') return;
            run = { ...run, meta: { ...run.meta, generationMetrics: metrics } };
            this.store.updateRun(run);
            this.events.emit('run.metrics', { run });
          },
          ...(targets.length ? { respond, replyTargets: targets.map(({ id }) => id),
            allowSilence: ['observation', 'care'].includes(source) } : {}),
          ...(['human', 'delegation', 'group', 'handoff', 'review', 'observation', 'care', 'trigger'].includes(source)
            ? {
                permissions: conversation.permissions,
                onInteraction: (input, signal) =>
                  this.interactions.ask(
                    conversation.id,
                    run!.id,
                    input,
                    AbortSignal.any([combined, signal, interactionLife.signal]),
                  ),
              }
            : {}),
          onDelta: (text) => {
            if (this.store.binding(conversation.id)?.epoch === run!.epoch)
              this.events.emit('run.delta', {
                runId: run!.id,
                conversationId: conversation.id,
                text,
              });
          },
          onNativeRun: (id) => {
            run!.nativeRunId = id;
            this.store.updateRun(run!);
          },
          onItem: (item) => {
            if (!combined.aborted && this.store.binding(conversation.id)?.epoch === run!.epoch) {
              this.execution.update(run!.id, item);
              if (item.id === 'context-compaction' && item.state === 'completed' && item.detail)
                this.store.append(conversation.id, 'system', 'import',
                  '本次执行过程摘要（历史资料）：\n' + item.detail, run!.id, { executionSummary: true });
            }
          },
        })
        .finally(() => interactionLife.abort());
      combined.throwIfAborted();
      invariant(
        this.store.binding(conversation.id)?.epoch === run.epoch,
        'stale_epoch',
        '旧绑定结果不再投递。',
      );
      const finals = [...submitted.values()].filter((message) => message.meta.replyPhase === 'final');
      return this.complete(run, result, binding, finals);
    } catch (e) {
      if (run) {
        run = {
          ...run,
          state:
            e instanceof EchoError && e.uncertain
              ? 'unknown'
              : combined.aborted
                ? 'cancelled'
                : 'failed',
          error: e instanceof Error ? e.message : '执行失败',
          meta: { ...run.meta, ...((e as { metrics?: unknown })?.metrics ? { generationMetrics: (e as { metrics: unknown }).metrics } : {}) },
        };
        this.store.updateRun(run);
        this.execution.finish(run.id, run.state as 'failed' | 'cancelled' | 'unknown');
        this.events.emit('run.completed', { run });
        return run;
      }
      throw e;
    } finally {
      this.locks.delete(conversation.id);
      this.running.delete(conversation.id);
      queueMicrotask(() => void this.drain(conversation.id));
    }
  }
  cancel(conversationId: string) {
    this.running.get(conversationId)?.abort();
  }
  private recordReply(run: Run, text: string, meta: Record<string, unknown> = {}, decorated?: { text: string; image?: ReplyImage }) {
    const taskResult = this.store.receipt('task-result.' + run.requestId);
    const target = (meta.delivery as DeliveryPlan | undefined)?.targets[0];
    const reply = decorated ?? this.replyDecorator?.(run, text, target) ?? { text };
    invariant(reply.text.trim(), 'reply_empty', '回复正文为空。');
    const submitted = meta.submittedParts as string[] | undefined;
    const prefix = submitted && submitted.length > 1 ? submitted.slice(0, -1).join('\n\n') + '\n\n' : '';
    const parts = submitted && (reply.text.startsWith(prefix)
      ? [...submitted.slice(0, -1), reply.text.slice(prefix.length)].filter(Boolean)
      : [reply.text]);
    const message = this.store.append(run.conversationId, 'assistant', run.source === 'human' ? 'chat' : run.source, reply.text, run.id, {
      ...(run.meta.delivery ? { delivery: run.meta.delivery } : {}),
      ...(run.meta.workSession ? { workSession: true } : {}),
      ...(taskResult ? { taskResultId: run.requestId, taskResultReviewable: taskResult.context?.reviewable !== false } : {}),
      ...(run.meta.triggerKind ? { triggerKind: run.meta.triggerKind } : {}),
      ...(reply.image ? { image: reply.image } : {}),
      ...meta,
      ...(parts?.length ? { replyParts: parts } : {}),
      messageContext: {
        time: new Date().toISOString(), timezone: configuredTimezone(this.store),
        sender: this.store.document<Persona>('personas', this.store.conversation(run.conversationId)!.personaId)?.name ?? 'assistant',
        ...(target ? { channel: target.label.slice(0, 160) } : {}),
      },
    });
    for (const stage of this.deliveryStages) stage(message, run);
    return message;
  }
  private complete(run: Run, result: GenerateResult, binding: Binding, finals: Message[] = []) {
    const targets = (run.meta.delivery as DeliveryPlan | undefined)?.targets.filter((target) => target.ready) ?? [];
    const text = result.text.trim();
    const silent = ['observation', 'care'].includes(run.source) && (!text || text === observationSilence);
    if (targets.length && (finals.length || !silent)) {
      const finished = new Set(finals.map((message) => (message.meta.delivery as DeliveryPlan).targets[0]?.id));
      invariant(targets.every(({ id }) => finished.has(id)), 'reply_incomplete', '模型未通过 echo_respond 完成所有渠道的回复。');
    }
    const final = finals.find((message) => (message.meta.delivery as DeliveryPlan).targets[0]?.id === 'core.chat') ?? finals.at(-1);
    const decorated = final ? { text: final.text } : this.replyDecorator?.(run, result.text) ?? { text: result.text };
    const answer = decorated.text.trim();
    const observationOutcome =
      run.source === 'observation'
        ? answer === observationSilence
          ? 'skip'
          : answer
            ? 'reply'
            : 'empty'
        : undefined;
    const careSilence = run.source === 'care' && answer === observationSilence;
    const reply = observationOutcome === 'skip' || careSilence ? '' : decorated.text;
    const completed: Run = {
      ...run,
      state: 'succeeded',
      result: reply,
      error: undefined,
      nativeRunId: result.nativeRunId ?? run.nativeRunId,
      meta: {
        ...run.meta,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.metrics ? { generationMetrics: result.metrics } : {}),
        ...(observationOutcome ? { observationOutcome } : {}),
        ...(careSilence ? { careOutcome: 'skip' } : {}),
        ...(result.execution ? { execution: result.execution } : {}),
      },
    };
    this.store.transaction(() => {
      if (reply.trim() && !this.store.assistantForRun(run.id)) {
        this.recordReply(completed, reply, {}, decorated);
      }
      this.store.updateRun(completed);
      if (run.state === 'unknown') this.settleInputReceipt(completed);
      if (result.sessionId) this.store.saveBinding({ ...binding, sessionId: result.sessionId });
    });
    if (run.state === 'unknown')
      this.events.emit('input.changed', { conversationId: run.conversationId });
    this.execution.finish(run.id, 'succeeded');
    this.events.emit('run.completed', { run: completed });
    return completed;
  }
  resolveUnknown(runId: string) {
    const run = this.store.run(runId);
    invariant(run?.state === 'unknown', 'run_state', '仅未知结果需要人工处理。');
    invariant(!this.locks.has(run.conversationId), 'conversation_busy', '会话正在核对结果。');
    return this.finishUnknown(run, '使用者已核对并手动结束此运行；未重发。');
  }
  private settleInputReceipt(run: Run) {
    const key = 'input-' + run.requestId;
    const receipt = this.store.receipt(key);
    if (
      receipt?.kind === 'input' &&
      receipt.input.conversationId === run.conversationId &&
      ['running', 'unknown'].includes(receipt.state)
    )
      this.store.saveReceipt(key, {
        ...receipt,
        state: run.state,
        runId: run.id,
        error: run.error,
      });
  }
  private finishUnknown(run: Run, error: string) {
    const completed: Run = {
      ...run,
      state: 'failed',
      error: run.error ?? error,
      meta: {
        ...run.meta,
        reconciliation: {
          at: new Date().toISOString(),
          note: error,
          originalState: run.state,
          originalError: run.error,
        },
      },
    };
    this.store.transaction(() => {
      this.store.updateRun(completed);
      this.settleInputReceipt(completed);
    });
    this.events.emit('input.changed', { conversationId: run.conversationId });
    this.execution.finish(run.id, 'failed');
    this.events.emit('run.completed', { run: completed });
    queueMicrotask(() => void this.drain(run.conversationId));
    return completed;
  }
  async reconcile(runId: string, signal: AbortSignal) {
    const run = this.store.run(runId);
    invariant(run, 'missing_run', runId);
    signal = AbortSignal.any([signal, this.characterSignal(this.store.conversation(run.conversationId)!.personaId)]);
    signal.throwIfAborted();
    if (run.state !== 'unknown') return run;
    invariant(!this.locks.has(run.conversationId), 'conversation_busy', '会话正在运行或核对。');
    const binding = this.store.binding(run.conversationId),
      profile = this.profile(run.profileId),
      backend = this.executionBackend(profile, run.conversationId);
    invariant(
      binding?.sessionId && binding.epoch === run.epoch && backend.inspect,
      'inspection_unavailable',
      '此后端没有公开结果核对接口，请人工确认后标记处理；系统不会自动重发。',
    );
    this.locks.add(run.conversationId);
    try {
      signal.throwIfAborted();
      const result = await backend.inspect(profile, binding.sessionId, run.nativeRunId);
      signal.throwIfAborted();
      if (result.state === 'succeeded') {
        try {
          return this.complete(run, { text: result.text ?? '' }, binding, this.store.channelFinalsForRun(run));
        } catch (error) {
          if (error instanceof EchoError && error.code === 'reply_incomplete') return this.finishUnknown(run, error.message);
          throw error;
        }
      }
      if (result.state === 'failed')
        return this.finishUnknown(run, result.error || '后端确认失败。');
      return run;
    } finally {
      this.locks.delete(run.conversationId);
      queueMicrotask(() => void this.drain(run.conversationId));
    }
  }
  async close() {
    this.closing = true;
    this.contextController.abort();
    for (const controller of this.running.values()) controller.abort();
    for (const backend of this.backends.values()) await backend.close?.();
    await Promise.allSettled(this.tasks);
    this.execution.close();
    this.inference.close();
  }
}
