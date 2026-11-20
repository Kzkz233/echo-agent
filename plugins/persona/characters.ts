import { characterEdits, mergeCharacter, taskKey } from './character-edits.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname } from 'node:path';
import { ensureCharacterWorkspace, projectRoot } from '../../packages/backends/project-root.ts';
import { z } from 'zod';
import { id, invariant, personaSchema, type Persona } from '../../packages/contracts/index.ts';
import { Automation } from '../../packages/kernel/automation.ts';
import { characterPoint } from '../../packages/kernel/characters.ts';
import {
  characterDraft,
  characterPackage,
  type CharacterDraft,
  type CharacterRecord,
} from './character-contracts.ts';
import type { Store } from '../../packages/kernel/store.ts';
import type { Router } from '../../packages/kernel/router.ts';
import type { PluginContext } from '../../packages/kernel/registry.ts';
import type { Events } from '../../packages/kernel/events.ts';
import { roleToolGrants } from '../../packages/kernel/tool-access.ts';
import { portableTaskSettings } from '../../packages/contracts/portable-settings.ts';
import { taskModelChoice } from '../../packages/contracts/task-model.ts';

const applicationOnlyCharacterFeatures = new Set(['knowledge', 'semantic', 'documents', 'assets']);

function portableConfiguration(fields: any[], value: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    fields
      .filter(
        (field) => !field.localOnly && !field.resource && field.type !== 'path' && Object.hasOwn(value, field.key),
      )
      .map((field) => {
        if (field.type !== 'records') return [field.key, value[field.key]];
        invariant(Array.isArray(value[field.key]), 'package_configuration', '角色包列表配置无效。');
        return [
          field.key,
          value[field.key].map((row: any) => {
            invariant(
              row && typeof row === 'object' && !Array.isArray(row),
              'package_configuration',
              '角色包条目无效。',
            );
            return {
              ...(typeof row.id === 'string' ? { id: row.id } : {}),
              ...portableConfiguration(field.rowFields ?? [], row),
            };
          }),
        ];
      }),
  );
}

