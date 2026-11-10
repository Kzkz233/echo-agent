import type { DeliveryPlan } from '../contracts/delivery.ts';
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
import { compactConversation, eligibleHistory } from './compaction.ts';
import { estimateTokens, type ContextDetail } from '../contracts/generation-metrics.ts';

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
  delivery?: DeliveryPlan;
};
export class Router {
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
  private replyDecorator?: (run: Run, text: string) => { text: string; image?: ReplyImage };
  constructor(
    readonly store: Store,
    readonly events: Events,
    readonly capabilities = new Capabilities(),
  ) {
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
    this.context(
      {
        id: 'core',
        blocks: [
          {
            id: 'core.presentation',
            layer: 'turn',
            after: ['memory.recall', 'reflections.current', 'delegation.turn'],
          },
        ],
        prepare: ({ conversation, presentation }) => {
          if (!presentation) return { 'core.presentation': [] };
          const expression = this.store.document<Persona>(
            'personas',
            conversation.personaId,
          )?.expression;
          const text =
            presentation === 'external'
              ? '本轮通过消息渠道回复。' +
                (expression?.external ||
                  '先说重点，分短段，复杂排版改成简洁的列表；需要详细说明时保留必要内容。')
              : '本轮显示在桌宠小气泡。' +
                (expression?.bubble ||
                  '口语化，先说重点，闲聊通常一两句；用短段落，避免表格和大段代码。');
          return { 'core.presentation': [{ text: '[Echo 本轮展示约定] ' + text }] };
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
    const ordered = orderContext(describe.flat());
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
            ordered.some((item) => item.provider === block.provider && item.id === id),
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
    this.store.saveReceipt(key, receipt);
    try {
      await backend.steer({
        requestId: run.requestId,
        text: [input.text, content.text].filter(Boolean).join('\n\n'),
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
          { steer: true, attachments },
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
    decorate: (run: Run, text: string) => { text: string; image?: ReplyImage },
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
    let size = 0;
    let tokens = 0;
    const selected: Message[] = [];
    for (const m of [...messages].reverse()) {
      if (!eligibleHistory(m)) continue;
      if (size + m.text.length > limit) break;
      if (tokenLimit !== Infinity) {
        tokens += estimateTokens(m.text) + 4;
        if (tokens > tokenLimit) break;
      }
      size += m.text.length;
      selected.unshift(m);
    }
    return selected;
  }
  private async input(messages: Message[]): Promise<ModelInput[]> {
    return Promise.all(
      messages
        .filter((m) => !m.meta.presentationOnly && !(m.source === 'import' && typeof m.meta.knowledgeVersion === 'string'))
        .map(async (m) => {
          const content = await this.attachments.content(
            ((m.meta.attachments as any[]) ?? []).map((a) => a.id),
            m.conversationId,
          );
          return {
            id: m.id,
            role: m.role,
            text: [m.text, content.text].filter(Boolean).join('\n\n'),
            images: content.images,
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
    if(personaId)signal=AbortSignal.any([signal,this.characterSignal(personaId)]);
    await this.inference.refresh();
    signal.throwIfAborted();
    const profile = await this.inference.prepare(
      profileId ? this.profile(profileId) : this.route(task, personaId),
      override,
      signal,
    );
    const review = task === inferenceTasks.review;
    const effort = !override || override === 'inherit' ? profile.reasoning : override;
    const deepSeekReviewDefault =
      review && (profile.reasoningStyle === 'deepseek' || profile.reasoningSupport?.style === 'deepseek')
        ? (effort === 'off' ? 8192 : effort === 'max' ? 131072 : 65536)
        : undefined;
    const contextWindow = profile.modelOptions.contextWindowTokens;
    const availableOutput = deepSeekReviewDefault !== undefined && typeof contextWindow === 'number'
      ? contextWindow - messages.reduce((sum, message) => sum + estimateTokens(message.text) + 4, 256)
      : undefined;
    const automaticOutput = deepSeekReviewDefault === undefined || availableOutput === undefined
      ? deepSeekReviewDefault
      : Math.min(deepSeekReviewDefault, Math.max(64, availableOutput));
    const maxOutputTokens = limits?.maxOutputTokens ?? automaticOutput;
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
      messages.reduce((n, m) => n + m.text.length, 0) <= profile.contextChars,
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
        history.reduce((n, m) => n + m.text.length, 0) <= profile.contextChars,
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
          ...((input.delivery ?? existing?.meta.delivery) ? [input.delivery ?? existing?.meta.delivery] : []),
          ...(input.triggerKind && (!existing || existing.meta.triggerKind)
            ? [input.triggerKind]
            : []),
          ...(input.localOnly || existing?.meta.localOnly ? [Boolean(input.localOnly)] : []),
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
    const profile = this.profile(binding.profileId),
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
      const recent = this.store.recentMessages(conversation.id);
      const contextInput = {
        action: 'prepare',
        conversation,
        text: input.text,
        source,
        outputTargets: input.delivery?.targets.map(target=>target.id),
        presentation:
          input.delivery ? input.delivery.targets.find(target=>target.presentation==='bubble')?.presentation ?? input.delivery.targets.find(target=>target.presentation==='external')?.presentation :
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
        base: prefix + '\n' + input.text,
        generate: source === 'human',
        signal: combined,
      });
      const summary = compacted.summary;
      let budget = profile.contextChars - prefix.length - input.text.length - summary.length;
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
          input.text.length -
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
        prefix.length + input.text.length + summary.length + turnSize <= profile.contextChars,
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
          ...(input.delivery ? { delivery: input.delivery } : {}),
          origin: input.origin,
          triggerKind: input.triggerKind,
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
        const current = this.store.append(
          conversation.id,
          source === 'human' ? 'user' : 'system',
          source,
          input.text,
          run!.id,
          {
            ...(input.delivery ? { delivery: input.delivery } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
            ...(input.triggerKind ? { triggerKind: input.triggerKind } : {}),
            ...(attachments.length ? { attachments } : {}),
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
          add('history', stored.meta.memoryVersion ? 'memory.recall' : stored.source, message.text, 4);
        });
        for (const item of context.turn) add('turn', item.source, item.text, 4);
        add(current.role === 'user' ? 'history' : 'turn', current.source, currentInput.text, 4);
      }
      invariant(
        messages.reduce((n, m) => n + m.text.length, 0) <= profile.contextChars,
        'context_limit',
        '消息与附件超过当前上下文预算，未发送模型请求。',
      );
      if (compacted.inputLimit !== undefined) {
        const contextInputTokens = messages.reduce((n, m) => n + estimateTokens(m.text) + 4, 0);
        invariant(
          contextInputTokens <= compacted.inputLimit,
          'context_limit',
          '消息与附件超过模型上下文的估算输入预算，未发送模型请求。',
        );
        run.meta.contextInputTokens = contextInputTokens;
      }
      const interactionLife = new AbortController();
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
          reasoning: input.reasoning ?? conversation.reasoning,
          signal: combined,
          ...(['human', 'delegation', 'group', 'handoff'].includes(source)
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
            if (!combined.aborted && this.store.binding(conversation.id)?.epoch === run!.epoch)
              this.execution.update(run!.id, item);
          },
        })
        .finally(() => interactionLife.abort());
      combined.throwIfAborted();
      invariant(
        this.store.binding(conversation.id)?.epoch === run.epoch,
        'stale_epoch',
        '旧绑定结果不再投递。',
      );
      return this.complete(run, result, binding);
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
  private complete(run: Run, result: GenerateResult, binding: Binding) {
    const decorated = this.replyDecorator?.(run, result.text) ?? { text: result.text };
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
    const image = decorated.image;
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
        const message = this.store.append(
          run.conversationId,
          'assistant',
          run.source === 'human' ? 'chat' : run.source,
          reply,
          run.id,
          {
            ...(run.meta.delivery ? { delivery: run.meta.delivery } : {}),
            ...(run.meta.triggerKind ? { triggerKind: run.meta.triggerKind } : {}),
            ...(image ? { image } : {}),
          },
        );
        if (run.meta.bubble && !run.meta.delivery)
          this.store.saveReceipt(`bubble-${message.id}`, {
            kind: 'bubble',
            state: 'pending',
            conversationId: run.conversationId,
            messageId: message.id,
            text: message.text,
            createdAt: new Date().toISOString(),
          });
        for (const stage of this.deliveryStages) stage(message, completed);
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
      if (result.state === 'succeeded')
        return this.complete(run, { text: result.text ?? '' }, binding);
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
