import { editedCharacter } from '../../plugins/persona/character-edits.ts';
import { configuredTimezone } from '../../packages/kernel/time.ts';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import legacy from './starter-legacy.json' with { type: 'json' };
import { hash, installStickers, originalPet, retireStarterPets, portrait, starterPet, starterRoleId } from './starter-art.ts';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { internal } from '../../packages/kernel/registry.ts';
import { characterDraft } from '../../plugins/persona/character-contracts.ts';
import type { Application } from './application.ts';
import { starterCharacters, starterSourcePrompts, starterStudio } from './starter-content.ts';
import { refreshStarterDraft, refreshStarterGroup, starterDefaults } from './starter-refresh.ts';
import { inferenceTasks } from '../../packages/contracts/inference.ts';
import { defaultPermissions } from '../../packages/kernel/tool-access.ts';

const characters = starterCharacters;
export const starterVersion = '4.0.0';
const featureIds = [
  'memory',
  'avatar',
  'care',
  'review',
  'observation',
  'agenda',
  'mail',
  'mail-triggers',
  'reflections',
  'delegation',
  'chatstick',
];

/** Bundled examples compose the same public role/task contracts used by the editor.
 * No startup seeding, credentials, model requests or private data. */
export function registerStarterCharacters(app: Application) {
  const assets = [
    join(app.project, 'apps/workbench/public/assets/starter-characters'),
    join(app.project, 'dist/web/assets/starter-characters'),
  ].find(existsSync)!;
  let creating = false;
  const op = (name: string, input: z.ZodType, run: (value: any, signal: AbortSignal) => unknown) =>
    app.registry.register({
      name,
      owner: 'core',
      description: '内置示例伙伴与双人工作室',
      input,
      output: z.unknown(),
      permission: 'persona.write',
      mcp: false,
      run: (value, _caller, signal) => run(value, signal),
    });
  op('characters.examples.list', z.object({}), () => ({
    characters: characters.map(({ id, name, description }) => ({
      id,
      name,
      description,
      portrait: `/assets/starter-characters/${id}/portrait.webp`,
      preview: `/assets/starter-characters/${id}/full.webp`,
      roleId: starterRoleId(app,id),
    })),
    author: 'Echo',
    license: 'Apache-2.0',
    source: '/assets/starter-characters/CREDITS.txt',
    plugins: featureIds,
    version: starterVersion,
    existing: app.store.get('starter.studio.v1', null),
  }));
  op('characters.examples.refresh', z.object({ requestId: id }), async (value, signal) => {
    invariant(!creating, 'examples_busy', '示例伙伴正在更新。');
    const completed = app.store.get<any>('starter.studio.v1', null);
    creating = true;
    try {
      const changes = [];
      for (const example of characters) {
        const roleId = starterRoleId(app,example.id);
        const pkg=app.store.document<any>('characters',roleId)?.package;
        if(!pkg || !['echo-starter-'+example.id,'echo-starter-'+legacy[example.id].legacyId].includes(pkg.id)) continue;
        if (pkg.version===starterVersion && !app.store.get('starter.art.pending.'+roleId,false)) continue;
        const current = (await app.registry.call(
          'persona.character.read',
          { id: roleId },
          internal,
          signal,
        )) as any;
        const { draft, updated, preserved } = refreshStarterDraft(current, example, starterVersion);
        const older = legacy[example.id];
        const folder = join(assets,example.id);
        if (current.persona.name === older.legacyName) draft.persona.name=example.name;
        if (current.persona.portrait?.startsWith('data:image/webp;base64,') &&
          hash(Buffer.from(current.persona.portrait.split(',')[1],'base64'))===older.portrait)
          draft.persona.portrait=await portrait(folder);
        const pending=app.store.get<Record<string,boolean>>('starter.art.pending.'+roleId,{}) || {};
        if(pkg.id==='echo-starter-'+older.legacyId) { pending.avatar=true; pending.chatstick=true; }
        if(pending.avatar && app.plugins.active.has('avatar')){
          const cfg=draft.configurations.avatar;
          if(cfg && (cfg.renderer??'frames')==='frames' && ((pending.new && !cfg.assetDirectory) || await originalPet(app,example.id,String(cfg.assetDirectory??'')))){
            cfg.assetDirectory=await starterPet(app,folder,example.name,signal);
            cfg.animationClips={idle:'idle',working:'idle',speaking:'idle'};
            cfg.stateRules=Object.fromEntries(Object.entries(cfg.stateRules??{}).map(([key,rule]:[string,any])=>[key,{...rule,clip:'idle'}]));
          }
          delete pending.avatar;
        }
        if(pending.chatstick && app.plugins.active.has('chatstick')){
          await installStickers(app,example.id,roleId,folder,signal,!pending.new);
          delete pending.chatstick;
        }

        await app.registry.call(
          'persona.character.patch',
          {
            id:roleId,
            changes:editedCharacter(characterDraft.parse(current), characterDraft.parse(draft),new Set()),
            requestId: value.requestId + '-refresh-' + example.id,
          },
          internal,
          signal,
        );
        const main=app.store.conversation(current.mainConversationId);
        if(main?.title===older.legacyName && draft.persona.name===example.name)
          app.store.saveConversation({...main,title:example.name});
        app.store.set('starter.art.pending.'+roleId,pending.avatar || pending.chatstick ? pending : false);
        changes.push({ id: roleId, updated, preserved });
      }
      if(changes.length && app.plugins.active.has('avatar')) await retireStarterPets(app);
      const group = completed?.groupId && app.store.document<any>('groups', completed.groupId);
      if (group) {
        const next = refreshStarterGroup(group, completed.groupDefaults);
        if (group.prompt !== next.prompt || group.context !== next.context)
          await app.registry.call('groups.save', next, internal, signal);
      }
      const result = { ...completed, version: starterVersion, groupDefaults: starterStudio };
      if(completed) app.store.set('starter.studio.v1', result);
      app.events.emit('characters.updated', {});
      return { ...result, changes };
    } finally {
      creating = false;
    }
  });
  op(
    'characters.examples.create',
    z.object({ profileId: id, requestId: id, characterId: z.enum(['aria', 'coda']).optional(), pairOnly:z.boolean().optional(), updateExisting: z.literal(true).optional() }),
    async (value, signal) => {
      const completed = app.store.get<any>('starter.studio.v1', null);
      if (completed && !value.characterId && !value.updateExisting) return completed;
      // Backward compatible entry point; refreshing content never reconfigures a role.
      if (completed && value.updateExisting)
        return app.registry.call(
          'characters.examples.refresh',
          { requestId: value.requestId },
          internal,
          signal,
        );
      invariant(!creating, 'examples_busy', '示例伙伴正在创建。');
      invariant(assets, 'examples_missing', '示例素材缺失，请重新安装完整应用。');
      const model = app.router.inference.models().find((model) => model.id === value.profileId);
      invariant(
        model && app.router.inference.eligibility(model).conversation,
        'examples_model',
        '请选择可用于主会话的语言模型。',
      );
      creating = true;
      try {
        const toolPermissions = defaultPermissions.filter(permission => app.plugins.characterPermissions().has(permission));
        const catalog = (await app.registry.call(
          'persona.character.catalog',
          {},
          internal,
          signal,
        )) as any;
        const availableFeatures = featureIds.filter(id => catalog.features.some((feature: any) => feature.id === id));
        const roles: string[] = [];
        for (const example of characters.filter(role => !value.characterId || role.id === value.characterId)) {
          signal.throwIfAborted();
          const roleId = starterRoleId(app,example.id);
          const existing = app.store.document<any>('characters', roleId);
          invariant(
            !existing || existing.package?.id === 'echo-starter-' + example.id,
            'example_conflict',
            '示例伙伴编号已被使用。',
          );
          if (existing?.state === 'ready' && !value.updateExisting) {
            if(app.store.get('starter.new.stickers.'+roleId,false) && availableFeatures.includes('chatstick')){
              await installStickers(app,example.id,roleId,join(assets,example.id),signal);
              app.store.set('starter.new.stickers.'+roleId,false);
            }
            roles.push(roleId);
            continue;
          }
          const previous =
            existing?.state === 'ready'
              ? ((await app.registry.call(
                  'persona.character.read',
                  { id: roleId },
                  internal,
                  signal,
                )) as any)
              : undefined;
          const folder=join(assets,example.id);
          const directory=availableFeatures.includes('avatar') ? await starterPet(app,folder,example.name,signal) : undefined;
          const tasks = [
            {
              id: roleId + '-review',
              type: 'review.policies',
              settings: {
                name: '每日记忆整理',
                mode: 'daily',
                hour: 22,
                minute: 0,
                sourceIds: ['core.conversation'],
                conversationScope: 'selected',
                conversationIds: [previous?.mainConversationId ?? 'main-' + roleId],
                reasoning: 'off',
                autoApply: true,
                prompt: example.review,
                memoryPrompt: example.memory,
                corePrompt: example.core,
                sourcePrompts: starterSourcePrompts,
                sourceStreams: { 'observation.source': [roleId + '-observe'] },
                targetIds: ['reflections.state'],
                targetPrompts: { 'reflections.state': example.concern },
                memoryOperations: ['add', 'update', 'archive', 'propose-core'],
                reportPrompt: example.report,
              },
            },
            {
              id: roleId + '-care',
              type: 'care.rules',
              settings: {
                name: '日常交流',
                mode: 'opportunities',
                dailyMax: 1,
                minMinutes: 120,
                humanQuietMinutes: 15,
                hourStart: 10,
                hourEnd: 21,
                prompt: example.care,
              },
            },
            {
              id: roleId + '-observe',
              type: 'observation.tasks',
              settings: {
                name: '一起看',
                minBubbleSeconds: 300,
                visionReasoning: 'off',
                interactionReasoning: 'inherit',
                interactionPrompt: example.interaction,
                observationPrompt: example.observation,
              },
            },
            {
              id: roleId + '-mail',
              type: 'mail-triggers.rules',
              settings: {
                name: '新邮件提醒',
                rules:
                  example.id === 'aria'
                    ? [
                        {
                          name: '约定与重要事项',
                          match: 'subject',
                          terms:
                            '会议邀请\n日程变更\n需要确认\n截止日期\nmeeting invitation\naction required\ndeadline',
                        },
                      ]
                    : [
                        {
                          name: '新鲜事与邀请',
                          match: 'subject',
                          terms:
                            '活动邀请\n版本更新\n测试邀请\n作品发布\nrelease notes\nbeta invitation\nevent invitation',
                        },
                      ],
                remindAll: false,
                useLegacyFilters: false,
                action: 'conversation',
                reasoning: 'off',
                prompt: example.mail,
              },
            },
          ].filter(task => catalog.taskTypes.some((type: any) => type.id === task.type && availableFeatures.includes(type.owner))).map((task) => ({
            ...task,
            settings: {
              ...catalog.taskTypes.find((entry: any) => entry.id === task.type)?.defaults,
              ...previous?.tasks.find((entry: any) => entry.id === task.id)?.settings,
              ...task.settings,
              timezone: configuredTimezone(app.store),
              enabled:
                previous?.tasks.find((entry: any) => entry.id === task.id)?.settings.enabled ??
                false,
            },
          }));
          const workspace =
            previous?.permissions.projectDirectory ||
            join(dirname(app.store.path) + '-workspaces', roleId);
          await mkdir(workspace, { recursive: true });
          const draft = characterDraft.parse({
            revision: previous?.revision ?? 0,
            persona: {
              id: roleId,
              name: example.name,
              prompt: example.prompt,
              expression: example.expression,
              portrait: await portrait(folder),
            },
            features: availableFeatures,
            profileId: value.profileId,
            reasoning: 'off',
            routes: {
              ...(availableFeatures.includes('memory') && { [inferenceTasks.query]: value.profileId }),
            },
            permissions: {
              projectDirectory: workspace,
              pi: { tools: 'ask', projectWrite: true, terminal: false },
            },
            configurations: {
              mail: previous?.configurations.mail ?? { accountIds: [] },
              memory: {
                queryMethod: 'memory.model',
                retrievalMethod: 'semantic.hybrid',
                fallback: 'keyword',
                reasoning: 'off',
                queryPrompt: example.query,
              },
              reflections: { inject: true, maxNotes: 6, maxChars: 2400 },
              chatstick: {
                channels: {
                  'core.chat': true,
                  'avatar.bubble': true,
                  'notifications.inbox': false,
                },
              },
              delegation: {
                authorizationVersion: 3,
                autonomous: true,
                concurrency: 1,
                prompt: example.delegation,
                reportOnCompletion: true,
                reportPrompt: example.handoff,
                allowedProfileIds: [],
                workspaces: [{ path: workspace, write: true }],
                toolPermissions,
                approvals: 'ask',
                terminal: false,
                timeoutMinutes: previous?.configurations.delegation?.timeoutMinutes ?? 0,
              },
              avatar: {
                ...previous?.configurations.avatar,
                enabled: previous?.configurations.avatar.enabled ?? false,
                renderer: 'frames',
                assetDirectory: directory,
                fps: 1,
                animationClips: {idle:'idle',working:'idle',speaking:'idle'},
              },
            },
            tasks,
            toolPermissions,
            package: {
              id: 'echo-starter-' + example.id,
              version: starterVersion,
              baseline: {
                format: 'echo-character-v1',
                id: 'echo-starter-' + example.id,
                version: starterVersion,
                name: example.name,
                persona: { name: example.name, prompt: example.prompt },
                features: [],
                tasks: [],
                starterDefaults: starterDefaults(example),
              },
            },
          });
          if(availableFeatures.includes('chatstick')) app.store.set('starter.new.stickers.'+roleId,true);
          await app.registry.call(
            'persona.character.commit',
            { draft, requestId: value.requestId + '-starter-role-' + example.id },
            internal,
            signal,
          );
          if (availableFeatures.includes('chatstick')) {
            await installStickers(app,example.id,roleId,folder,signal);
            app.store.set('starter.new.stickers.'+roleId,false);
          }
          if(!availableFeatures.includes('chatstick') || !availableFeatures.includes('avatar'))
            app.store.set('starter.art.pending.'+roleId,{new:true,avatar:!availableFeatures.includes('avatar'),chatstick:!availableFeatures.includes('chatstick')});
          roles.push(roleId);
        }
        if (value.characterId || value.pairOnly) {
          app.events.emit('characters.updated', {});
          return { roles, version: starterVersion, profileId: value.profileId };
        }
        const groupId = 'example-studio';
        if (app.plugins.active.has('groups') && !app.store.document('groups', groupId))
          await app.registry.call(
            'groups.save',
            {
              id: groupId,
              name: '双人工作室',
              members: roles,
              historyWindow: 40,
              ...starterStudio,
            },
            internal,
            signal,
          );
        const result = {
          roles,
          ...(app.store.document('groups',groupId) ? {groupId} : {}),
          version: starterVersion,
          profileId: value.profileId,
          groupDefaults: starterStudio,
        };
        app.store.set('starter.studio.v1', result);
        app.events.emit('characters.updated', {});
        return result;
      } finally {
        creating = false;
      }
    },
  );
}