export class Characters {
  private pending = new Set<string>();
  constructor(
    readonly store: Store,
    readonly router: Router,
    readonly events: Events,
    readonly savePersona: (value: Persona) => Promise<Persona>,
  ) {}
  private ctx?: PluginContext;
  private scope() {
    invariant(this.ctx, 'plugin_disabled', '角色能力尚未启用。');
    return this.ctx;
  }
  private conversationPersona(value: unknown) {
    return typeof value === 'string' && value
      ? this.store.conversation(value)?.personaId
      : undefined;
  }
  private async feature(name: string, action: string, personaId?: string, value?: unknown) {
    return (await this.scope().capabilities.invoke(characterPoint, name + '.character', {
      action,
      personaId,
      value,
    })) as any;
  }
  async catalog(definitionsOnly = false) {
    const providers = this.scope().capabilities.list(characterPoint);
    const features = await Promise.all(
      providers
        .filter((p) => p.state === 'active')
        .map(async (p) => ({
          id: p.owner,
          name: p.label,
          ...(await this.feature(p.owner, 'describe')),
        })),
    );
    const catalog = await new Automation(this.scope().capabilities).catalog(this.scope().signal, definitionsOnly ? 'definition' : undefined);
    // Editing an unavailable task must preserve the provider's existing configuration.
    invariant(!catalog.unavailable.length, 'task_catalog_unavailable',
      '暂时无法读取完整的任务配置：' + catalog.unavailable.join('、'));
    const characterTasks = catalog.types.filter((type) => type.scope === 'character');
    const taskIds = new Set(characterTasks.map((type) => type.id));
    return {
      features: features.map((feature) => ({
        ...feature,
        taskTypes: feature.taskTypes?.filter((id: string) => taskIds.has(id)),
      })),
      taskTypes: characterTasks,
    };
  }
  private record(personaId: string, features: string[]) {
    let row = this.store.document<CharacterRecord>('characters', personaId);
    if (!row) {
      const avatar = this.store.get<{ personaId?: string; conversationId?: string }>(
        'avatar.config',
        {},
      );
      const chats = this.store
        .conversations()
        .filter(
          (c) => c.personaId === personaId && !['worker', 'group-member'].includes(c.kind ?? ''),
        );
      const main = chats.find((c) => c.id === avatar.conversationId) ?? chats[0];
      row = {
        id: personaId,
        revision: 0,
        features,
        mainConversationId: main?.id ?? '',
        routes: {},
        taskIds: [],
        state: 'ready',
      };
    }
    return row;
  }
  async read(
    personaId: string, suppliedCatalog?: Awaited<ReturnType<Characters['catalog']>>,
  ): Promise<CharacterDraft & { mainConversationId: string; state: string; issue?: string; activity: { enabled: boolean; revision: number } }> {
    const persona = this.store.document<Persona>('personas', personaId);
    invariant(persona, 'persona_missing', '角色不存在。');
    const catalog = suppliedCatalog ?? await this.catalog();
    const role = this.record(
      personaId,
      catalog.features.map((f) => f.id),
    );
    const roleFeatures = [
      ...new Set([
        ...role.features.filter((feature) => !applicationOnlyCharacterFeatures.has(feature)),
        'delegation',
      ]),
    ];
    const inferenceTasks = await this.router.inference.tasks();
    const characterRoutes = Object.fromEntries(
      Object.entries(role.routes ?? {}).filter(([task]) =>
        inferenceTasks.some((entry) => entry.id === task && entry.scope === 'character'),
      ),
    );
    const configurations: Record<string, any> = {};
    for (const feature of catalog.features)
      configurations[feature.id] = (await this.feature(feature.id, 'read', personaId)).value;
    const main = this.store.conversation(role.mainConversationId);
    const tasks = catalog.taskTypes.flatMap((type) =>
      (type.items ?? [])
        .filter(
          (item: any) =>
            item.settings &&
            (item.settings.personaId === personaId ||
              this.conversationPersona(item.settings.conversationId) === personaId ||
              role.taskIds.some((t) => t.type === type.id && t.id === item.id)),
        )
        .map((item: any) => ({
          id: item.id,
          type: type.id,
          settings: item.settings,
          templateId: role.taskIds.find((t) => t.id === item.id && t.type === type.id)?.templateId,
          enabledWhenAvailable: role.taskIds.find((t) => t.id === item.id && t.type === type.id)
            ?.enabledWhenAvailable,
        })),
    );
    return {
      ...characterDraft.parse({
        persona,
        revision: role.revision,
        features: roleFeatures,
        configurations,
        profileId: this.store.binding(role.mainConversationId)?.profileId ?? '',
        reasoning: main?.reasoning,
        permissions: main?.permissions,
        compaction: main?.compaction,
        toolPermissions: roleToolGrants(this.store, role),
        independentToolGrants: role.independentToolGrants,
        routes: characterRoutes,
        tasks,
        package: role.package,
      }),
      mainConversationId: role.mainConversationId,
      activity: this.store.get('character.activity.' + personaId, { enabled: true, revision: 0 }),
      state: role.state,
      issue: role.issue,
    };
  }
  async commit(raw: unknown, requestId: string, signal: AbortSignal,
    edit?: { id: string; changes: z.infer<typeof characterEdits> }, createOnly = false, preserveDraft = false) {
    const roleId = edit?.id ?? characterDraft.parse(raw).persona.id;
    const key = 'character-setup.' + requestId;
    const hash = createHash('sha256').update(JSON.stringify(edit ?? characterDraft.parse(raw))).digest('hex');
    const receipt = this.store.receipt(key);
    if (receipt) {
      invariant(receipt.hash === hash, 'idempotency_conflict', '此保存编号对应的配置已变化。');
      if (receipt.state === 'completed') return edit ? {persona:this.store.document<Persona>('personas',roleId)!} : this.read(roleId);
    }
    invariant(!this.pending.has(roleId), 'character_busy', '角色正在保存。');
    this.pending.add(roleId);
    try {
      invariant(!createOnly || receipt || !this.store.document('personas',roleId), 'revision_conflict', '此角色已存在，请从角色编辑页打开。');
      const removed = new Set(edit?.changes.tasks.flatMap(e => e.action === 'remove' ? [taskKey(e.task)] : []));
      const changed = (name: string) => !edit || edit.changes.fields.some(f => f.path[0] === name);
      const featureChanged = (name: string) => !edit || edit.changes.fields.some(f =>
        f.path[0] === 'configurations' && (f.path.length === 1 || f.path[1] === name));
      const touchesTasks = (task: { id: string; type: string }) => !edit || changed('features') ||
        edit.changes.tasks.some(e => taskKey(e.action === 'edit' ? e : e.task) === taskKey(task));
      if (edit && !edit.changes.tasks.length && edit.changes.fields.every(f => f.path[0] === 'persona')) {
        const current = this.store.document<Persona>('personas',roleId);
        invariant(current,'persona_missing','角色不存在。');
        const draft = mergeCharacter(characterDraft.parse({ persona:current }),edit.changes);
        const persona = personaSchema.parse(draft.persona);
        if (!isDeepStrictEqual(persona,current)) {
          await this.savePersona(persona);
          const role = this.store.document<CharacterRecord>('characters',roleId);
          if (role) this.store.put('characters',roleId,{...role,revision:role.revision+1});
          this.events.emit('characters.updated',{personaId:roleId});
        }
        if (!preserveDraft) this.store.remove('character-drafts',roleId);
        this.store.saveReceipt(key,{hash,state:'completed',roleId});
        return {persona};
      }
      const catalog = await this.catalog();
      const draft = edit ? mergeCharacter(await this.read(roleId, catalog), edit.changes) : characterDraft.parse(raw);
      draft.features = draft.features.filter(feature => !applicationOnlyCharacterFeatures.has(feature));
      for (const feature of applicationOnlyCharacterFeatures) delete draft.configurations[feature];
      personaSchema.parse(draft.persona);
      const previous = this.record(roleId, []);
      const declaredTasks = await this.router.inference.tasks();
      const characterTaskIds = new Set(
        declaredTasks
          .filter((task) => task.scope === 'character' && draft.features.includes(task.owner ?? ''))
          .map((task) => task.id),
      );
      const pendingRoutes: Record<string, string> = receipt?.resolvedRoutes ?? draft.routes;
      draft.routes = {
        ...Object.fromEntries(
          Object.entries(previous.routes ?? {}).filter(
            ([id]) => !declaredTasks.some((task) => task.id === id),
          ),
        ),
        ...Object.fromEntries(
          Object.entries(pendingRoutes).filter(([task]) => characterTaskIds.has(task)),
        ),
      };
      for (const task of draft.tasks) {
        const type = catalog.taskTypes.find((type) => type.id === task.type);
        const available =
          type &&
          (draft.features.includes(type.owner) ||
            catalog.features.some(
              (feature) =>
                draft.features.includes(feature.id) && feature.taskTypes?.includes(task.type),
            ));
        if (!available) {
          task.enabledWhenAvailable ??= Boolean(task.settings.enabled);
          task.settings = { ...task.settings, enabled: false };
        } else if (task.enabledWhenAvailable !== undefined) {
          task.settings = { ...task.settings, enabled: task.enabledWhenAvailable };
          delete task.enabledWhenAvailable;
        }
      }
      const changedTasks = draft.tasks.filter((task) => {
        if (!touchesTasks(task)) return false;
        const type = catalog.taskTypes.find((type) => type.id === task.type),
          old = type?.items?.find((item: any) => item.id === task.id);
        const keys = ['name', 'enabled', ...(type?.fields ?? []).map((field: any) => field.key)];
        const project = (value: any) => Object.fromEntries(keys.map((key) => [key, value?.[key]]));
        return !old || !isDeepStrictEqual(project(task.settings), project(old.settings));
      });
      if (previous.mainConversationId && (!edit || ['features','permissions','toolPermissions','independentToolGrants','profileId','compaction','reasoning','routes'].some(changed))) {
        invariant(
          !this.router.isBusy(previous.mainConversationId) &&
            !this.store.unresolved(previous.mainConversationId).length,
          'character_busy',
          '请先结束或核对角色主会话的当前运行，再保存角色配置。',
        );
      }
      if (draft.permissions.projectDirectory)
        draft.permissions.projectDirectory = projectRoot(
          draft.permissions.projectDirectory,
          dirname(this.store.path),
        );
      for (const key of ['readRoots', 'writeRoots'] as const)
        if (draft.permissions[key])
          draft.permissions[key] = [
            ...new Set(
              draft.permissions[key]!.map((path) => projectRoot(path, dirname(this.store.path))),
            ),
          ];
      invariant(
        previous.revision === (receipt ? receipt.revision : draft.revision),
        'revision_conflict',
        '角色配置已在其他窗口修改。',
      );
      const normalized: Record<string, any> = {};
      for (const feature of draft.features) {
        if (!catalog.features.some((f) => f.id === feature) && previous.features.includes(feature))
          continue;
        invariant(
          catalog.features.some((f) => f.id === feature),
          'feature_missing',
          '请先安装并启用角色能力：' + feature,
        );
        if (featureChanged(feature) || changed('features') && !previous.features.includes(feature)) normalized[feature] = (
          await this.feature(feature, 'validate', roleId, draft.configurations[feature] ?? {})
        ).value;
        const dependencies = catalog.features.find((f) => f.id === feature)?.requires ?? [];
        invariant(
          dependencies
            .filter((id: string) => catalog.features.some((f) => f.id === id))
            .every((id: string) => draft.features.includes(id)),
          'feature_dependency',
          '所选增强能力需要先启用基础能力。',
        );
      }
      for (const [task, model] of Object.entries(draft.routes)) {
        const declared = (await this.router.inference.tasks()).find((row) => row.id === task);
        if (!declared && previous.routes?.[task] === model) continue;
        invariant(declared, 'route_missing', '推理用途尚未注册。');
        invariant(declared.scope === 'character', 'route_scope', '共享推理任务不能绑定到角色。');
        const profile = this.router.profile(model);
        invariant(
          this.router.inference.compatible(
            this.router.inference.models().find((row) => row.id === model)!,
            declared,
          ),
          'route_capability',
          '所选模型的能力不符合此推理用途。',
        );
        invariant(
          declared.operation !== 'generate' || !declared.inputs.includes('image') || profile.vision,
          'vision_required',
          '观察需要支持图像的模型。',
        );
      }
      if (changed('profileId') && draft.profileId) {
        this.router.profile(draft.profileId);
        const model=this.router.inference.models().find(model=>model.id===draft.profileId);
        invariant(model&&this.router.inference.supports(model,{operation:'generate',inputs:['text']}),'route_capability','主会话需要可用的语言模型，外部宿主仅用于 Worker。');
      }
      for (const task of draft.tasks) {
        const type = catalog.taskTypes.find((t) => t.id === task.type);
        invariant(
          type &&
            (task.enabledWhenAvailable !== undefined ||
              draft.features.includes(type.owner) ||
              catalog.features.some(
                (feature) =>
                  draft.features.includes(feature.id) && feature.taskTypes?.includes(task.type),
              )),
          'task_feature',
          '任务对应的角色能力尚未启用。',
        );
        const owner = catalog.taskTypes
          .flatMap((t) => (t.items ?? []).map((item: any) => ({ type: t.id, ...item })))
          .find((item: any) => item.id === task.id && item.type === task.type);
        invariant(
          !owner ||
            owner.settings?.personaId === roleId ||
            this.conversationPersona(owner.settings?.conversationId) === roleId ||
            previous.taskIds.some((t) => t.id === task.id && t.type === task.type),
          'task_owner',
          '任务属于另一个角色。',
        );
      }
      for (const command of edit?.changes.tasks ?? []) {
        if (command.action !== 'remove') continue;
        const type = catalog.taskTypes.find(t => t.id === command.task.type);
        invariant(type?.canRemove,'automation_unsupported','此任务类型当前无法移除。');
        const item = type.items.find(t => t.id === command.task.id);
        invariant(!item || item.settings?.personaId === roleId || this.conversationPersona(item.settings?.conversationId) === roleId ||
          previous.taskIds.some(t => taskKey(t) === taskKey(command.task)), 'task_owner','任务属于另一个角色。');
      }
      const oldMain = this.store.binding(previous.mainConversationId)?.profileId;
      const nextMain = draft.profileId || oldMain;
      for (const task of draft.tasks) {
        if (!task.settings.enabled) continue;
        const type = catalog.taskTypes.find(row => row.id === task.type);
        for (const field of type?.fields ?? []) {
          if (field.modelFallback !== 'main' || !field.inferenceTask || !['model', 'executor'].includes(field.kind)) continue;
          const explicit = task.settings[field.key];
          const choice = taskModelChoice(typeof explicit === 'string' ? explicit : undefined, nextMain);
          if (changedTasks.includes(task) || (choice.source === 'main' && nextMain !== oldMain))
            this.router.requireTaskModel(field.inferenceTask, choice.profileId);
        }
      }
      const conversationId = previous.mainConversationId || 'main-' + roleId;
      const revision = receipt?.revision ?? previous.revision + 1;
      const referencedTasks = draft.tasks.filter(t => touchesTasks(t));
      const retained = previous.taskIds.filter(t => !removed.has(taskKey(t)) &&
        !referencedTasks.some(other => taskKey(t) === taskKey(other)));
      const role: CharacterRecord = {
        ...previous, id:roleId, revision, mainConversationId:conversationId, state:'configuring',
        ...(changed('features') && {features:draft.features}),
        ...(changed('toolPermissions') && {toolPermissions:[...new Set(draft.toolPermissions)]}),
        ...(changed('independentToolGrants') && {independentToolGrants:draft.independentToolGrants || previous.independentToolGrants}),
        ...((changed('routes') || changed('features')) && {routes:draft.routes}),
        ...(changed('package') && {package:draft.package}),
        taskIds: [...retained,...referencedTasks.map(({id,type,templateId,enabledWhenAvailable}) =>
          ({id,type,templateId,enabledWhenAvailable}))],
      };
      this.store.saveReceipt(key, {
        hash,
        revision,
        state: 'applying',
        roleId,
        resolvedRoutes: draft.routes,
      });
      if (changed('persona')) await this.savePersona(draft.persona);
      this.store.put('characters', roleId, edit ? {...role,taskIds:previous.taskIds} : role);
      // Suspend role-owned displays/tasks during every configuration transaction,
      // including edits whose extension configuration itself did not change.
      this.events.emit('characters.updated', { personaId: roleId });
      const existing = this.store.conversation(conversationId);
      if (!existing || ['permissions','compaction','reasoning'].some(changed)) this.store.saveConversation({
        id: conversationId,
        title: existing?.title ?? draft.persona.name,
        personaId: roleId,
        injection: true,
        ...existing,
        kind: 'main',
        ...(changed('permissions') && { permissions: draft.permissions }),
        ...(changed('compaction') && { compaction: draft.compaction }),
        ...(changed('reasoning') && { reasoning: draft.reasoning }),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      });
      const ordered: string[] = [],
        visited = new Set<string>();
      const visit = (feature: string) => {
        if (visited.has(feature)) return;
        visited.add(feature);
        for (const dependency of catalog.features.find((f) => f.id === feature)?.requires ?? [])
          if (draft.features.includes(dependency)) visit(dependency);
        ordered.push(feature);
      };
      draft.features
        .filter((id) => catalog.features.some((feature) => feature.id === id))
        .forEach(visit);
      for (const feature of ordered)
        if (
          changed('features') && !previous.features.includes(feature) ||
          featureChanged(feature) && !isDeepStrictEqual(
            (await this.feature(feature, 'read', roleId)).value,
            normalized[feature],
          )
        )
          await this.feature(feature, 'save', roleId, normalized[feature]);
      const currentItem = async (type:string, id:string) => {
        const page = await new Automation(this.scope().capabilities).catalog(signal, 'instances',type);
        invariant(!page.unavailable.length && page.types.length,'task_catalog_unavailable','任务提供方暂时不可用。');
        return page.types[0].items.find(item => item.id === id);
      };
      for (const task of changedTasks) {
        if (edit) {
          const before = catalog.taskTypes.find(t => t.id === task.type)?.items.find(i => i.id === task.id);
          const now = await currentItem(task.type,task.id);
          invariant(isDeepStrictEqual(now?.persistedSettings ?? now?.settings,before?.persistedSettings ?? before?.settings),
            'revision_conflict','任务配置已变化，请重新打开后保存。');
        }
        await this.saveTask(task, roleId, conversationId, edit ? Boolean(task.settings.enabled) : false);
      }
      for (const command of edit?.changes.tasks ?? []) {
        if (command.action !== 'remove') continue;
        const type = catalog.taskTypes.find(t => t.id === command.task.type);
        const item = type?.items.find(t => t.id === command.task.id);
        if (!type || !item) continue;
        const now = await currentItem(type.id,item.id);
        if (!now) continue;
        invariant(isDeepStrictEqual(now.persistedSettings ?? now.settings,item.persistedSettings ?? item.settings),
          'revision_conflict','任务配置已变化，请重新打开后确认移除。');
        invariant(type.canRemove && (item.settings?.personaId === roleId ||
          this.conversationPersona(item.settings?.conversationId) === roleId ||
          previous.taskIds.some(t => taskKey(t) === taskKey(command.task))), 'task_owner', '不可移除此角色之外的任务。');
        await this.scope().capabilities.invoke('core.automation.types@1', type.id, { action:'remove', id:item.id });
      }
      if (changed('profileId') && draft.profileId) {
        const binding = this.store.binding(conversationId);
        invariant(
          !binding || binding.state === 'active',
          'binding_not_ready',
          '请先核对未完成的会话连接。角色配置已保存。',
        );
        await this.router.bind(conversationId, draft.profileId, signal);
      }
      signal.throwIfAborted();
      for (const task of changedTasks)
        if (!edit && task.settings.enabled) await this.saveTask(task, roleId, conversationId, true);
      if (!existing || !edit && existing.review === undefined) this.store.saveConversation({
        ...this.store.conversation(conversationId)!,
        review: existing?.review ?? draft.features.includes('review'),
      });
      this.store.put('characters', roleId, { ...role, state: 'ready', issue:undefined });
      this.store.remove('character-drafts', roleId);
      this.store.saveReceipt(key, { hash, revision, state: 'completed', roleId });
      this.events.emit('characters.updated', { personaId: roleId });
      return edit ? {persona:draft.persona} : this.read(roleId);
    } catch (error) {
      const role = this.store.document<CharacterRecord>('characters', roleId);
      if (role && this.store.receipt(key)) {
        this.store.put('characters', roleId, {
          ...role,
          state: 'needs-attention',
          issue: String(error).slice(0, 500),
        });
        this.events.emit('characters.updated', { personaId: roleId });
      }
      throw error;
    } finally {
      this.pending.delete(roleId);
    }
  }
  private saveTask(
    task: CharacterDraft['tasks'][number],
    personaId: string,
    conversationId: string,
    enabled: boolean,
  ) {
    const settings = { ...task.settings, enabled, personaId, conversationId };
    if ('reportConversationId' in settings) settings.reportConversationId = conversationId;
    return this.scope().capabilities.invoke('core.automation.types@1', task.type, {
      action: 'save',
      id: task.id,
      settings,
    });
  }
  async exportPackage(personaId: string, name: string, version: string) {
    const draft = await this.read(personaId),
      catalog = await this.catalog();
    const features = (
      await Promise.all(
        draft.features.map(async (id) => {
          const spec = catalog.features.find((f) => f.id === id);
          invariant(spec, 'package_plugin', '请先启用角色所用的插件再导出角色包：' + id);
          const assets = (await this.feature(id, 'pack', personaId)).assets;
          return {
            id,
            version: spec.version,
            configuration: portableConfiguration(spec.fields, draft.configurations[id] ?? {}),
            ...(Object.keys(assets ?? {}).length ? { assets } : {}),
          };
        }),
      )
    ).filter(Boolean);
    const tasks = draft.tasks.map((task, index) => {
      const type = catalog.taskTypes.find((t) => t.id === task.type);
      return {
        id: task.templateId ?? 'task-' + index,
        type: task.type,
        settings: portableTaskSettings(type?.fields ?? [], task.settings),
      };
    });
    return characterPackage.parse({
      format: 'echo-character-v1',
      id: name,
      version,
      name: draft.persona.name,
      persona: draft.persona,
      features,
      tasks,
    });
  }
  async importPackage(raw: unknown) {
    const pack = characterPackage.parse(raw),
      catalog = await this.catalog(),
      features = pack.features
        .filter((feature) => !applicationOnlyCharacterFeatures.has(feature.id))
        .map((feature) => {
          if (feature.id !== 'memory') return feature;
          const { profileId: _legacyPrivateModel, ...configuration } = feature.configuration;
          return { ...feature, configuration };
        });
    const missing = features
      .filter((f) => !catalog.features.some((p) => p.id === f.id && p.version === f.version))
      .map((f) => f.id);
    if (missing.length)
      return {
        missing,
        draft: characterDraft.parse({ persona: { ...pack.persona, id: randomUUID() } }),
      };
    const assetConfigurations: Record<string, Record<string, unknown>> = {};
    for (const feature of features)
      if (feature.assets && Object.keys(feature.assets).length)
        assetConfigurations[feature.id] = (
          (await this.scope().capabilities.invoke(characterPoint, feature.id + '.character', {
            action: 'unpack',
            assets: feature.assets,
          })) as any
        ).value;
    const draft = characterDraft.parse({
      persona: { ...pack.persona, id: randomUUID() },
      features: features.map((f) => f.id),
      configurations: Object.fromEntries(
        features.map((f) => {
          const spec = catalog.features.find((p) => p.id === f.id);
          const configuration = f.configuration;
          invariant(
            isDeepStrictEqual(
              portableConfiguration(spec?.fields ?? [], configuration),
              configuration,
            ),
            'package_resource',
            '角色包包含需要在本机绑定的资源配置，请先移除这些字段。',
          );
          return [f.id, { ...configuration, ...assetConfigurations[f.id] }];
        }),
      ),
      tasks: pack.tasks.map((t) => {
        const type = catalog.taskTypes.find((type) => type.id === t.type);
        invariant(
          isDeepStrictEqual(portableTaskSettings(type?.fields ?? [], t.settings), t.settings),
          'package_resource',
          '任务模板包含需要在本机绑定的资源配置。',
        );
        return {
          ...t,
          templateId: t.id,
          id: randomUUID(),
          settings: { ...type?.defaults, ...t.settings, enabled: false },
        };
      }),
      package: {
        id: pack.id,
        version: pack.version,
        baseline: {
          ...pack,
          features: features.map(({ assets, ...feature }) => ({
            ...feature,
            configuration: feature.configuration,
          })),
        },
        resolved: Object.fromEntries(
          features.map((f) => [f.id, { ...f.configuration, ...assetConfigurations[f.id] }]),
        ),
      },
    });
    return { draft, missing };
  }
  async updatePackage(personaId: string, raw: unknown) {
    const current = await this.read(personaId),
      next = await this.importPackage(raw);
    if (next.missing.length) return { missing: next.missing, draft: current };
    invariant(
      current.package?.id === next.draft.package?.id,
      'package_identity',
      '请选择此角色已安装的角色包。',
    );
    const old = characterPackage.parse(current.package!.baseline);
    const parsedIncoming = characterPackage.parse(raw);
    const incoming = {
      ...parsedIncoming,
      features: parsedIncoming.features.filter(
        (feature) => !applicationOnlyCharacterFeatures.has(feature.id),
      ),
    };
    const merge = (base: any, local: any, remote: any): any => {
      if (isDeepStrictEqual(local, base)) return remote;
      if ([base, local, remote].every((v) => v && typeof v === 'object' && !Array.isArray(v)))
        return Object.fromEntries(
          [...new Set([...Object.keys(local), ...Object.keys(remote)])]
            .map((key) => [key, merge(base[key], local[key], remote[key])])
            .filter(([, value]) => value !== undefined),
        );
      return local;
    };
    const configurations = { ...current.configurations };
    for (const f of incoming.features)
      configurations[f.id] = merge(
        current.package?.resolved?.[f.id] ??
          old.features.find((row) => row.id === f.id)?.configuration ??
          {},
        current.configurations[f.id] ?? {},
        next.draft.configurations[f.id],
      );
    const tasks = [...current.tasks];
    for (const task of next.draft.tasks) {
      const index = tasks.findIndex(
        (t) => t.templateId === task.templateId && t.type === task.type,
      );
      if (index < 0) tasks.push(task);
      else
        tasks[index] = {
          ...tasks[index],
          settings: merge(
            old.tasks.find((t) => t.id === task.templateId)?.settings ?? {},
            tasks[index].settings,
            task.settings,
          ),
        };
    }
    return {
      missing: next.missing,
      draft: characterDraft.parse({
        ...current,
        persona: {
          ...merge(
            old.persona,
            personaSchema.omit({ id: true }).parse(current.persona),
            incoming.persona,
          ),
          id: personaId,
        },
        features: [
          ...new Set([
            ...current.features,
            ...incoming.features
              .filter((f) => !old.features.some((o) => o.id === f.id))
              .map((f) => f.id),
          ]),
        ],
        configurations,
        tasks,
        package: next.draft.package,
      }),
    };
  }
  activate(ctx: PluginContext) {
    this.ctx = ctx;
    ctx.dispose(() => {
      this.ctx = undefined;
    });
    const op = (
      name: string,
      description: string,
      input: z.ZodType,
      run: (value: any, signal: AbortSignal) => unknown,
    ) =>
      ctx.registry.register({
        name: 'persona.' + name,
        owner: 'persona',
        description,
        input,
        output: z.unknown(),
        permission: 'persona.write',
        mcp: false,
        run: (v, _c, signal) => run(v, signal),
      });
    op('character.catalog', '读取角色创建与编辑能力', z.object({}), () => this.catalog(true));
    op('character.read', '读取角色完整配置', z.object({ id }), (v) => this.read(v.id));
    op(
      'character.workspace',
      '校验工作目录或创建角色的默认工作目录',
      z.object({ id, path: z.string().min(1).max(4096).optional() }),
      async (v) => ({
        path: v.path
          ? projectRoot(v.path, dirname(this.store.path))
          : await ensureCharacterWorkspace(dirname(this.store.path), v.id),
      }),
    );
    op('character.draft', '保存角色创建草稿', characterDraft.extend({ edits: characterEdits.optional() }), v => {
      this.store.put('character-drafts', v.persona.id, v);
      return v;
    });
    op('character.patch', '保存已修改的角色配置', z.object({ id, changes: characterEdits, requestId:id }),
      (v,s) => this.commit(undefined,v.requestId,s,{ id:v.id, changes:v.changes }));
    op('character.drafts', '读取角色创建草稿', z.object({}), () =>
      this.store.documents('character-drafts'),
    );
    op(
      'character.commit',
      '创建或更新角色及其绑定任务',
      z.object({ draft: characterDraft, requestId: id, createOnly:z.boolean().optional() }),
      (v, s) => this.commit(v.draft, v.requestId, s, undefined, v.createOnly),
    );
    op(
      'package.export',
      '导出可分享的角色包',
      z.object({ personaId: id, packageId: id, version: z.string() }),
      (v) => this.exportPackage(v.personaId, v.packageId, v.version),
    );
    op('package.import', '预览角色包并创建待配置草稿', characterPackage, (v) =>
      this.importPackage(v),
    );
    op(
      'package.update',
      '预览角色包更新并保留本地覆盖',
      z.object({ personaId: id, package: characterPackage }),
      (v) => this.updatePackage(v.personaId, v.package),
    );
  }
}
