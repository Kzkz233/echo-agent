import { configuredTimezone } from '../../packages/kernel/time.ts';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { internal } from '../../packages/kernel/registry.ts';
import { characterDraft } from '../../plugins/persona/character-contracts.ts';
import type { Application } from './application.ts';
import { starterCharacters, starterSourcePrompts, starterStudio } from './starter-content.ts';
import { refreshStarterDraft, refreshStarterGroup, starterDefaults } from './starter-refresh.ts';
import { ensureStarterModels } from './bundled-models.ts';
import { inferenceTasks } from '../../packages/contracts/inference.ts';
import { defaultPermissions } from '../../packages/kernel/tool-access.ts';

const characters = starterCharacters;
export const starterVersion = '3.0.0';
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
      description: '内置示例角色与双人工作室',
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
      preview: `/assets/starter-characters/${id}/preview.png`,
    })),
    author: 'Ryu JaeHyun',
    license: 'CC BY 4.0',
    source: 'https://github.com/springtiger07/codex-chibi-girl-pets',
    plugins: featureIds,
    version: starterVersion,
    existing: app.store.get('starter.studio.v1', null),
  }));
  op('characters.examples.refresh', z.object({ requestId: id }), async (value, signal) => {
    invariant(!creating, 'examples_busy', '示例角色正在更新。');
    const completed = app.store.get<any>('starter.studio.v1', null);
    invariant(completed, 'examples_missing', '请先创建示例角色。');
    if (completed.version === starterVersion) return { ...completed, changes: [] };
    creating = true;
    try {
      const changes = [];
      for (const example of characters) {
        const roleId = 'example-' + example.id;
        if (!app.store.document('personas', roleId)) continue;
        const current = (await app.registry.call(
          'persona.character.read',
          { id: roleId },
          internal,
          signal,
        )) as any;
        const { draft, updated, preserved } = refreshStarterDraft(current, example, starterVersion);
        await app.registry.call(
          'persona.character.commit',
          {
            draft,
            requestId: value.requestId + '-refresh-' + example.id,
          },
          internal,
          signal,
        );
        changes.push({ id: roleId, updated, preserved });
      }
      const group = app.store.document<any>('groups', completed.groupId);
      if (group) {
        const next = refreshStarterGroup(group, completed.groupDefaults);
        if (group.prompt !== next.prompt || group.context !== next.context)
          await app.registry.call('groups.save', next, internal, signal);
      }
      const result = { ...completed, version: starterVersion, groupDefaults: starterStudio };
      app.store.set('starter.studio.v1', result);
      app.events.emit('characters.updated', {});
      return { ...result, changes };
    } finally {
      creating = false;
    }
  });
  op(
    'characters.examples.create',
    z.object({ profileId: id, requestId: id, updateExisting: z.literal(true).optional() }),
    async (value, signal) => {
      const completed = app.store.get<any>('starter.studio.v1', null);
      if (completed && !value.updateExisting) return completed;
      // Backward compatible entry point; refreshing content never reconfigures a role.
      if (completed && value.updateExisting)
        return app.registry.call(
          'characters.examples.refresh',
          { requestId: value.requestId },
          internal,
          signal,
        );
      invariant(!creating, 'examples_busy', '示例角色正在创建。');
      invariant(assets, 'examples_missing', '示例素材缺失，请重新安装完整应用。');
      const model = app.router.inference.models().find((model) => model.id === value.profileId);
      invariant(
        model &&
          app.router.inference.supports(model, {
            operation: 'generate',
            inputs: ['text', 'image'],
          }),
        'examples_model',
        '请选择支持语言与图像的模型，供主会话、观察与辅助推理共同使用。',
      );
      creating = true;
      try {
        const pluginIds = [...app.plugins.plugins.values()]
          .filter(
            (plugin) =>
              plugin.distribution !== 'local' && plugin.manifest.package?.startsWith('@echo/'),
          )
          .map((plugin) => plugin.manifest.id);
        for (const pluginId of pluginIds) {
          signal.throwIfAborted();
          await app.registry.call(
            'plugins.enable',
            { id: pluginId, enabled: true },
            internal,
            signal,
          );
        }
        await ensureStarterModels(app, value.profileId);
        const toolPermissions = [
          ...new Set([
            ...defaultPermissions,
            ...app.registry
              .list(internal, true)
              .filter((operation) => pluginIds.includes(operation.owner))
              .map((operation) => operation.permission),
          ]),
        ];
        // The user explicitly invokes the full example setup; role grants remain separate.
        app.store.set('mcp.permissions', [
          ...new Set([...app.store.get('mcp.permissions', defaultPermissions), ...toolPermissions]),
        ]);
        const catalog = (await app.registry.call(
          'persona.character.catalog',
          {},
          internal,
          signal,
        )) as any;
        const roles: string[] = [];
        for (const example of characters) {
          signal.throwIfAborted();
          const roleId = 'example-' + example.id;
          const existing = app.store.document<any>('characters', roleId);
          invariant(
            !existing || existing.package?.id === 'echo-starter-' + example.id,
            'example_conflict',
            '示例角色编号已被使用。',
          );
          if (existing?.state === 'ready' && !value.updateExisting) {
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
          const material = (await app.registry.call(
            'avatar.import',
            {
              source: join(assets, example.id),
              name: example.name,
              fps: 8,
              requestId:
                'starter-asset-' +
                example.id +
                '-' +
                createHash('sha256')
                  .update(await readFile(join(assets, example.id, 'manifest.json')))
                  .digest('hex')
                  .slice(0, 16),
            },
            internal,
            signal,
          )) as any;
          const tasks = [
            {
              id: roleId + '-review',
              type: 'review.policies',
              settings: {
                name: '每日记忆整理',
                mode: 'daily',
                hour: 22,
                minute: 0,
                sourceIds: ['core.conversation', 'observation.source'],
                conversationScope: 'selected',
                conversationIds: [previous?.mainConversationId ?? 'main-' + roleId],
                profileId: value.profileId,
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
                visionProfileId: value.profileId,
                visionReasoning: 'off',
                interactionReasoning: 'off',
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
                  example.id === 'hina'
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
          ].map((task) => ({
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
              portrait:
                'data:image/webp;base64,' +
                (await readFile(join(assets, example.id, 'portrait.webp'))).toString('base64'),
            },
            features: featureIds,
            profileId: value.profileId,
            reasoning: 'off',
            routes: {
              [inferenceTasks.query]: value.profileId,
              [inferenceTasks.vision]: value.profileId,
              [inferenceTasks.review]: value.profileId,
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
                timeoutMinutes: 20,
              },
              avatar: {
                ...previous?.configurations.avatar,
                enabled: previous?.configurations.avatar.enabled ?? false,
                renderer: 'frames',
                assetDirectory: material.directory,
                fps: 8,
                animationClips: { idle: 'idle', working: 'running', speaking: 'waving' },
                stateRules: Object.fromEntries(
                  Object.entries({
                    idle: 'idle',
                    working: 'running',
                    speaking: 'waving',
                    waiting: 'waiting',
                    roaming: 'running-right',
                    dragging: 'running-right',
                    falling: 'jumping',
                    landing: 'idle',
                  }).map(([state, clip]) => ['avatar.' + state, { clip }]),
                ),
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
          await app.registry.call(
            'persona.character.commit',
            { draft, requestId: value.requestId + '-starter-role-' + example.id },
            internal,
            signal,
          );
          const manifest = JSON.parse(
            await readFile(join(assets, example.id, 'manifest.json'), 'utf8'),
          );
          const sharp = (await import('sharp')).default;
          for (const sticker of [
            { key: 'hello', label: '招呼', clip: 'waving', meaning: '轻松打招呼或表示收到' },
            {
              key: 'thinking',
              label: '想一想',
              clip: 'review',
              meaning: '好奇、认真思考或一起琢磨',
            },
            { key: 'celebrate', label: '开心', clip: 'jumping', meaning: '恰当的小小庆祝' },
          ]) {
            const frame = manifest.clips[sticker.clip]?.frames[0];
            invariant(frame, 'examples_assets', '示例表情动作素材缺失。');
            const data = await sharp(join(assets, example.id, manifest.image))
              .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
              .png()
              .toBuffer();
            await app.registry.call(
              'chatstick.save',
              {
                personaId: roleId,
                key: sticker.key,
                label: sticker.label,
                meaning: sticker.meaning,
                data: data.toString('base64'),
                replace: true,
              },
              internal,
              signal,
            );
          }
          roles.push(roleId);
        }
        const groupId = 'example-studio';
        if (!app.store.document('groups', groupId))
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
          groupId,
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
