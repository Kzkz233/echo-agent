import { Deliveries } from '../../packages/kernel/delivery.ts';
import { characterActive, characterEnabled } from '../../packages/kernel/characters.ts';
import { registerStarterCharacters } from './starter-characters.ts';
import {
  clockComponent,
  storageComponent,
  modelServicesComponent,
} from '../../packages/kernel/core-components.ts';
import { configuredTimezone } from '../../packages/kernel/time.ts';
import { roleAvatar } from '../../plugins/avatar/profiles.ts';
import { MailTriggers } from '../../plugins/mail-triggers/index.ts';
import { chatStickPlugin } from '../../plugins/chatstick/index.ts';
import { defineCharacterFeatures, managedConversation } from '../../packages/kernel/characters.ts';
import { Delegations } from '../../plugins/delegation/index.ts';
import { Groups } from '../../plugins/groups/index.ts';
import { avatarPlugin } from '../../plugins/avatar/index.ts';
import { Channels } from '../../plugins/channels/index.ts';
import { defineReplyImages } from '../../packages/kernel/reply-images.ts';
import { QQ } from '../../plugins/qq/index.ts';
import { version } from '../../packages/contracts/version.ts';
import { Updates } from '../../packages/kernel/updates.ts';
import { attachmentInput } from '../../packages/contracts/execution.ts';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { conversationPermissions, hostAnswerSchema } from '../../packages/contracts/interaction.ts';
import { echoToolPermissions, migrateRoleToolGrants, type HarnessMcp } from '../../packages/kernel/tool-access.ts';
import { projectRoot } from '../../packages/backends/project-root.ts';
import {
  id,
  conversationSchema,
  profileSchema,
  preferencesSchema,
  reasoning,
  invariant,
  type Conversation,
  type Backend,
} from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Events } from '../../packages/kernel/events.ts';
import { Registry, PluginManager, internal } from '../../packages/kernel/registry.ts';
import { Extensions } from '../../packages/kernel/extensions.ts';
import { ExternalMcp } from '../../packages/kernel/external-mcp.ts';
import { FrontendCatalog } from '../../packages/kernel/frontend.ts';
import { Router } from '../../packages/kernel/router.ts';
import { Secrets } from '../../packages/kernel/secrets.ts';
import { MaterialSources } from '../../packages/kernel/materials.ts';
import { configureNetwork } from '../../packages/kernel/network.ts';
import { Retrieval } from '../../packages/kernel/retrieval.ts';
import { Automation, defineAutomation } from '../../packages/kernel/automation.ts';
import { TriggerActions, triggerAction } from '../../packages/kernel/trigger-actions.ts';
import { Capabilities } from '../../packages/kernel/capabilities.ts';
import { Clock } from '../../packages/kernel/clock.ts';
import { Files } from '../../plugins/files/index.ts';
import { Agenda } from '../../plugins/agenda/index.ts';
import { Scheduler } from '../../plugins/scheduler/index.ts';
import { Assets } from '../../plugins/assets/index.ts';
import { Care } from '../../plugins/care/index.ts';
import { Reflections } from '../../plugins/reflections/index.ts';
import { Documents } from '../../plugins/documents/index.ts';
import { SpeechRecognition } from '../../plugins/asr/index.ts';
import { Mailbox } from '../../plugins/mail/index.ts';
import { Backups } from '../../plugins/backup/index.ts';
import { Notifications } from '../../plugins/notifications/index.ts';
import { Approvals } from '../../plugins/approvals/index.ts';
import { MailActions } from '../../plugins/mail-actions/index.ts';
import { SemanticSearch } from '../../plugins/semantic/index.ts';
import { ApiBackend } from '../../packages/backends/api.ts';
import { CodexBackend } from '../../packages/backends/codex.ts';
import { DshBackend } from '../../packages/backends/dsh.ts';
import { workerPlugin } from '../../packages/backends/worker-plugin.ts';
import codexWorkerManifest from '../../plugins/worker-codex/echo-plugin.json' with { type: 'json' };
import dshWorkerManifest from '../../plugins/worker-dsh/echo-plugin.json' with { type: 'json' };
import { Knowledge } from '../../plugins/knowledge/index.ts';
import { Personas } from '../../plugins/persona/index.ts';
import { Memories } from '../../plugins/memory/index.ts';
import { Observations } from '../../plugins/observation/index.ts';
import { Reviews } from '../../plugins/review/index.ts';
import {
  modelProfileSchema,
  connectionSchema,
  inferenceTasks,
} from '../../packages/contracts/inference.ts';
import { installCoreInference } from '../../packages/backends/catalog.ts';
import { Embeddings } from '../../plugins/embeddings/index.ts';
import { LocalModelPool } from '../../packages/kernel/local-model-pool.ts';
import { LocalModels, localRuntimeConfig } from '../../plugins/local-models/index.ts';
import { effectiveReasoning } from '../../packages/backends/model-metadata.ts';
import { reasoningStyle } from '../../packages/contracts/reasoning.ts';

