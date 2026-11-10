import { mkdirSync } from 'node:fs';
import { isStableContext, textWithTurnContext } from './turn-context.ts';
import { join } from 'node:path';
import {
  EchoError,
  invariant,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
  type ModelInput,
  type Profile,
} from '../contracts/index.ts';
import { StdioRpc } from './rpc.ts';
import { Store } from '../kernel/store.ts';
import { createHash, randomUUID } from 'node:crypto';
import { version } from '../contracts/version.ts';
import { selectCodexReasoning, codexFailure, type CodexModel } from './codex-reasoning.ts';
import { answerCodex } from './codex-interactions.ts';
import { projectRoot } from './project-root.ts';
import { codexEvent } from './execution-events.ts';
import type { SteerRequest } from '../contracts/execution.ts';
import { readReasoningSupport } from './model-metadata.ts';
import { reasoningLevels } from '../contracts/reasoning.ts';
import { z } from 'zod';
import type { Operation } from '../kernel/registry.ts';
import type { AgentPrincipal } from '../contracts/index.ts';
type ManagedSession = {
  profileId: string;
  seed: ModelInput[];
  nativeId?: string;
  admitted: boolean;
  archived?: boolean;
  model?: string;
  toolsHash?: string;
};
export type CodexEchoTools = {
  list(principal: AgentPrincipal): Operation[];
  call(
    principal: AgentPrincipal,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
};
export const codexEchoToolName = (name: string) => name.replaceAll('.', '_');

export class CodexBackend implements Backend {
  capabilities = (profile: Profile) => ({
    events: true,
    steer: true,
    images: profile.vision,
    projectTools: true,
  });
  private activeControls = new Map<string, (input: SteerRequest) => Promise<void>>();
  async steer(input: SteerRequest) {
    const control = this.activeControls.get(input.requestId);
    invariant(control, 'run_not_active', 'Codex 当前运行已结束或尚未就绪。');
    await control(input);
  }
  kind = 'codex' as const;
  private clients = new Map<string, Promise<StdioRpc>>();
  private configurations = new Map<string, string>();
  private active = new Map<string, number>();
  private idle = new Map<string, NodeJS.Timeout>();
  private loginUntil = new Map<string, number>();
  private closing = false;
  private loaded = new WeakMap<StdioRpc, Set<string>>();
  private catalogs = new WeakMap<StdioRpc, Promise<CodexModel[]>>();
  private modelBySession = new Map<string, string>();
  private readonly echoTools?: CodexEchoTools;
  private hostHandlers = new WeakMap<
    StdioRpc,
    Map<string, (method: string, params: any, id: string | number) => Promise<unknown>>
  >();
  private models(rpc: StdioRpc) {
    let pending = this.catalogs.get(rpc);
    if (!pending) {
      pending = (async () => {
        const models: CodexModel[] = [];
        let cursor: string | undefined;
        do {
          const page = await rpc.call('model/list', {
            limit: 100,
            includeHidden: true,
            ...(cursor ? { cursor } : {}),
          });
          models.push(...(page.data ?? []));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return models;
      })();
      this.catalogs.set(rpc, pending);
      void pending.catch(() => this.catalogs.delete(rpc));
    }
    return pending;
  }
  private markLoaded(rpc: StdioRpc, sessionId: string) {
    const ids = this.loaded.get(rpc) ?? new Set<string>();
    ids.add(sessionId);
    this.loaded.set(rpc, ids);
  }
  constructor(
    readonly dataRoot: string,
    readonly store: Store,
    echoTools?: CodexEchoTools,
    readonly idleMs = 120000,
  ) {
    this.echoTools = echoTools;
  }
  private connectionKey(profile: Profile) {
    return profile.connectionId ?? profile.id;
  }
  async releaseConnection(id: string) {
    invariant(!this.active.has(id), 'backend_busy', '连接仍在使用中');
    clearTimeout(this.idle.get(id));
    this.idle.delete(id);
    this.loginUntil.delete(id);
    this.configurations.delete(id);
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (client) await (await client).close();
  }
  private async use<T>(profile: Profile, operation: () => Promise<T>): Promise<T> {
    invariant(!this.closing, 'backend_closed', 'Codex 后端已关闭');
    clearTimeout(this.idle.get(this.connectionKey(profile)));
    this.idle.delete(this.connectionKey(profile));
    this.active.set(
      this.connectionKey(profile),
      (this.active.get(this.connectionKey(profile)) ?? 0) + 1,
    );
    try {
      return await operation();
    } finally {
      const remaining = (this.active.get(this.connectionKey(profile)) ?? 1) - 1;
      if (remaining) this.active.set(this.connectionKey(profile), remaining);
      else {
        this.active.delete(this.connectionKey(profile));
        const client = this.clients.get(this.connectionKey(profile));
        if (client && !this.closing)
          this.idle.set(
            this.connectionKey(profile),
            setTimeout(
              () => {
                this.idle.delete(this.connectionKey(profile));
                if (
                  this.active.has(this.connectionKey(profile)) ||
                  this.clients.get(this.connectionKey(profile)) !== client
                )
                  return;
                this.clients.delete(this.connectionKey(profile));
                this.configurations.delete(this.connectionKey(profile));
                this.loginUntil.delete(this.connectionKey(profile));
                void client.then((rpc) => rpc.close()).catch(() => {});
              },
              Math.max(
                this.idleMs,
                (this.loginUntil.get(this.connectionKey(profile)) ?? 0) - Date.now(),
              ),
            ).unref(),
          );
      }
    }
  }
  private async client(profile: Profile) {
    const configuration = JSON.stringify([profile.command, profile.args, profile.cwd]);
    const existing = this.clients.get(this.connectionKey(profile));
    if (existing) {
      const rpc = await existing;
      if (
        this.configurations.get(this.connectionKey(profile)) === configuration &&
        rpc.child.exitCode === null &&
        rpc.child.signalCode === null
      )
        return rpc;
      await rpc.close();
      this.clients.delete(this.connectionKey(profile));
    }
    this.configurations.set(this.connectionKey(profile), configuration);
    const opening = (async () => {
      const home = join(this.dataRoot, 'harnesses', 'codex', this.connectionKey(profile));
      mkdirSync(home, { recursive: true });
      const environment = { ...process.env };
      for (const key of Object.keys(environment))
        if (key.startsWith('CODEX_') || ['OPENAI_API_KEY', 'OPENAI_BASE_URL'].includes(key))
          delete environment[key];
      const rpc: StdioRpc = new StdioRpc(
        profile.command,
        profile.args,
        profile.cwd || home,
        {
          ...environment,
          CODEX_HOME: home,
          CODEX_SQLITE_HOME: home,
        },
        async (method, params, id): Promise<unknown> => {
          const handler = this.hostHandlers.get(rpc)?.get(params?.threadId);
          if (!handler) throw Error('No active Echo turn owns this host request');
          return handler(method, params, id);
        },
      );
      this.hostHandlers.set(rpc, new Map());
      try {
        await rpc.call('initialize', {
          clientInfo: { name: 'echo', title: 'Echo', version },
          capabilities: { experimentalApi: true },
        });
        rpc.notify('initialized');
        return rpc;
      } catch (e) {
        rpc.close();
        this.clients.delete(this.connectionKey(profile));
        throw e;
      }
    })();
    this.clients.set(this.connectionKey(profile), opening);
    return opening;
  }
  async availableModels(profile: Profile) {
    return this.use(profile, async () => {
      const rows = await this.models(await this.client(profile));
      return rows
        .filter((model) => !model.hidden && model.model)
        .map((model) => {
          const reasoning = readReasoningSupport(model, 'host');
          const lowest = reasoningLevels.find((effort) => reasoning?.levels.includes(effort));
          return ({
          id: model.model,
          label: model.displayName ?? model.model,
          reasoning: reasoning ? { ...reasoning, ...(!reasoning.levels.includes('off') && lowest ? { aliases: { off: lowest } } : {}) } : undefined,
        }); });
    });
  }
  listModels(profile: Profile) { return this.availableModels(profile); }
  async availableEchoTools(
    profile: Profile,
    _managedId: string | undefined,
    principal: AgentPrincipal,
  ) {
    return this.use(profile, async () =>
      (this.echoTools?.list(principal) ?? [])
        .map((operation) => codexEchoToolName(operation.name))
        .sort(),
    );
  }
  private contextConfig(profile: Profile) {
    const tokens = profile.modelOptions.contextWindowTokens;
    return typeof tokens === 'number' ? { config: { model_context_window: tokens } } : {};
  }
  async authenticate(profile: Profile, action: 'status' | 'login' | 'cancel', loginId?: string) {
    return this.use(profile, () => this.authentication(profile, action, loginId));
  }
  private async authentication(
    profile: Profile,
    action: 'status' | 'login' | 'cancel',
    loginId?: string,
  ) {
    const rpc = await this.client(profile);
    if (action === 'status') {
      const status = await rpc.call('account/read', { refreshToken: false });
      if (status.account) this.loginUntil.delete(this.connectionKey(profile));
      return status;
    }
    if (action === 'cancel') {
      this.loginUntil.delete(this.connectionKey(profile));
      invariant(loginId, 'missing_login', '缺少登录编号');
      return await rpc.call('account/login/cancel', { loginId });
    }
    const result = await rpc.call('account/login/start', { type: 'chatgpt' });
    this.loginUntil.set(this.connectionKey(profile), Date.now() + 15 * 60000);
    return result;
  }
  async createSession(profile: Profile, history: ModelInput[], signal: AbortSignal) {
    signal.throwIfAborted();
    invariant(!this.closing, 'backend_closed', 'Codex 后端已关闭');
    const id = 'codex-' + randomUUID();
    this.store.put('codex-sessions', id, {
      profileId: profile.id,
      seed: history,
      admitted: false,
    } satisfies ManagedSession);
    return id;
  }
  private async startNativeSession(
    profile: Profile,
    history: ModelInput[],
    signal: AbortSignal,
    dynamicTools: unknown[],
  ) {
    signal.throwIfAborted();
    const rpc = await this.client(profile);
    const response = await rpc.call('thread/start', {
      ...(profile.model ? { model: profile.model } : {}),
      ...this.contextConfig(profile),
      cwd: profile.cwd || this.dataRoot,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      dynamicTools,
    });
    const sessionId = response.thread?.id;
    invariant(sessionId, 'codex_session', 'Codex 未返回会话编号。');
    const model = response.model ?? response.thread?.model;
    if (model) this.modelBySession.set(sessionId, model);
    if (history.length) {
      const items = history.map((m) => ({
        type: 'message',
        role: m.role === 'tool' ? 'developer' : m.role === 'system' ? 'developer' : m.role,
        content: [
          { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.text },
          ...(m.images ?? []).map((image) => ({
            type: 'input_image',
            image_url: `data:${image.mimeType};base64,${image.data}`,
          })),
        ],
      }));
      await rpc.call('thread/inject_items', { threadId: sessionId, items });
    }
    this.store.put('codex-context', sessionId, {
      sent: history.filter((m) => m.role === 'system' && m.id).map((m) => m.id),
      prefix: '',
    });
    this.markLoaded(rpc, sessionId);
    return sessionId as string;
  }
  async archiveSession(profile: Profile, sessionId: string) {
    await this.use(profile, async () => {
      const session = this.store.document<ManagedSession>('codex-sessions', sessionId);
      invariant(
        session && session.profileId === profile.id,
        'codex_session',
        '未找到此后端的托管会话',
      );
      if (session.nativeId && session.admitted)
        await (await this.client(profile)).call('thread/archive', { threadId: session.nativeId });
      this.store.put('codex-sessions', sessionId, { ...session, seed: [], archived: true });
    });
  }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.loginUntil.delete(this.connectionKey(request.profile));
    return this.use(request.profile, () => this.generateRequest(request));
  }
  private async generateRequest(request: GenerateRequest): Promise<GenerateResult> {
    invariant(!request.permissions?.readRoots?.length,'codex_read_roots','此 Codex 适配器暂不支持限定附加只读目录，请使用宿主沙箱设置或选择内置执行器。');
    const writable = request.permissions?.codex.sandbox === 'workspace-write';
    const configured =
      request.permissions?.projectDirectory || (writable ? request.profile.cwd : '');
    invariant(
      !writable || configured,
      'codex_workspace',
      '请先为会话选择项目目录，再启用工作区可写。',
    );
    const workspace = configured ? projectRoot(configured, this.dataRoot) : undefined;
    const rpc = await this.client(request.profile);
    const managedId =
      request.sessionId ??
      (await this.createSession(request.profile, request.messages.slice(0, -1), request.signal));
    const session = this.store.document<ManagedSession>('codex-sessions', managedId);
    invariant(
      session && session.profileId === request.profile.id && !session.archived,
      'codex_session',
      '未找到可用的托管会话',
    );
    const principal = request.principal;
    const operations = principal ? (this.echoTools?.list(principal) ?? []) : [];
    const names = new Set<string>();
    const dynamicTools = operations.map((operation) => {
      const name = codexEchoToolName(operation.name);
      invariant(!names.has(name), 'codex_tool_collision', 'Echo 工具名称冲突：' + name);
      names.add(name);
      return {
        type: 'function',
        name,
        description: operation.description,
        inputSchema: operation.toolInputSchema ?? z.toJSONSchema(operation.input),
      };
    });
    const toolsHash = createHash('sha256').update(JSON.stringify(dynamicTools)).digest('hex');
    if (session.nativeId && session.toolsHash !== toolsHash) {
      if (session.admitted)
        await rpc.call('thread/archive', { threadId: session.nativeId });
      session.nativeId = undefined;
      session.admitted = false;
      session.seed = request.messages.slice(0, -1);
      session.toolsHash = toolsHash;
      this.store.put('codex-sessions', managedId, session);
    }
    if (!session.nativeId || (!session.admitted && !this.loaded.get(rpc)?.has(session.nativeId))) {
      session.nativeId = await this.startNativeSession(
        request.profile,
        session.seed,
        request.signal,
        dynamicTools,
      );
      session.model = this.modelBySession.get(session.nativeId);
      session.toolsHash = toolsHash;
      this.store.put('codex-sessions', managedId, session);
    } else if (!this.loaded.get(rpc)?.has(session.nativeId)) {
      const resumed = await rpc.call('thread/resume', {
        threadId: session.nativeId,
        ...this.contextConfig(request.profile),
      });
      session.model = resumed.model ?? resumed.thread?.model ?? session.model;
      this.markLoaded(rpc, session.nativeId);
    }
    const sessionId = session.nativeId;
    const execution = selectCodexReasoning(
      await this.models(rpc),
      request.profile.model || session.model,
      request.reasoning,
      request.profile.reasoning,
    );
    // Per-run context is developer-authored, never a fabricated user message.
    const sync = this.store.document<{ sent: string[]; prefix: string }>(
      'codex-context',
      sessionId,
    ) ?? { sent: [], prefix: '' };
    const last = request.messages.at(-1)!;
    const turn = request.messages.filter((m) => m.context === 'turn');
    const turnText = textWithTurnContext(last, turn);
    const prefix = request.messages
      .filter((m) => m !== last && isStableContext(m))
      .map((m) => m.text)
      .join('\n');
    const prefixHash = createHash('sha256').update(prefix).digest('hex');
    const context = request.messages.filter(
      (m) => m.role === 'system' && m !== last && m.context !== 'turn' && m.id && !sync.sent.includes(m.id),
    );
    if ((prefix || sync.prefix) && prefixHash !== sync.prefix)
      context.unshift({
        role: 'system',
        text: prefix
          ? 'Echo 固定上下文的当前版本：\n' + prefix
          : 'Echo 的固定上下文已停用。此前版本不再生效。',
      });
    if (context.length) {
      await rpc.call('thread/inject_items', {
        threadId: sessionId,
        items: context.map((m) => ({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: m.text }],
        })),
      });
      sync.sent.push(...context.flatMap((m) => m.id ? [m.id] : []));
      sync.prefix = prefixHash;
      this.store.put('codex-context', sessionId, sync);
    }
    let nativeRunId: string | undefined,
      text = '';
    const hostRequests = new Map<string | number, AbortController>();
    const dynamicCalls = new Set<string>();
    const changes = new Map<string, unknown>();
    let resolve!: (r: GenerateResult) => void, reject!: (e: Error) => void;
    const done = new Promise<GenerateResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const off = rpc.subscribe((method, params) => {
      if (method === 'echo/disconnected') {
        reject(new EchoError('codex_disconnected', 'Codex 执行期间断开。', true));
        return;
      }
      if (
        params?.threadId !== sessionId ||
        (nativeRunId &&
          (params?.turnId ?? params?.turn?.id) &&
          (params.turnId ?? params.turn.id) !== nativeRunId)
      )
        return;
      if (method === 'turn/started' && !nativeRunId) nativeRunId = params.turn?.id;
      const item = codexEvent(method, params);
      if (item) request.onItem?.(item);
      if (method === 'item/agentMessage/delta') {
        text += params.delta ?? '';
        request.onDelta?.(params.delta ?? '');
      }
      if (method === 'serverRequest/resolved') hostRequests.get(params.requestId)?.abort();
      if (method === 'item/started' && params.item?.type === 'fileChange')
        changes.set(params.item.id, params.item.changes);
      if (method === 'item/completed') changes.delete(params.item?.id);
      if (method === 'item/completed' && params.item?.type === 'agentMessage')
        text = params.item.text ?? text;
      if (method === 'turn/completed') {
        const status = params.turn?.status;
        status === 'completed'
          ? resolve({ text, sessionId: managedId, nativeRunId: params.turn?.id })
          : reject(
              new EchoError(
                'codex_turn',
                `Codex 执行结果：${status ?? 'unknown'}${params.turn?.error ? '：' + codexFailure(params.turn.error) : ''}`,
                status !== 'failed',
              ),
            );
      }
    });
    const timer = setTimeout(
      () => reject(new EchoError('codex_timeout', 'Codex 尚未确认完成；请核对运行。', true)),
      request.profile.timeoutMs,
    );
    const abort = () => {
      if (nativeRunId)
        void rpc
          .call('turn/interrupt', { threadId: sessionId, turnId: nativeRunId })
          .catch(() => {});
      reject(new EchoError('cancelled', '已请求取消，需要核对后端是否已结束。', true));
    };
    request.signal.addEventListener('abort', abort, { once: true });
    const hostHandlers = this.hostHandlers.get(rpc)!;
    hostHandlers.set(sessionId, async (method, params, id) => {
      if ((nativeRunId && params.turnId !== nativeRunId) || hostRequests.has(id))
        throw Error('Stale or duplicate Codex host request');
      if (method === 'item/tool/call') {
        const toolName = String(params.tool ?? '');
        const operation = operations.find((candidate) => codexEchoToolName(candidate.name) === toolName);
        const callId = String(params.callId ?? '');
        if (
          !request.principal ||
          !this.echoTools ||
          params.threadId !== sessionId ||
          !callId ||
          dynamicCalls.has(callId) ||
          !operation
        )
          return {
            contentItems: [{ type: 'inputText', text: 'Echo denied this tool request.' }],
            success: false,
          };
        const controller = new AbortController();
        hostRequests.set(id, controller);
        dynamicCalls.add(callId);
        try {
          const output = await this.echoTools.call(
            request.principal,
            operation.name,
            params.arguments,
            AbortSignal.any([controller.signal, request.signal]),
          );
          const text = JSON.stringify(output) ?? 'null';
          if (text.length > 120000) throw new EchoError('codex_tool_output', 'Echo 工具结果过长。');
          return { contentItems: [{ type: 'inputText', text }], success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Echo tool call failed';
          return {
            contentItems: [{ type: 'inputText', text: message.slice(0, 2000) }],
            success: false,
          };
        } finally {
          hostRequests.delete(id);
        }
      }
      const controller = new AbortController();
      hostRequests.set(id, controller);
      try {
        return await answerCodex(
          request,
          method,
          params,
          changes.get(params.itemId),
          AbortSignal.any([controller.signal, request.signal]),
        );
      } finally {
        hostRequests.delete(id);
      }
    });
    try {
      invariant(last, 'empty_request', '没有请求内容。');
      const input: any[] = [
        { type: 'text', text: turnText },
        ...(last.images ?? []).map((i) => ({
          type: 'image',
          url: `data:${i.mimeType};base64,${i.data}`,
        })),
      ];
      request.signal.throwIfAborted();
      this.store.put('codex-sessions', managedId, { ...session, admitted: true });
      const response = await rpc.call('turn/start', {
        threadId: sessionId,
        cwd: workspace || request.profile.cwd || this.dataRoot,
        approvalPolicy: request.permissions?.codex.approvals === 'ask' ? 'on-request' : 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: writable
          ? {
              type: 'workspaceWrite',
              writableRoots: [workspace,...(request.permissions?.writeRoots??[]).map((path)=>projectRoot(path,this.dataRoot))],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : { type: 'readOnly', networkAccess: false },
        ...(last.role === 'system'
          ? { input: [], toolOutput: { name: 'echo_application_event', output: turnText } }
          : { input }),
        ...(request.profile.model ? { model: request.profile.model } : {}),
        ...(execution.effort ? { effort: execution.effort } : {}),
      });
      nativeRunId = response.turn?.id;
      const acknowledged = [...turn, ...(last.role === 'system' ? [last] : [])].flatMap((m) => m.id ? [m.id] : []);
      if (acknowledged.length) {
        sync.sent.push(...acknowledged);
        this.store.put('codex-context', sessionId, sync);
      }
      this.activeControls.set(request.requestId, async (input) => {
        try {
          await rpc.call('turn/steer', {
            threadId: sessionId,
            expectedTurnId: nativeRunId,
            input: [
              { type: 'text', text: input.text },
              ...(input.images ?? []).map((image) => ({
                type: 'image',
                url: `data:${image.mimeType};base64,${image.data}`,
              })),
            ],
          });
        } catch (error) {
          throw new EchoError(
            'steer_failed',
            'Codex 补充指令未确认：' + String(error),
            !(error instanceof EchoError && error.code === 'rpc_error'),
          );
        }
      });
      if (nativeRunId) request.onNativeRun?.(nativeRunId);
      const result = await done;
      this.store.put('codex-sessions', managedId, { ...session, admitted: true, seed: [] });
      return { ...result, execution };
    } finally {
      this.activeControls.delete(request.requestId);
      hostHandlers.delete(sessionId);
      for (const pending of hostRequests.values()) pending.abort();
      dynamicCalls.clear();
      clearTimeout(timer);
      off();
      request.signal.removeEventListener('abort', abort);
      void done.catch(() => {});
    }
  }
  async inspect(profile: Profile, sessionId: string, runId?: string) {
    return this.use(profile, () => this.inspectRun(profile, sessionId, runId));
  }
  private async inspectRun(profile: Profile, sessionId: string, runId?: string) {
    const session = this.store.document<ManagedSession>('codex-sessions', sessionId);
    if (!session?.nativeId || session.profileId !== profile.id)
      return { state: 'unknown' as const };
    const response = await (
      await this.client(profile)
    ).call('thread/read', { threadId: session.nativeId, includeTurns: true });
    const turn = response.thread?.turns?.find((t: any) => t.id === runId);
    if (!turn) return { state: 'unknown' as const };
    return {
      state:
        turn.status === 'completed'
          ? ('succeeded' as const)
          : turn.status === 'inProgress'
            ? ('running' as const)
            : ('failed' as const),
      text: turn.items
        ?.filter((i: any) => i.type === 'agentMessage')
        .map((i: any) => i.text)
        .join('\n'),
      error: codexFailure(turn.error),
    };
  }
  async close() {
    this.closing = true;
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
    this.loginUntil.clear();
    for (const client of this.clients.values()) {
      try {
        await (await client).close();
      } catch {}
    }
    this.clients.clear();
    this.modelBySession.clear();
  }
}