export class Application {
  readonly store: Store;
  readonly events = new Events();
  readonly registry = new Registry();
  readonly capabilities = new Capabilities();
  readonly clock = new Clock();
  readonly plugins = new PluginManager(this.registry, this.capabilities);
  readonly router: Router;
  readonly secrets: Secrets;
  readonly api: ApiBackend;
  readonly knowledge: Knowledge;
  readonly personas: Personas;
  readonly memories: Memories;
  readonly observations: Observations;
  readonly reviews: Reviews;
  readonly extensions: Extensions;
  readonly externalMcp: ExternalMcp;
  readonly frontend: FrontendCatalog;
  readonly materials = new MaterialSources(this.capabilities);
  readonly retrieval = new Retrieval(
    this.capabilities,
    () => this.store.get<any>('knowledge.config', {}).retrievalProvider,
  );
  readonly semantic: SemanticSearch;
  readonly embeddings: Embeddings;
  readonly localModels: LocalModels;
  readonly localResources: LocalModelPool;
  readonly files: Files;
  readonly agenda: Agenda;
  readonly scheduler: Scheduler;
  readonly automation: Automation;
  readonly triggerActions: TriggerActions;
  readonly deliveries: Deliveries;
  readonly assets: Assets;
  readonly care: Care;
  readonly mail: Mailbox;
  readonly mailTriggers: MailTriggers;
  readonly backups: Backups;
  readonly notifications: Notifications;
  readonly approvals: Approvals;
  readonly channels: Channels;
  readonly qq: QQ;
  readonly updates: Updates;
  private closing = false;
  private harnessMcp?: (principal: { conversationId: string; personaId: string }) => HarnessMcp;
  private constructor(
    readonly runtime: string,
    readonly project: string,
    nativePath: string,
  ) {
    this.store = new Store(join(runtime, 'echo.sqlite'));
    this.updates = new Updates(project, runtime);
    this.router = new Router(this.store, this.events, this.capabilities);
    this.updates.register(this.registry, () => {
      invariant(!this.clock.active && !this.store.documents<any>('channel-outbound').some(row => row.state === 'sending'),
        'update_busy', '后台任务或消息投递仍在执行，请完成后再更新。');
      this.registry.beginUpdate();
      this.router.pauseForUpdate();
      this.clock.pause();
    }, () => {
      this.registry.resumeAfterUpdateFailure();
      this.router.resumeAfterUpdateFailure();
      this.clock.resume();
    });
    this.secrets = new Secrets(join(runtime, 'credentials'));
    this.api = new ApiBackend((ref) => this.secrets.get(ref));
    this.router.backends.set('api', this.api);
    let pi: Promise<import('../../packages/backends/pi.ts').PiBackend> | undefined;
    const getPi = () =>
      (pi ??= import('../../packages/backends/pi.ts').then(
        ({ PiBackend }) =>
          new PiBackend(
            this.registry,
            (ref) => this.secrets.get(ref),
            (principal) =>
              principal
                ? echoToolPermissions(
                    this.store,
                    false,
                    principal,
                    this.plugins.characterPermissions(),
                  )
                : new Set<string>(),
            this.runtime,
          ),
      ));
    const piRuntime = {
      kind: 'pi',
      listModels: (profile) => this.api.listModels(profile),
      capabilities: (profile) => ({
        contextManagement: 'echo',
        outputLimit: true,
        events: true,
        steer: true,
        images: profile.vision,
        projectTools: true,
      }),
      steer: async (request) => {
        invariant(pi, 'run_not_active', 'Pi 当前没有运行。');
        return (await pi).steer(request);
      },
      toolCatalog: async (request) => (await getPi()).toolCatalog(request),
      generate: async (request) => {
        return (await getPi()).generate(request);
      },
    } satisfies Backend;
    this.router.backends.set('pi', piRuntime);
    this.router.useConversationRuntime(this.api, piRuntime);
    const codexWorker = workerPlugin(
      codexWorkerManifest,
      this.router,
      () =>
        new CodexBackend(runtime, this.store, {
          list: (principal) => {
            const caller = {
              kind: 'mcp' as const,
              permissions: echoToolPermissions(
                this.store,
                false,
                principal,
                this.plugins.characterPermissions(),
              ),
              ...principal,
            };
            return this.registry.list(caller, true);
          },
          call: (principal, name, input, signal) => {
            const caller = {
              kind: 'mcp' as const,
              permissions: echoToolPermissions(
                this.store,
                false,
                principal,
                this.plugins.characterPermissions(),
              ),
              ...principal,
            };
            return this.registry.call(name, input, caller, signal);
          },
        }),
    );
    const dshWorker = workerPlugin(dshWorkerManifest, this.router, () => {
      const backend = new DshBackend(runtime, this.store, (ref) => this.secrets.get(ref));
      backend.setEchoMcp(this.harnessMcp);
      return backend;
    });
    installCoreInference(this.router.inference, this.router.backends, this.api);
    this.embeddings = new Embeddings(this.router);
    this.localResources = new LocalModelPool(()=>localRuntimeConfig.parse(this.store.get('models.config',this.store.get('local-models.config',{}))));
    this.localModels = new LocalModels(this.store, project, this.events,this.localResources);
    const core = this.capabilities.forOwner(
      { id: 'core', permissions: new Set(['*']), signal: new AbortController().signal },
      () => {},
    );
    this.automation = new Automation(core);
    this.deliveries = new Deliveries(this.store, this.router, this.events, core);
    this.triggerActions = new TriggerActions(core, this.router, this.automation, this.deliveries);
    this.retrieval.define(core);
    defineAutomation(core);
    defineCharacterFeatures(core);
    defineReplyImages(core);
    this.files = new Files(this.store, join(runtime, 'Vault'), this.events);
    this.knowledge = new Knowledge(this.store, this.retrieval, this.files, project, this.events);
    this.agenda = new Agenda(this.store, this.events, this.materials, this.clock);
    this.scheduler = new Scheduler(this.store, this.events, this.clock);
    this.assets = new Assets(this.store, this.files, this.events);
    this.care = new Care(this.store, this.router, this.events, this.clock, this.triggerActions);
    this.mail = new Mailbox(this.store, this.secrets, this.materials, this.events);
    this.backups = new Backups(this.store, project);
    this.notifications = new Notifications(this.store, this.events, this.router);
    this.approvals = new Approvals(this.store, this.events);
    this.channels = new Channels(this.store, this.router, this.events, this.triggerActions, this.deliveries);
    this.qq = new QQ(this.store, this.secrets, this.events);
    this.personas = new Personas(this.store, this.router, this.files);
    this.memories = new Memories(this.store, this.router, this.files, this.retrieval);
    this.semantic = new SemanticSearch(
      this.store,
      this.router,
      this.embeddings,
      project,
      this.retrieval,
      (filter) => this.knowledge.records(filter),
      this.events,
    );
    this.observations = new Observations(
      this.store,
      this.router,
      this.events,
      this.files,
      runtime,
      nativePath,
      this.materials,
      this.triggerActions,
    );
    this.reviews = new Reviews(
      this.store,
      this.router,
      this.events,
      this.files,
      this.materials,
      this.memories,
      this.clock,
      this.deliveries,
    );
    this.mailTriggers = new MailTriggers(
      this.store,
      this.router,
      this.events,
      this.clock,
      this.triggerActions,
    );
    this.extensions = new Extensions(this.store, this.plugins, {
      store: this.store, events: this.events,
    });
    this.externalMcp = new ExternalMcp(this.store, this.secrets, this.registry,
      (caller, permission) => Boolean(caller.conversationId && caller.personaId && echoToolPermissions(
        this.store, false, { conversationId: caller.conversationId, personaId: caller.personaId },
        this.plugins.characterPermissions(),
      ).has(permission)), () => this.events.emit('externalMcp.changed', {}));
    this.externalMcp.install();
    this.frontend = new FrontendCatalog(
      this.capabilities,
      this.router.inference.owner,
      this.plugins,
      this.extensions,
      () => this.events.emit('frontend.changed', {}),
    );
    for (const plugin of [
      codexWorker,
      dshWorker,
      new Groups(this.store, this.router, this.events).plugin(),
      chatStickPlugin(this.store, this.files, this.router),
      this.care.plugin(),
      new Reflections(this.store, this.router, this.events).plugin(),
      this.mail.plugin(),
      this.mailTriggers.plugin(),
      this.backups.plugin(),
      this.approvals.plugin(),
      this.qq.plugin(),
      new MailActions(this.store, this.mail, this.approvals).plugin(),
      this.agenda.plugin(),
      this.memories.plugin(),
      this.semantic.plugin(),
      new SpeechRecognition(project, this.store, this.files, this.router.inference, this.events,undefined,this.localResources).plugin(),
      this.observations.plugin(),
      this.reviews.plugin(),
    ])
      this.plugins.add(plugin);
    for (const module of [
      { ...this.files.plugin(), component: 'knowledge', internalComponent: true },
      {
        ...new Documents(project, this.store, this.secrets,this.files).plugin(),
        component: 'knowledge',
        internalComponent: true,
      },
      { ...this.assets.plugin(), component: 'storage', internalComponent: true },
      { ...this.embeddings.plugin(), component: 'models', internalComponent: true },
      { ...this.localModels.plugin(), component: 'models', internalComponent: true },
      this.knowledge.plugin(),
      new Delegations(this.store, this.router, this.events, this.clock, this.deliveries).plugin(),
      modelServicesComponent(this.store, localRuntimeConfig),
      clockComponent(this.store, this.clock),
      storageComponent(this.store, this.plugins),
      this.personas.plugin(),
      { ...this.scheduler.plugin(), component: 'delegation', internalComponent: true },
      { ...this.channels.plugin(), component: 'persona', internalComponent: true },
      { ...this.notifications.plugin(), component: 'delegation', internalComponent: true },
    ])
      this.plugins.addBuiltin(module);
    this.plugins.add(
      avatarPlugin(this.store, this.router, this.events, project, nativePath, this.clock),
    );
    this.coreOperations();
    registerStarterCharacters(this);
  }
  static async create(options: {
    runtime: string;
    project: string;
    nativePath?: string;
    plugins?: string[];
  }) {
    configureNetwork();
    await mkdir(options.runtime, { recursive: true });
    invariant(
      !existsSync(join(options.runtime, 'restore-incomplete.json')),
      'restore_incomplete',
      '此目录的恢复尚未完成，请使用完整恢复的数据目录。',
    );
    const app = new Application(
      options.runtime,
      options.project,
      options.nativePath ??
        join(
          options.project,
          'native',
          'target',
          'release',
          process.platform === 'win32' ? 'echo-native.exe' : 'echo-native',
        ),
    );
    try {
      await app.extensions.load();
      const defaults = [
        'knowledge',
        'persona',
        'memory',
        'observation',
        'review',
        'avatar',
        'groups',
        'delegation',
        'worker-codex',
        'worker-dsh',
      ];
      const intent = options.plugins
        ? Object.fromEntries(options.plugins.map((id) => [id, true]))
        : app.store.get<Record<string, boolean>>(
            'plugins.intent',
            Object.fromEntries(defaults.map((id) => [id, true])),
          );
      // Preserve configured host connections, including explicitly disabled workers.
      if (!options.plugins)
        app.store.transaction(() => {
          for (const connection of app.router.inference.connections()) {
            const kind = (
              {
                'core.codex': 'codex',
                'core.dsh': 'dsh',
                'worker-codex.provider': 'codex',
                'worker-dsh.provider': 'dsh',
              } as Record<string, string>
            )[connection.adapterId];
            if (!kind) continue;
            if (connection.adapterId.startsWith('core.'))
              app.store.put('connections', connection.id, {
                ...connection,
                adapterId: `worker-${kind}.provider`,
              });
            intent[`worker-${kind}`] ??= true;
          }
          app.store.set('plugins.intent', intent);
        });
      if (!options.plugins && !app.store.get('core.builtins.adopted', false)) {
        app.store.transaction(() => {
          // A previously disabled scheduler or channel must not resume its old work merely
          // because the management module is now always present.
          if (intent.scheduler === false)
            for (const job of app.scheduler.jobs())
              if (job.enabled) app.store.put('scheduler-jobs', job.id, { ...job, enabled: false });
          if (intent.channels === false)
            for (const binding of app.channels.bindings())
              if (binding.enabled)
                app.store.put('channel-bindings', binding.id, { ...binding, enabled: false });
          app.store.set('core.builtins.adopted', true);
        });
      }
      if (!options.plugins && !app.store.get('semantic.optionalEmbedding.v1', false)) {
        if (intent.semantic && intent.embeddings === undefined) intent.embeddings = true;
        app.store.set('plugins.intent', intent);
        app.store.set('semantic.optionalEmbedding.v1', true);
      }
      if (!options.plugins && !app.store.get('core.taskSystem.adopted.v1', false)) {
        app.store.transaction(() => {
          if (intent.delegation === false)
            for (const role of app.store.documents<{ id: string }>('personas')) {
              const old = app.store.document<any>('character-settings.delegation', role.id) ?? {};
              app.store.put('character-settings.delegation', role.id, {
                ...old,
                autonomous: false,
                reportOnCompletion: false,
              });
            }
          app.store.set('core.taskSystem.adopted.v1', true);
        });
      }
      await app.plugins.restore(intent);
      if (!options.plugins) migrateRoleToolGrants(app.store, app.plugins.characterPermissions());
      if (!options.plugins && !app.store.get('outputs.taskMigration.v1',false)) {
        const catalog=await app.automation.catalog(new AbortController().signal);
        for(const type of catalog.types) {
          const field=type.fields.find(field=>field.kind==='outputs');
          if(!field)continue;
          for(const item of type.items) {
            const settings=item.persistedSettings??item.settings;
            if(!settings||settings.outputTargets!==undefined)continue;
            const conversationId=String(settings.conversationId||settings.reportConversationId||'');
            if(!app.store.conversation(conversationId))continue;
            const plan=await app.deliveries.plan(conversationId,(field.outputSourceField?field.outputSources?.[String(settings[field.outputSourceField])]:undefined)??field.outputSource??'notification',undefined,{bubble:field.legacyBubble??Boolean(settings.bubble)});
            await app.automation.mutate(type.id,{action:'save',id:item.id,settings:{...settings,outputTargets:plan.targets.map(t=>t.id)}},new AbortController().signal);
          }
        }
        app.store.set('outputs.taskMigration.v1',true);
      }
      await app.router.inference.refresh();
      app.router.resumeSubmissions();
      return app;
    } catch (error) {
      await app.close().catch(() => {});
      throw error;
    }
  }
  private coreOperations() {
    const outputs: Record<string, z.ZodType> = {
      'connections.save': connectionSchema,
      'connections.delete': z.object({ deleted: z.boolean() }),
      'connections.authenticate': z.record(z.string(), z.unknown()),
      'profiles.save': modelProfileSchema,
      'profiles.delete': z.object({ deleted: z.boolean() }),
      'routes.save': z.record(id, id),
    };
    const op = (
      name: string,
      description: string,
      input: z.ZodType,
      permission: string,
      run: (v: any, c: any, s: AbortSignal) => any,
      mcp = false,
    ) =>
      this.registry.register({
        name,
        description,
        input,
        output: outputs[name] ?? z.unknown(),
        permission,
        owner: 'core',
        mcp,
        run,
      });
    op(
      'system.status',
      '读取 Echo 内核状态',
      z.object({}),
      'system.read',
      () => ({
        version,
        uptime: process.uptime(),
        resources: process.memoryUsage(),
        cpu: process.cpuUsage(),
        plugins: this.plugins.list(),
        extensionPoints: this.capabilities.points(),
        providers: this.capabilities.list(),
        listeners: this.events.listeners,
        scheduledAlarms: this.clock.pending,
        observation: this.observations.status(),
        memoryIssue: this.store.get('semantic.lastIssue', null),
        activeRuns: this.store.unresolved().filter((r) => r.state === 'running').length,
      }),
      true,
    );
    op(
      'automation.catalog',
      '读取已注册的自动化任务类型和任务',
      z.object({}),
      'automation.read',
      async (_v, _c, signal) => {
        const catalog = await this.automation.catalog(signal);
        return { ...catalog, types: catalog.types.map(type => ({...type, items: type.items.map(item => {
          const personaId = item.personaId || item.settings?.personaId as string | undefined || this.store.conversation(String(item.settings?.conversationId ?? ''))?.personaId;
          return personaId && !characterActive(this.store, personaId) ? {...item, state: 'paused', nextAt: undefined, suspendedByCharacter: true} : item;
        })})), sources: this.triggerActions.sources() };
      },
    );
    op('work.list', '读取角色的全部工作会话', z.object({ personaId: id.optional() }), 'delegation.read',
      (value, caller) => {
        invariant(!caller.personaId || !value.personaId || caller.personaId === value.personaId, 'work_owner', '只能读取当前角色的工作会话。');
        return this.router.workSessions.list(caller.personaId ?? value.personaId);
      });
    op('work.contextOptions', '读取插件注册的子任务上下文选项', z.object({ personaId: id, features: z.array(id).optional() }), 'delegation.read',
      async (value, _caller, signal) => {
        const role = this.store.document<{ mainConversationId: string }>('characters', value.personaId);
        const conversation = role && this.store.conversation(role.mainConversationId);
        const toolLabels: Record<string, string> = {};
        const plugins = this.plugins.list();
        for (const operation of this.registry.list(internal, true))
          toolLabels[operation.permission] ??= plugins.find(plugin => plugin.id === operation.owner)?.name ?? operation.owner;
        return { options: await this.router.workerContextOptions(value.personaId, signal, value.features), toolLabels,
          compaction: this.store.document<{ compaction?: unknown }>('character-settings.delegation', value.personaId)?.compaction ??
            conversation?.compaction ?? { triggerTokens: 256000, keepRecentPercent: 8 },
          selected: this.store.document<{ contextBlocks?: string[] }>('character-settings.delegation', value.personaId)?.contextBlocks };
      });
    op('work.cancel', '停止本次工作执行', z.object({ id }), 'delegation.write', value => {
      const work = this.store.document<{ conversationId: string }>('work-sessions', value.id);
      invariant(work, 'work_missing', '工作会话不存在。');
      this.router.workSessions.cancel(value.id);
      return { accepted: true };
    });
    op('automation.manage', '在当前角色下查看、创建、编辑、启停或执行已注册的自动化任务',
      z.object({ action: z.enum(['list', 'save', 'pause', 'resume', 'run', 'remove']), type: id.optional(),
        id: id.optional(), settings: z.record(z.string(), z.unknown()).optional(), requestId: id.optional() }),
      'delegation.write', async (value, caller, signal) => {
        const role = caller.personaId && this.store.document<{ mainConversationId: string }>('characters', caller.personaId);
        invariant(role && role.mainConversationId === caller.conversationId, 'task_owner', '请从角色主工作会话管理自动化任务。');
        const catalog = await this.automation.catalog(signal);
        const types = catalog.types.filter(type => type.scope === 'character' && characterEnabled(this.store, caller.personaId, type.owner));
        const belongs = (item: any) => (item.personaId ?? item.settings?.personaId) === caller.personaId;
        if (value.action === 'list') return { types: types.map(type => ({ ...type, items: type.items.filter(belongs) })) };
        invariant(this.store.document<{ autonomous?: boolean }>('character-settings.delegation', caller.personaId)?.autonomous !== false,
          'delegation_policy', '角色未获准自主创建或执行子任务。');
        const type = types.find(type => type.id === value.type);
        invariant(type && characterActive(this.store, caller.personaId), 'task_type', '此角色的任务类型当前不可用。');
        invariant(caller.permissions.has('*') || caller.permissions.has(type.owner + '.write'), 'permission_denied', '没有管理此类任务的权限。');
        const item = type.items.find(item => item.id === value.id);
        invariant(!item || belongs(item), 'task_owner', '不能管理其他角色的任务。');
        const taskId = value.id ?? randomUUID();
        if (value.action === 'save' || value.action === 'pause' || value.action === 'resume') {
          invariant(value.action === 'save' || item, 'task_missing', '任务不存在。');
          const settings = value.action === 'save' ? { ...value.settings, personaId: caller.personaId } :
            { ...(item?.persistedSettings ?? item?.settings), enabled: value.action === 'resume' };
          invariant(!value.settings?.personaId || value.settings.personaId === caller.personaId, 'task_owner', '不能为其他角色创建任务。');
          return this.automation.mutate(type.id, { action: 'save', id: taskId, settings,
            actor: { personaId: caller.personaId, conversationId: caller.conversationId, permissions: [...caller.permissions] } }, signal);
        }
        invariant(item, 'task_missing', '任务不存在。');
        return this.automation.mutate(type.id, value.action === 'remove' ? { action: 'remove', id: item.id } :
          { action: 'run', id: item.id, requestId: value.requestId ?? randomUUID() }, signal);
      }, true);
    op(
      'automation.dispatch',
      '已启用的来源插件提交自动化动作',
      triggerAction,
      'automation.dispatch',
      (v, caller, signal) => {
        invariant(caller.pluginId, 'trigger_source', '仅登记来源的插件可提交自动化动作。');
        return this.triggerActions.dispatch(v, caller.pluginId, signal);
      },
    );
    op(
      'conversations.setReference',
      '插件登记或移除对会话的持久引用',
      z.object({
        id,
        reference: z
          .object({
            conversationId: id,
            label: z.string().trim().min(1).max(160),
            role: z.enum(['channel', 'trigger', 'material', 'report']),
          })
          .nullable(),
      }),
      'conversation.reference',
      ({ id, reference }, caller) => {
        invariant(caller.pluginId, 'reference_owner', '只有插件可登记自己的引用。');
        const namespace = 'conversation-references.' + caller.pluginId;
        if (reference) {
          invariant(
            this.store.conversation(reference.conversationId),
            'missing_conversation',
            '引用的会话不存在。',
          );
          invariant(
            !this.router.isDeleting(reference.conversationId),
            'conversation_busy',
            '会话正在删除。',
          );
          this.store.put(namespace, id, reference);
        } else this.store.remove(namespace, id);
        this.events.emit('conversation.references.changed', {});
        return { saved: true };
      },
    );
    op(
      'automation.save',
      '保存一个自动化任务',
      z.object({ type: id, id, settings: z.record(z.string(), z.unknown()) }),
      'automation.write',
      (v, _c, signal) =>
        this.automation.mutate(v.type, { action: 'save', id: v.id, settings: v.settings }, signal),
    );
    op(
      'automation.remove',
      '移除一个自动化任务',
      z.object({ type: id, id }),
      'automation.write',
      (v, _c, signal) => this.automation.mutate(v.type, { action: 'remove', id: v.id }, signal),
    );
    op(
      'automation.run',
      '手动执行一次自动化任务',
      z.object({ type: id, id, requestId: id }),
      'automation.write',
      async (v, _c, signal) => {
        const catalog = await this.automation.catalog(signal);
        const item = catalog.types.find(type => type.id === v.type)?.items.find(item => item.id === v.id);
        const personaId = item?.personaId || item?.settings?.personaId as string | undefined || this.store.conversation(String(item?.settings?.conversationId ?? ''))?.personaId;
        const scopedSignal = personaId ? AbortSignal.any([signal, this.router.characterSignal(personaId)]) : signal;
        scopedSignal.throwIfAborted();
        return this.automation.mutate(v.type, { action: 'run', id: v.id, requestId: v.requestId }, scopedSignal);
      },
    );
    op('outputs.targets', '读取会话可选的输出位置', z.object({ conversationId: id.optional(), personaId: id.optional(), source:z.string().optional(), bubble:z.boolean().optional() }), 'conversation.read', async(v,_c,signal)=>{ const targets=await this.deliveries.catalog(v.conversationId??'draft-'+v.personaId,signal,v.personaId); return {targets,defaults:targets.filter(t=>t.id==='core.chat'||(v.bubble&&t.id==='avatar.bubble')||t.legacySources.includes(v.source)||t.legacySources.includes('*')).map(t=>t.id)}; });
    op('outputs.list', '读取任务结果与各渠道投递回执', z.object({ personaId:id.optional(), taskType:id.optional(), taskId:id.optional() }), 'automation.read', async v=>{
      await this.deliveries.refreshQueued('avatar');
      return this.deliveries.recent(v).map(output=>({...output,deliveries:this.deliveries.rows(output.id)}));
    });
    op('outputs.inspect', '核对投递结果，不重新发送', z.object({}), 'automation.read', ()=>this.deliveries.refreshQueued());
    op('outputs.resolve', '人工核对后结束跟进，不重发消息', z.object({id,confirmed:z.literal(true)}), 'automation.write', v=>this.deliveries.resolve(v.id));
    op('outputs.retry', '重试一次已确认失败的投递', z.object({id,confirmed:z.literal(true)}), 'automation.write', (v,_c,signal)=>this.deliveries.retry(v.id,signal));
    op('characters.setActive', '启用或停用角色', z.object({ personaId: id, enabled: z.boolean(), revision: z.number().int().min(0) }), 'persona.write', (v) => {
      invariant(this.store.document('personas', v.personaId), 'persona_missing', '角色不存在。');
      const previous = this.store.get('character.activity.' + v.personaId, { enabled: true, revision: 0 });
      invariant(previous.revision === v.revision, 'revision_conflict', '角色状态已在其他窗口修改。');
      if (previous.enabled === v.enabled) return previous;
      const activity = { enabled: v.enabled, revision: previous.revision + 1, changedAt: new Date().toISOString() };
      this.store.set('character.activity.' + v.personaId, activity);
      if (!v.enabled) this.router.suspendCharacter(v.personaId);
      this.events.emit('character.activity.changed', { personaId: v.personaId, ...activity });
      this.events.emit('characters.updated', { personaId: v.personaId });
      this.events.emit('automation.changed', {});
      return activity;
    });
    op('system.bootstrap', '读取工作台配置', z.object({}), 'system.read', async () => {
      await this.router.inference.refresh();
      return {
        version,
        clock: { timezone: configuredTimezone(this.store) },
        frontend: { pages: await this.frontend.pages() },
        extensionPackages: this.extensions.packageStatus(),
        externalMcpServers: this.externalMcp.list(),
        preferences: this.store.get('preferences', { language: 'zh-CN', accent: '#5969c9' }),
        profiles: this.router.profiles(),
        connections: this.router.inference.connections(),
        inference: {
          defaults: this.inferenceDefaults(),
          adapters: this.router.inference.adapters(),
          tasks: await this.router.inference.tasks(),
          kinds: await this.router.inference.kinds(),
          models: this.router.inference.models(),
        },
        routes: this.store.get('routes', {}),
        conversations: this.store.conversations().map((c) => {
          const last = this.store.historyPage(c.id, 1)[0];
          return {
            ...c,
            binding: this.store.binding(c.id),
            lastActiveAt: last?.createdAt ?? c.createdAt,
            lastMessage: last
              ? { text: last.text.slice(0, 140), role: last.role, source: last.source }
              : undefined,
          };
        }),
        plugins: this.plugins.list(),
        extensionPoints: this.capabilities.points(),
        providers: this.capabilities.list(),
        pluginSettings: Object.fromEntries(
          this.plugins
            .list()
            .map((p) => {
              const saved=this.store.get<Record<string,unknown>>(p.id+'.config',{});
              const schema=this.plugins.plugins.get(p.id)?.config?.schema;
              const effective=schema?.safeParse(saved),defaults=schema?.safeParse({});
              // Project effective defaults without rewriting persisted settings.
              return [p.id,effective?.success?effective.data:{...(defaults?.success?defaults.data as object:{}),...saved}];
            }),
        ),
        personas: this.store.documents('personas'),
        characters: this.store.documents('characters'),
        characterActivities: Object.fromEntries(this.store.documents<any>('personas').map(p => [p.id, this.store.get('character.activity.' + p.id, { enabled: true, revision: 0 })])),
        groups: this.store.documents('groups'),
        delegatedTasks: this.store
          .documents<any>('delegated-tasks')
          .slice(-50)
          .map(({ context, result, checkpoint, ...task }) => task),
        pendingInteractions: this.store
          .conversations()
          .flatMap((c) => this.router.interactions.list(c.id)),
        memoryConfig: this.memories.config(),
        ragConfig: this.semantic.config(),
        observationTasks: this.observations.configurations(),
        avatarProfiles: Object.fromEntries(
          this.store
            .documents<{ id: string }>('personas')
            .map(({ id }) => [id, roleAvatar(this.store, id)]),
        ),
        avatarConfig: this.store.get('avatar.config', {
          enabled: false,
          scale: 1,
          bubbleSeconds: 25,
        }),
        vaults: this.knowledge.vaults(),
        workSessions: this.router.workSessions.list(),
        mailAccounts: this.store.documents<{ id: string; name: string }>('mail-accounts')
          .map(({ id, name }) => ({ id, name })),
        mcpPermissions: this.store.get('mcp.permissions', [
          'system.read',
          'memory.read',
          'knowledge.read',
          'persona.read',
          'observation.read',
          'review.read',
        ]),
        mcpAvailablePermissions: [
          ...new Set(this.registry.list(internal, true).filter((op) => !op.roleOnly).map((o) => o.permission)),
        ],
        mcpPermissionCatalog: (() => {
          const entries = new Map<string, { owners: Set<string>; tools: string[] }>();
          for (const operation of this.registry.list(internal, true)) {
            const entry = entries.get(operation.permission) ?? {
              owners: new Set<string>(),
              tools: [],
            };
            entry.owners.add(operation.owner);
            entry.tools.push(operation.name);
            entries.set(operation.permission, entry);
          }
          const externalTools = new Map(this.externalMcp.list().flatMap((server) => server.tools.map((tool) => [tool.permission, {
            external: { server: server.name, tool: tool.title, available: entries.has(tool.permission) },
          }] as const)));
          return [...[...entries].map(([permission, entry]) => ({
            permission,
            scope: this.plugins.characterPermissions().has(permission)
              ? 'character'
              : 'application',
            owners: [...entry.owners],
            tools: entry.tools,
            ...externalTools.get(permission),
          })), ...this.externalMcp.pendingPermissions().map((tool) => ({
            permission: tool.permission, scope: 'character', owners: ['external-mcp'], tools: [tool.name],
            ...externalTools.get(tool.permission),
          }))];
        })(),
      };
    });
    op('preferences.save', '保存外观与语言', preferencesSchema, 'system.write', (v) => {
      this.store.set('preferences', v);
      this.events.emit('preferences.changed', {});
      return v;
    });
    op('connections.save', '保存推理连接', connectionSchema, 'system.write', async (v) => {
      const saved = await this.router.inference.saveConnection(v);
      this.events.emit('connections.changed', {});
      return saved;
    });
    op('connections.delete', '删除未使用的连接', z.object({ id }), 'system.write', async (v) => {
      invariant(
        !this.router.inference.models().some((m) => m.connectionId === v.id),
        'connection_in_use',
        '此连接仍有模型配置',
      );
      const c = this.router.inference.connections().find((c) => c.id === v.id);
      if (c) {
        const a = this.router.inference.adapter(c.adapterId);
        await this.router.backends.get(a.engine)?.releaseConnection?.(c.id);
      }
      this.store.remove('connections', v.id);
      this.events.emit('connections.changed', {});
      return { deleted: true };
    });
    op(
      'connections.models',
      '读取连接提供的可选模型',
      z.object({ id, model: z.string().max(300).default(''), refresh: z.boolean().default(false) }),
      'system.read',
      async (v) => {
        return this.router.inference.discover(
          this.router.inference.connectionProfile(v.id, v.model),
          v.refresh,
        );
      },
    );
    op(
      'profiles.reasoning',
      '读取模型支持的思考选项',
      z.object({
        profileId: id.optional(),
        connectionId: id.optional(),
        model: z.string().max(300).optional(),
        taskId: id.optional(),
        personaId: id.optional(),
        refresh: z.boolean().default(false),
        style: reasoningStyle.optional(),
      }),
      'system.read',
      async (v) => {
        const character =
          v.personaId &&
          this.store.document<{ mainConversationId?: string }>('characters', v.personaId);
        const boundProfile =
          v.taskId === inferenceTasks.chat && character?.mainConversationId
            ? this.store.binding(character.mainConversationId)?.profileId
            : undefined;
        const profile = v.profileId
          ? this.router.profile(v.profileId)
          : v.connectionId
            ? this.router.inference.connectionProfile(v.connectionId, v.model ?? '')
            : boundProfile
              ? this.router.profile(boundProfile)
              : v.taskId
                ? this.router.route(v.taskId, v.personaId)
                : undefined;
        invariant(profile, 'missing_profile', '请先选择推理模型。');
        const actual = v.style ? { ...profile, reasoningStyle: v.style } : profile;
        try {
          const models = await this.router.inference.discover(actual, v.refresh);
          const selected = models.find((item) => item.id === profile.model);
          const reasoning = effectiveReasoning(actual, selected?.reasoning);
          return {
            model: profile.model,
            reasoning: reasoning ?? null,
            status: reasoning ? 'known' : selected ? 'unknown' : 'not-listed',
          };
        } catch (error) {
          const reasoning = effectiveReasoning(actual);
          return {
            model: profile.model,
            reasoning: reasoning ?? null,
            status: reasoning ? 'known' : 'unavailable',
            issue: (error as Error).message,
          };
        }
      },
    );
    op('models.resources', '读取本地模型资源状态',z.object({}),'system.read',()=>this.localResources.status());
    op('models.release', '释放空闲本地模型',z.object({}),'local-models.write',()=>this.localResources.releaseIdle());
    op('connections.test', '测试连接是否可用', z.object({ id, generation: z.boolean().default(false) }), 'system.read', async (v, _caller, signal) => {
      const connection = this.router.inference.connections().find((item) => item.id === v.id);
      invariant(connection, 'missing_connection', '连接不存在。');
      const adapter = this.router.inference.adapter(connection.adapterId);
      const configuredModel = this.router.inference
        .models()
        .find((model) => model.connectionId === connection.id && model.generation.enabled);
      const profile = configuredModel
        ? this.router.profile(configuredModel.id)
        : profileSchema.parse({
            ...connection.config,
            id: connection.id,
            name: connection.name,
            connectionId: connection.id,
            adapterId: adapter.id,
            kind: adapter.engine,
          });
      const backend = this.router.backends.get(adapter.engine);
      if (v.generation) {
        invariant(['api', 'pi'].includes(adapter.engine) && configuredModel,
          'missing_model', '请先为此连接保存一个生成模型。');
        return { ...(await this.api.checkGeneration(profile, signal)), model: profile.model };
      }
      if (backend?.checkConnection) return backend.checkConnection(profile);
      if(this.capabilities.list('core.inference.check-connection@1').some(p=>p.id===adapter.id&&p.state==='active'))
        return this.capabilities.invoke(this.router.inference.owner,'core.inference.check-connection@1',adapter.id,{connection},signal);
      return { ok:false,kind:adapter.family,transport:adapter.engine,verified:'unverified',detail:'此接入器尚未提供连接检查' };
    });
    op('inference.options', '读取可用模型和执行器选项', z.object({}), 'system.read', async () => {
      await this.router.inference.refresh();
      return {
        profiles: this.router.profiles(),
        adapters: this.router.inference
          .adapters()
          .map(({ id, label, owner, workerOnly, generation, embedding }) => ({
            id,
            label,
            owner,
            workerOnly,
            generation,
            embedding,
          })),
        tasks: await this.router.inference.tasks(),
        defaults: this.inferenceDefaults(),
      };
    });
    op('inference.references', '读取模型的配置引用', z.object({ id }), 'system.read', (v) =>
      this.router.inference.references(v.id),
    );
    op('profiles.save', '保存模型配置', modelProfileSchema, 'system.write', async (v) => {
      const previous = this.router.inference.models().find((model) => model.id === v.id);
      const connection = this.router.inference
        .connections()
        .find((item) => item.id === v.connectionId);
      if (
        connection?.adapterId === 'worker-codex.provider' &&
        previous?.connectionId === connection.id &&
        previous.options.contextWindowTokens !== v.options.contextWindowTokens
      )
        await this.router.backends.get('codex')?.releaseConnection?.(connection.id);
      const saved = await this.router.inference.saveModel(v);
      this.events.emit('models.changed', {});
      return saved;
    });
    op('profiles.delete', '删除未绑定的推理后端', z.object({ id }), 'system.write', (v) => {
      invariant(
        !this.store.conversations().some((c) => this.store.binding(c.id)?.profileId === v.id),
        'backend_bound',
        '请先切换使用此后端的会话。',
      );
      invariant(
        !this.store.unresolved().some((r) => r.profileId === v.id),
        'backend_busy',
        '模型仍有未核对的运行',
      );
      invariant(
        !this.router.inference.references(v.id).length,
        'model_referenced',
        '此模型仍被角色或任务使用，请先更换这些配置中的模型。',
      );
      this.store.remove('profiles', v.id);
      const routes = this.store.get<Record<string, string>>('routes', {});
      for (const [task, model] of Object.entries(routes)) if (model === v.id) delete routes[task];
      this.store.set('routes', routes);
      this.events.emit('models.changed', {});
      this.events.emit('routes.changed', {});
      return { deleted: true };
    });
    op(
      'connections.authenticate',
      '使用宿主公开接口检查账号或启动登录',
      z.object({
        id,
        action: z.enum(['status', 'login', 'cancel']),
        loginId: z.string().optional(),
      }),
      'system.write',
      async (v) => {
        const connection = this.router.inference.connections().find((c) => c.id === v.id);
        invariant(connection, 'missing_connection', '连接不存在');
        const adapter = this.router.inference.adapter(connection.adapterId);
        const profile = profileSchema.parse({
            ...connection.config,
            id: connection.id,
            connectionId: connection.id,
            adapterId: connection.adapterId,
            name: connection.name,
            kind: adapter.engine,
          }),
          backend = this.router.backend(profile);
        invariant(backend.authenticate, 'auth_unsupported', '此后端请使用配置的凭据引用');
        if (v.action !== 'status')
          invariant(
            !this.store
              .unresolved()
              .some((r) =>
                this.router.inference
                  .models()
                  .some((m) => m.id === r.profileId && m.connectionId === v.id),
              ),
            'backend_busy',
            '请先处理此后端的运行',
          );
        return backend.authenticate(profile, v.action, v.loginId);
      },
    );
    op(
      'routes.save',
      '为各类任务选择推理后端',
      z.record(id, id.nullable()),
      'system.write',
      async (v) => {
        const tasks = await this.router.inference.tasks(),
          routes = this.store.get<Record<string, string>>('routes', {});
        for (const [taskId, modelId] of Object.entries(v)) {
          const task = tasks.find((t) => t.id === taskId);
          invariant(task, 'task_unavailable', '任务当前不可用：' + taskId);
          invariant(
            task.scope !== 'character',
            'route_scope',
            '角色级推理任务需在角色配置中设置。',
          );
          if (modelId) {
            const model = this.router.inference.models().find((m) => m.id === modelId);
            invariant(
              model && this.router.inference.compatible(model, task),
              'route_capability',
              '模型能力不符合任务要求',
            );
            routes[taskId] = String(modelId);
          } else delete routes[taskId];
        }
        this.store.set('routes', routes);
        this.events.emit('routes.changed', {});
        return routes;
      },
    );
    op(
      'credentials.status',
      '读取凭据配置状态，不返回密钥',
      z.object({ reference: z.string().max(150) }),
      'credentials.write',
      (v) => this.secrets.status(v.reference),
    );
    op(
      'credentials.save',
      '把凭据存入本机受保护存储',
      z.object({ reference: id, secret: z.string().min(1).max(16000) }),
      'credentials.write',
      async (v) => {
        await this.secrets.set(v.reference, v.secret);
        return { saved: true, reference: v.reference };
      },
    );
    op(
      'plugins.enable',
      '启用或停用功能插件',
      z.object({ id, enabled: z.boolean() }),
      'system.write',
      async (v) => {
        try {
          v.enabled ? await this.plugins.enable(v.id) : await this.plugins.disable(v.id);
        } finally {
          this.store.set('plugins.intent', Object.fromEntries(this.plugins.intent));
          this.events.emit('plugins.changed', {});
        }
        return this.plugins.list();
      },
    );
    op(
      'plugins.install',
      '明确授权后加载本地扩展目录',
      z.object({ directory: z.string().min(1), confirmed: z.literal(true) }),
      'system.write',
      (v) => this.extensions.install(v.directory, v.confirmed),
    );
    op(
      'plugins.package.inspect',
      '检查插件包及权限，不执行代码',
      z.object({ path: z.string() }),
      'system.read',
      (v) => this.extensions.inspectPackage(v.path),
    );
    op(
      'plugins.package.install',
      '安装已检查的插件包，更新在下次启动生效',
      z.object({ path: z.string(), sha256: z.string(), confirmed: z.literal(true) }),
      'system.write',
      (v) => this.extensions.installPackage(v.path, v.sha256),
    );
    op(
      'plugins.package.rollback',
      '恢复上一插件版本，下次启动生效',
      z.object({ id, confirmed: z.literal(true) }),
      'system.write',
      (v) => this.extensions.rollbackPackage(v.id),
    );
    op('frontend.pages', '读取已启用插件的页面', z.object({}), 'system.read', () =>
      this.frontend.pages(),
    );
    op('plugins.package.uninstall', '卸载独立扩展并保留配置与数据', z.object({ id, confirmed: z.literal(true) }), 'system.write', async (v) => {
      const result = await this.extensions.uninstall(v.id); this.events.emit('plugins.changed', {}); return result;
    });
    op('frontend.content', '打开插件页面', z.object({ id }), 'system.read', (v) =>
      this.frontend.content(v.id),
    );
    op(
      'frontend.mount',
      '创建隔离的插件页面',
      z.object({ id, bridge: z.string().uuid(), personaId: id.optional() }),
      'system.read',
      (v) => this.frontend.mount(v.id, v.bridge, v.personaId),
    );
    op(
      'frontend.invoke',
      '使用页面所属插件的权限执行操作',
      z.object({
        pageId: id,
        operation: z.string().max(200),
        input: z.unknown(),
        personaId: id.optional(),
      }),
      'system.read',
      (v, _caller, signal) =>
        this.frontend.invoke(v.pageId, v.operation, v.input, v.personaId, signal),
    );
    op(
      'settings.save',
      '保存插件的声明式设置',
      z.object({
        pluginId: id,
        value: z.record(z.string(), z.unknown()),
      }),
      'system.write',
      (v) => {
        const schema = this.plugins.plugins.get(v.pluginId)?.config?.schema;
        const parsed =
          v.pluginId === 'mcp'
            ? z.object({ permissions: z.array(z.string()).max(100) }).parse(v.value)
            : schema
              ? schema.parse(v.value)
              : this.extensions.settings(v.pluginId, v.value);
        if (v.pluginId === 'review')
          new Intl.DateTimeFormat('en', { timeZone: (parsed as any).timezone });
        this.store.set(
          v.pluginId === 'mcp' ? 'mcp.permissions' : v.pluginId + '.config',
          v.pluginId === 'mcp' ? (parsed as any).permissions : parsed,
        );
        this.events.emit('settings.changed', { pluginId: v.pluginId });
        return parsed;
      },
    );
    op(
      'conversations.create',
      '创建独立会话',
      conversationSchema.omit({ permissions: true }),
      'conversation.write',
      (v) => {
        const conversation: Conversation = {
          ...v,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
        };
        this.store.saveConversation(conversation);
        this.events.emit('conversation.created', { id: conversation.id });
        return conversation;
      },
    );
    op(
      'conversations.update',
      '修改会话标题、人格注入和思考强度',
      z.object({
        id,
        title: z.string().min(1).max(160).optional(),
        personaId: id.optional(),
        injection: z.boolean().optional(),
        reasoning: reasoning.optional(),
      }),
      'conversation.write',
      (v) => {
        const old = this.store.conversation(v.id);
        invariant(old, 'missing_conversation', v.id);
        invariant(!this.router.workSessions.list().some(work => work.conversationId === v.id && work.origin.type !== 'delegation'),
          'work_managed', '请在来源自动化任务中修改执行设置。');
        invariant(
          !v.personaId || v.personaId === old.personaId || !managedConversation(this.store, old),
          'managed_conversation',
          '角色管理的会话不能直接更换角色。',
        );
        const conversation = { ...old, ...v };
        this.store.saveConversation(conversation);
        this.events.emit('conversation.updated', { id: conversation.id });
        return conversation;
      },
    );
    op(
      'conversations.permissions',
      '为单个会话设置宿主权限',
      z.object({ id, permissions: conversationPermissions }),
      'conversation.write',
      (v, caller) => {
        invariant(caller.kind === 'ui', 'permission_actor', '请在会话工作台修改宿主权限。');
        const old = this.store.conversation(v.id);
        invariant(old, 'missing_conversation', v.id);
        invariant(
          !managedConversation(this.store, old),
          'managed_conversation',
          '请在编辑角色的运行方式或 Worker 配置中修改权限。',
        );
        invariant(
          !this.router.isBusy(v.id) && !this.store.unresolved(v.id).length,
          'conversation_busy',
          '请在当前会话结束后修改权限。',
        );
        const permissions = conversationPermissions.parse(v.permissions);
        if (permissions.projectDirectory)
          permissions.projectDirectory = projectRoot(permissions.projectDirectory, this.runtime);
        const conversation = { ...old, permissions };
        this.store.saveConversation(conversation);
        this.events.emit('conversation.updated', { id: v.id });
        return conversation;
      },
    );
    op(
      'conversations.interactions',
      '读取本会话等待处理的宿主请求',
      z.object({ id }),
      'conversation.read',
      (v, caller) => {
        invariant(caller.kind === 'ui', 'permission_actor', '请在会话工作台查看宿主请求。');
        return this.router.interactions.list(v.id);
      },
    );
    op(
      'conversations.toolCatalog',
      '读取会话实际可用的工具',
      z.object({ id }),
      'conversation.read',
      async (v, caller) => {
        const conversation = this.store.conversation(v.id);
        invariant(caller.kind === 'ui' && conversation, 'missing_conversation', v.id);
        const binding = this.store.binding(v.id);
        if (!binding) return { runtime: 'pi', tools: [] };
        const profile = this.router.profile(binding.profileId),
          backend = this.router.executionBackend(profile, v.id);
        return {
          runtime: backend.kind,
          projectDirectory: conversation.permissions?.projectDirectory,
          tools:
            (await backend.toolCatalog?.({
              permissions: conversation.permissions,
              principal: { conversationId: v.id, personaId: conversation.personaId },
            })) ?? [],
        };
      },
    );
    op(
      'conversations.tools',
      '检查会话的 Echo MCP 工具',
      z.object({ id }),
      'conversation.read',
      (v, caller) => {
        invariant(
          caller.kind === 'ui' && this.store.conversation(v.id),
          'missing_conversation',
          v.id,
        );
        const binding = this.store.binding(v.id);
        const profile = binding
          ? this.router.profile(binding.profileId)
          : this.router.route(inferenceTasks.chat);
        invariant(
          profile.kind === 'codex',
          'tool_catalog_unavailable',
          '此接入器没有可读的宿主工具清单。',
        );
        return (this.router.backends.get('codex') as CodexBackend).availableEchoTools(
          profile,
          binding?.sessionId,
          {
            conversationId: v.id,
            personaId: this.store.conversation(v.id)!.personaId,
          },
        );
      },
    );
    op(
      'conversations.answer',
      '在会话工作台回应宿主请求',
      z.object({ id, interactionId: id, answer: hostAnswerSchema }),
      'conversation.write',
      (v, caller) => {
        invariant(caller.kind === 'ui', 'permission_actor', '只有会话工作台可以回应宿主请求。');
        return this.router.interactions.answer(v.id, v.interactionId, v.answer);
      },
    );
    op(
      'conversations.references',
      '检查删除会话前需要解除的绑定',
      z.object({ id }),
      'conversation.read',
      (v) => this.conversationReferences(v.id),
    );
    op(
      'conversations.delete',
      '归档宿主会话并删除 Echo 中的会话记录',
      z.object({ id, confirmed: z.literal(true) }),
      'conversation.write',
      (v, _c, s) =>
        this.router.deleteConversation(
          v.id,
          () => {
            const references = this.conversationReferences(v.id);
            invariant(
              !references.some((ref) => ref.blocksDeletion),
              'conversation_referenced',
              '请先解除以下绑定：' +
                references
                  .filter((ref) => ref.blocksDeletion)
                  .map((r) => r.label)
                  .join('、'),
            );
          },
          s,
        ),
    );
    op(
      'conversations.messages',
      '读取规范会话记录',
      z.object({
        id,
        after: z.number().int().min(0).default(0),
        before: z.number().int().min(1).optional(),
        latest: z.boolean().default(true),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      'conversation.read',
      (v) => ({
        busy: this.router.isBusy(v.id),
        messages:
          v.latest && !v.after
            ? this.store.historyPage(v.id, v.limit, v.before)
            : this.store.messages(v.id, v.after, v.limit),
        binding: this.store.binding(v.id),
        inputs: this.router.inputs(v.id),
      }),
      true,
    );
    op(
      'conversations.bind',
      '切换此会话唯一推理后端',
      z.object({ id, profileId: id }),
      'conversation.write',
      (v, _c, s) => {
        const conversation = this.store.conversation(v.id);
        invariant(conversation, 'missing_conversation', v.id);
        invariant(
          !managedConversation(this.store, conversation) ||
            this.store.binding(v.id)?.profileId === v.profileId,
          'managed_conversation',
          '请在编辑角色的运行方式或 Worker 配置中修改推理后端。',
        );
        return this.router.bind(v.id, v.profileId, s);
      },
    );
    op(
      'conversations.send',
      '在会话中发送一条消息',
      z.object({
        conversationId: id,
        text: z.string().max(100000),
        requestId: id,
        reasoning: reasoning.optional(),
        bubble: z.boolean().default(false),
        workSession: z.literal(true).optional(),
        attachmentIds: z.array(id).max(4).optional(),
      }),
      'conversation.write',
      (v) => this.router.enqueue(v),
    );
    op(
      'conversations.steer',
      '给当前运行补充指令',
      z.object({
        conversationId: id,
        runId: id,
        requestId: id,
        text: z.string().min(1).max(24000),
        workSession: z.literal(true).optional(),
        attachmentIds: z.array(id).max(4).optional(),
      }),
      'conversation.write',
      (v) => this.router.steer(v),
    );
    op(
      'conversations.cancelInput',
      '移除尚未执行的排队消息',
      z.object({ conversationId: id, requestId: id }),
      'conversation.write',
      (v) => this.router.cancelInput(v.requestId, v.conversationId),
    );
    op(
      'conversations.resolveInput',
      '人工核对补充消息的未知结果，不重发',
      z.object({ conversationId: id, requestId: id, confirmed: z.literal(true) }),
      'conversation.write',
      (v) => {
        const key = 'steer-' + v.requestId,
          receipt = this.store.receipt(key);
        invariant(
          receipt && receipt.conversationId === v.conversationId && receipt.state === 'unknown',
          'input_state',
          '仅可核对当前会话结果未知的补充消息。',
        );
        this.store.saveReceipt(key, { ...receipt, state: 'resolved' });
        this.events.emit('input.changed', { conversationId: v.conversationId });
        return { resolved: true };
      },
    );
    op(
      'conversations.attach',
      '为会话添加图片或文本附件',
      attachmentInput,
      'conversation.write',
      (v) => this.router.attachments.add(v.conversationId, v.name, v.mediaType, v.data),
    );
    op(
      'conversations.attachProjectFile',
      '引用当前项目中的文本文件',
      z.object({ conversationId: id, path: z.string().min(1).max(4096) }),
      'conversation.write',
      (v) => this.router.attachments.projectFile(v.conversationId, v.path),
    );
    op('runs.items', '读取运行过程', z.object({ runId: id }), 'conversation.read', (v) =>
      this.router.execution.list(v.runId),
    );
    op(
      'conversations.cancel',
      '请求取消此会话当前运行',
      z.object({ id }),
      'conversation.write',
      (v) => {
        this.router.cancel(v.id);
        return { requested: true };
      },
    );
    op(
      'conversations.export',
      '导出带来源的完整记录',
      z.object({ id }),
      'conversation.read',
      (v) => ({
        format: 'echo-conversation-v1',
        conversation: this.store.conversation(v.id),
        messages: this.store.allMessages(v.id),
      }),
    );
    op(
      'conversations.import',
      '导入 Echo 的带作者记录',
      z.object({
        format: z.literal('echo-conversation-v1'),
        conversation: conversationSchema,
        messages: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant', 'system', 'tool']),
              source: z.enum([
                'human',
                'chat',
                'observation',
                'care',
                'review',
                'import',
                'tool',
                'notification',
              ]),
              text: z.string(),
              createdAt: z.string(),
              meta: z.record(z.string(), z.unknown()).default({}),
            }),
          )
          .max(100000),
      }),
      'conversation.write',
      (v) => {
        const conversation: Conversation = {
          ...v.conversation,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
        };
        this.store.transaction(() => {
          this.store.saveConversation(conversation);
          for (const m of v.messages)
            this.store.append(conversation.id, m.role, m.source, m.text, undefined, {
              ...m.meta,
              originalCreatedAt: m.createdAt,
            });
        });
        return conversation;
      },
    );
    op(
      'runs.list',
      '查看执行结果和未知运行',
      z.object({ conversationId: id.optional() }),
      'conversation.read',
      (v) =>
        this.store.runs().filter((r) => !v.conversationId || r.conversationId === v.conversationId),
    );
    op(
      'runs.reconcile',
      '通过后端公开接口核对结果',
      z.object({ id }),
      'conversation.write',
      (v, _c, s) => this.router.reconcile(v.id, s),
    );
    op(
      'runs.resolve',
      '人工确认未知运行已处理',
      z.object({ id, confirmed: z.literal(true) }),
      'conversation.write',
      (v) => this.router.resolveUnknown(v.id),
    );
  }
  private inferenceDefaults() {
    return Object.fromEntries(
      this.store
        .documents<{ id: string; mainConversationId: string; routes: Record<string, string> }>(
          'characters',
        )
        .map((role) => [
          role.id,
          {
            main: this.store.binding(role.mainConversationId)?.profileId ?? '',
            routes: role.routes ?? {},
          },
        ]),
    );
  }
  bindHarnessMcp(
    bridge: ((principal: { conversationId: string; personaId: string }) => HarnessMcp) | undefined,
  ) {
    this.harnessMcp = bridge;
    (this.router.backends.get('dsh') as DshBackend | undefined)?.setEchoMcp?.(bridge);
  }
  private conversationReferences(conversationId: string) {
    const references=this.plugins.list().flatMap((module) => {
      const bundled = this.plugins.plugins.get(module.id)?.references?.(conversationId) ?? [];
      const external = this.store
        .documents<{
          conversationId: string;
          label: string;
          role: 'channel' | 'trigger' | 'material' | 'report';
        }>('conversation-references.' + module.id)
        .filter((ref) => ref.conversationId === conversationId)
        .map((ref) => ({ label: ref.label, role: ref.role, page: 'plugins' }));
      const references: import('../../packages/kernel/registry.ts').ConversationReference[] = [
        ...bundled,
        ...external,
      ];
      return references.map((ref) => ({
        ...ref,
        page: module.enabled ? ref.page : 'plugins',
        enabled: module.enabled && ref.enabled !== false,
        blocksDeletion: ref.blocksDeletion !== false,
        type: module.enabled ? ref.type : undefined,
      }));
    });
    return [...references,...this.deliveries.references(conversationId)];
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    const errors: unknown[] = [];
    for (const close of [
      () => this.deliveries.close(),
      () => this.plugins.close(),
      () => this.router.close(),
      () => this.externalMcp.close(),
      () => this.clock.close(),
    ])
      try {
        await close();
      } catch (e) {
        errors.push(e);
      }
    try {
      if (errors.length)
        this.store.set('shutdown.issue', {
          at: new Date().toISOString(),
          message: errors.map(String).join('; ').slice(0, 2000),
        });
    } finally {
      this.store.close();
    }
    if (errors.length) throw errors[0];
  }
}
