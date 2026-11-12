import { deliveryPoint } from '../../packages/contracts/delivery.ts';
import { characterEnabled } from '../../packages/kernel/characters.ts';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { defineManifest, type Plugin, type PluginContext } from '../../packages/kernel/registry.ts';
import { join, dirname } from 'node:path';
import { workerTask } from '../../packages/kernel/worker-task.ts';
import { frameMaterialSchema } from '../../packages/contracts/avatar.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import packageManifest from './echo-plugin.json' with { type: 'json' };
import {
  avatarConfigSchema,
  displayAvatar,
  displayAvatars,
  frameMotion,
  roleAvatar,
  saveRoleAvatar,
} from './profiles.ts';
import { NativeAvatar } from './native.ts';
import { AvatarFleet } from './fleet.ts';
import { Router } from '../../packages/kernel/router.ts';
import { Events } from '../../packages/kernel/events.ts';
import { Clock } from '../../packages/kernel/clock.ts';
import { readReplyImage } from '../../packages/kernel/reply-images.ts';
import { packAvatar, unpackAvatar } from './package.ts';
import { avatarStates, defineAvatarStates } from './states.ts';
// v2 renderers supply a library to the shared host. v1 remains readable for
// installed extensions that still own a legacy executable.
export function avatarRendererPoint(context: PluginContext | undefined, renderer: string) {
  return (['avatar.renderers@2', 'avatar.renderers@1'] as const).find((point) =>
    context?.capabilities.list(point).some((p) => p.id === renderer && p.state === 'active'),
  );
}
export function avatarPlugin(
  store: Store,
  router: Router,
  events: Events,
  project: string,
  helper: string,
  clock: Clock,
): Plugin {
  let context: PluginContext | undefined;
  let importing = false;
  const native = new AvatarFleet(
    store,
    events,
    (personaId, slot) =>
      new NativeAvatar(
        store,
        router,
        events,
        project,
        helper,
        async () => {
          const cfg = displayAvatar(store, personaId);
          const bundled = existsSync(join(project, 'dist/web/assets/cute-girl/manifest.json'))
            ? join(project, 'dist/web/assets/cute-girl')
            : join(project, 'apps/workbench/public/assets/cute-girl');
          const fallback = {
            kind: 'frames' as const,
            directory: cfg.assetDirectory?.trim() || bundled,
          };
          if (!cfg.renderer || cfg.renderer === 'frames') return fallback;
          const point = avatarRendererPoint(context, cfg.renderer);
          if (!point)
            return { ...fallback, issue: '所选增强渲染器不可用，暂用基础帧动画；原选择已保留。' };
          return (await context!.capabilities.invoke(point, cfg.renderer, {
            personaId,
          })) as {
            kind: string;
            directory: string;
          };
        },
        (value) => context && readReplyImage(context.capabilities, value, context.signal),
        () => (context ? avatarStates(context, personaId) : Promise.resolve([])),
        personaId,
        slot,
      ),
  );
  return {
    config: { schema: avatarConfigSchema },
    manifest: defineManifest(packageManifest),
    references: (id) => {
      const avatar = displayAvatar(store);
      const saved = store.documents<{ conversationId?: string }>('avatar-profiles');
      return avatar.conversationId === id || saved.some((profile) => profile.conversationId === id)
        ? [
            {
              label: '桌宠回复',
              page: 'avatar',
              role: 'channel',
              enabled: avatar.conversationId === id && avatar.enabled,
            },
          ]
        : [];
    },
    character: {
      version: 1,
      schema: avatarConfigSchema.omit({ personaId: true, conversationId: true }),
      fields: defineManifest(packageManifest).settings.filter(
        (field) => !['conversationId', 'personaId'].includes(field.key),
      ),
      read: (personaId) => roleAvatar(store, personaId),
      pack: (personaId) => packAvatar(roleAvatar(store, personaId).assetDirectory, 'manifest.json'),
      unpack: (assets, signal) =>
        unpackAvatar(
          join(dirname(store.path), 'imports'),
          assets,
          'manifest.json',
          async (source) => {
            const asset = await workerTask<any>(
              project,
              'avatar-import-worker',
              'plugins/avatar/import-worker.ts',
              {
                source,
                name: 'Character package',
                fps: 10,
                root: join(dirname(store.path), 'avatar-assets'),
              },
              signal,
            );
            store.put('avatar-assets', asset.id, asset);
            return { assetDirectory: asset.directory, renderer: 'frames' };
          },
        ),
      save: (personaId, value) => {
        const main = store.document<{ mainConversationId: string }>(
          'characters',
          personaId,
        )?.mainConversationId;
        const result = saveRoleAvatar(store, personaId, {
          ...value,
          ...(main ? { conversationId: main } : {}),
        });
        events.emit('settings.changed', { pluginId: 'avatar' });
        return result;
      },
    },
    activate: (ctx) => {
      context = ctx;
      const { registry, dispose } = ctx;
      defineAvatarStates(ctx, store, router);
      registry.register({
        name: 'avatar.states',
        description: '读取可注册的桌宠状态',
        owner: 'avatar',
        permission: 'avatar.read',
        mcp: false,
        input: z.object({ personaId: id.optional() }),
        output: z.unknown(),
        run: ({ personaId }) => avatarStates(ctx, personaId),
      });
      registry.register({
        name: 'avatar.refresh',
        description: '通知桌宠重新读取活动状态',
        owner: 'avatar',
        permission: 'avatar.state',
        mcp: false,
        input: z.object({}),
        output: z.unknown(),
        run: () => native.refreshActivity(),
      });
      registry.register({
        name: 'avatar.profile',
        description: '读取角色的桌宠设置',
        owner: 'avatar',
        permission: 'avatar.read',
        mcp: false,
        input: z.object({ personaId: id }),
        output: avatarConfigSchema,
        run: ({ personaId }) => roleAvatar(store, personaId),
      });
      registry.register({
        name: 'avatar.clips',
        description: '列出角色帧素材中的动作',
        owner: 'avatar',
        permission: 'avatar.read',
        mcp: false,
        input: z.object({ personaId: id }),
        output: z.array(z.string()),
        run: async ({ personaId }) => {
          const profile = roleAvatar(store, personaId);
          const point = avatarRendererPoint(context, profile.renderer);
          if (profile.renderer !== 'frames' && point) {
            const selected = (await context!.capabilities.invoke(point, profile.renderer, {
              personaId,
            })) as any;
            if (selected.clips?.length) return selected.clips;
          }
          const root =
            profile.assetDirectory ||
            (existsSync(join(project, 'dist/web/assets/cute-girl/manifest.json'))
              ? join(project, 'dist/web/assets/cute-girl')
              : join(project, 'apps/workbench/public/assets/cute-girl'));
          const file = join(root, 'manifest.json');
          invariant((await stat(file)).size <= 2000000, 'avatar_manifest', '帧素材描述文件过大。');
          return [
            ...new Set([
              'idle',
              ...Object.keys(JSON.parse(await readFile(file, 'utf8')).clips ?? {}),
            ]),
          ]
            .filter((key) => /^[\w.-]{1,80}$/.test(key))
            .slice(0, 40);
        },
      });
      registry.register({
        name: 'avatar.configureRole',
        description: '保存当前角色的桌宠配置；其他角色的桌宠保持独立',
        owner: 'avatar',
        permission: 'avatar.write',
        mcp: false,
        input: z.object({
          personaId: id,
          patch: z.object({
            enabled: z.boolean().optional(),
            renderer: z.string().optional(),
            conversationId: z.string().optional(),
            animationClips: frameMotion.optional(),
            stateRules: avatarConfigSchema.shape.stateRules.optional(),
            roam: z.boolean().optional(),
            corner: avatarConfigSchema.shape.corner.unwrap().optional(),
            scale: avatarConfigSchema.shape.scale.unwrap().optional(),
            fps: avatarConfigSchema.shape.fps.unwrap().optional(),
            bubbleSeconds: avatarConfigSchema.shape.bubbleSeconds.unwrap().optional(),
          }),
        }),
        output: avatarConfigSchema,
        run: ({ personaId, patch }) => {
          const profile = saveRoleAvatar(store, personaId, patch);
          events.emit('settings.changed', { pluginId: 'avatar' });
          return profile;
        },
      });
      registry.register({
        name: 'avatar.setVisible',
        description: '临时显示或收起所有已配置桌宠，不改变角色启用和桌宠配置',
        owner: 'avatar',
        permission: 'avatar.write',
        mcp: false,
        input: z.object({ visible: z.boolean() }),
        output: z.object({ visible: z.boolean() }),
        run: async ({ visible }) => {
          store.set('avatar.hidden', !visible);
          await native.update();
          return { visible };
        },
      });
      registry.register({
        name: 'avatar.assets',
        description: '已导入的桌宠素材',
        owner: 'avatar',
        permission: 'avatar.read',
        mcp: false,
        input: z.object({}),
        output: z.array(frameMaterialSchema),
        run: () => store.documents('avatar-assets'),
      });
      registry.register({
        name: 'avatar.select',
        description: '选择已导入或内置帧动画素材',
        owner: 'avatar',
        permission: 'avatar.write',
        mcp: false,
        input: z.object({ id: z.string().default(''), personaId: id.optional() }),
        output: z.object({ selected: z.string(), kind: z.literal('frames') }),
        run: (v) => {
          const asset = v.id ? store.document<any>('avatar-assets', v.id) : undefined;
          invariant(
            !v.id || asset?.format === 'frame-atlas-v1',
            'avatar_asset_missing',
            '帧动画素材不存在',
          );
          const patch = { renderer: 'frames', assetDirectory: asset?.directory ?? '' };
          if (v.personaId) saveRoleAvatar(store, v.personaId, patch);
          else store.set('avatar.config', { ...store.get<any>('avatar.config', {}), ...patch });
          events.emit('settings.changed', { pluginId: 'avatar' });
          return { selected: v.id, kind: 'frames' };
        },
      });
      registry.register({
        name: 'avatar.import',
        description: '本地导入图片、PNG 帧序列或 ZIP 图集',
        owner: 'avatar',
        permission: 'avatar.write',
        mcp: false,
        input: z.object({
          source: z.string().min(1),
          name: z.string().max(160).optional(),
          fps: z.number().int().min(1).max(30).default(10),
          requestId: id,
        }),
        output: frameMaterialSchema,
        run: async (v, _c, signal) => {
          const signature = createHash('sha256')
            .update(JSON.stringify([v.source, v.name ?? '', v.fps]))
            .digest('hex');
          const receipt = store.get<any>('avatar.import.' + v.requestId, null);
          if (receipt) {
            invariant(
              receipt.signature === signature,
              'idempotency_conflict',
              '同一请求编号不能导入不同素材',
            );
            return store.document('avatar-assets', receipt.id);
          }
          invariant(!importing, 'avatar_import_busy', '已有素材正在导入');
          importing = true;
          try {
            const result = await workerTask<any>(
              project,
              'avatar-import-worker',
              'plugins/avatar/import-worker.ts',
              { ...v, root: join(dirname(store.path), 'avatar-assets') },
              AbortSignal.any([signal, ctx.signal]),
            );
            signal.throwIfAborted();
            ctx.signal.throwIfAborted();
            store.put('avatar-assets', result.id, result);
            store.set('avatar.import.' + v.requestId, { signature, id: result.id });
            events.emit('avatar.assets.changed', {});
            return result;
          } finally {
            importing = false;
          }
        },
      });
      const deliveryState = (messageId: string) => {
        const receipt = store.receipt('bubble-' + messageId);
        return {
          state:
            receipt?.state === 'shown' || receipt?.state === 'dismissed'
              ? 'delivered'
              : receipt?.state === 'pending' || receipt?.state === 'claimed'
                ? 'queued'
                : receipt?.state === 'expired'
                  ? 'failed'
                  : 'unknown',
          receipt,
        };
      };
      ctx.capabilities.provide(deliveryPoint, 'avatar.outputs', '桌宠气泡', async (input) => {
        if (input.action === 'list')
          return {
            targets: [
              {
                id: 'avatar.bubble',
                label: '桌宠气泡',
                revision: '1',
                portable: true,
                supportsImages: true,
                presentation: 'bubble',
                style: 'bubble',
                ready: characterEnabled(store, input.personaId, 'avatar'),
                issue: roleAvatar(store, input.personaId).enabled
                  ? undefined
                  : '桌宠未显示，气泡会短暂排队。',
              },
            ],
          };
        const envelope = input.envelope;
        const messageId = envelope.messageId ?? 'output.' + envelope.id;
        const key = 'bubble-' + messageId;
        if (input.action === 'deliver' && !store.receipt(key))
          store.saveReceipt(key, {
            kind: 'bubble',
            state: 'pending',
            conversationId: envelope.conversationId,
            messageId,
            text: [envelope.title, envelope.text].filter(Boolean).join('\n'),
            createdAt: new Date().toISOString(),
          });
        if (input.action === 'deliver') await native.pump(envelope.personaId);
        const result = deliveryState(messageId);
        return {
          result:
            result.receipt?.state === 'expired'
              ? { ...result, state: 'skipped', reason: '气泡已过期。' }
              : result,
        };
      });
      ctx.capabilities.provide('channels.send@1', 'avatar.bubble', 'Desktop bubble', async (v) => {
        const message = store.message(v.messageId);
        invariant(
          message && message.conversationId === v.conversationId && message.text === v.text,
          'message_identity',
          '气泡必须对应规范会话中的原文',
        );
        const key = 'bubble-' + message.id;
        if (!store.receipt(key))
          store.saveReceipt(key, {
            kind: 'bubble',
            state: 'pending',
            conversationId: message.conversationId,
            messageId: message.id,
            text: message.text,
            createdAt: new Date().toISOString(),
          });
        await native.pump();
        return deliveryState(message.id);
      });
      ctx.capabilities.provide(
        'channels.inspect@1',
        'avatar.bubble',
        'Inspect bubble receipt',
        (v) => deliveryState(v.messageId),
      );
      ctx.capabilities.define({
        id: 'avatar.renderers@1',
        description:
          'Optional character renderer; bubbles, input and conversation ownership remain in Avatar',
        input: z.object({ personaId: id.optional() }),
        output: z.object({
          kind: z.string().min(1),
          directory: z.string().min(1),
          executable: z.string().optional(),
          clips: z.array(z.string()).optional(),
          stateClips: z.record(z.string(), z.string()).optional(),
        }),
        providePermission: 'avatar.renderer',
        consumePermission: 'avatar.render',
        cardinality: 'one',
      });
      ctx.capabilities.define({
        id: 'avatar.renderers@2',
        description:
          'Optional native renderer library; the base host owns all windows, bubbles, input and receipts',
        input: z.object({ personaId: id.optional() }),
        output: z.object({
          kind: z
            .string()
            .min(1)
            .refine((kind) => kind !== 'frames'),
          directory: z.string().min(1),
          library: z.string().min(1),
          abi: z.literal(1),
          clips: z.array(z.string()).optional(),
          stateClips: z.record(z.string(), z.string()).optional(),
        }),
        providePermission: 'avatar.renderer',
        consumePermission: 'avatar.render',
        cardinality: 'one',
      });
      ctx.capabilities.define({
        id: 'avatar.materials@1',
        description: 'Optional renderer material libraries and import controls',
        input: z.object({}),
        output: z.object({
          renderer: id,
          family: id,
          directoryField: id,
          configurationField: id.optional(),
          label: z.string(),
          format: z.string(),
          builtinLabel: z.string(),
          hint: z.string().optional(),
          preview: z.boolean().default(false),
          fps: z.boolean().default(false),
        }),
        providePermission: 'avatar.renderer',
        consumePermission: 'avatar.render',
        cardinality: 'many',
      });
      registry.register({
        name: 'avatar.materials',
        description: '读取已注册渲染器的素材管理方式',
        owner: 'avatar',
        permission: 'avatar.read',
        mcp: false,
        input: z.object({}),
        output: z.array(z.unknown()),
        run: async () =>
          Promise.all(
            ctx.capabilities
              .list('avatar.materials@1')
              .filter((p) => p.state === 'active')
              .map(async (p) => {
                const material = (await ctx.capabilities.invoke(p.point, p.id, {})) as any;
                invariant(
                  material.family === p.owner && material.renderer.startsWith(p.owner + '.'),
                  'avatar_material_owner',
                  '素材管理必须使用提供者自己的接口',
                );
                return material;
              }),
          ),
      });
      registry.register({
        name: 'avatar.rendererInfo',
        description: '读取所选渲染器的动画与状态映射',
        owner: 'avatar',
        permission: 'avatar.read',
        mcp: false,
        input: z.object({ renderer: z.string(), personaId: id.optional() }),
        output: z.object({
          clips: z.array(z.string()),
          stateClips: z.record(z.string(), z.string()),
        }),
        run: async ({ renderer, personaId }) => {
          const point = avatarRendererPoint(ctx, renderer);
          if (!point) return { clips: [], stateClips: {} };
          const result = (await ctx.capabilities.invoke(point, renderer, {
            personaId,
          })) as any;
          return { clips: result.clips ?? [], stateClips: result.stateClips ?? {} };
        },
      });
      ctx.capabilities.subscribe(() => {
        void native.update().catch(() => {});
      });
      const recoveryAttempts = new Map<string, number>(),
        clockKeys = new Set<string>();
      const later = (key: string, at: number, callback: () => any) => {
        clockKeys.add(key);
        clock.at(key, at, callback);
      };
      dispose(
        events.subscribe((e) => {
          if (e.type === 'settings.changed' && e.data.pluginId === 'avatar') {
            recoveryAttempts.clear();
            for (const key of clockKeys)
              if (/avatar\.(recover|healthy)\./.test(key)) clock.cancel(key);
          }
          if (
            e.type === 'avatar.issue' &&
            displayAvatars(store).some(
              (p) => p.enabled && (!e.data.personaId || p.personaId === e.data.personaId),
            )
          ) {
            const owner = String(e.data.personaId ?? displayAvatar(store).personaId ?? ''),
              attempt = recoveryAttempts.get(owner) ?? 0;
            if (attempt < 3) {
              recoveryAttempts.set(owner, attempt + 1);
              const delay = [1000, 3000, 10000][attempt];
              clock.cancel('avatar.healthy.' + owner);
              later('avatar.recover.' + owner, Date.now() + delay, async () => {
                if (!context || !displayAvatar(store, owner).enabled) return;
                await native.update(owner);
                if ((await native.status(owner)).visible)
                  later('avatar.healthy.' + owner, Date.now() + 30000, () => {
                    recoveryAttempts.delete(owner);
                  });
              });
            }
          }
          if (
            (e.type === 'settings.changed' && e.data.pluginId === 'avatar') ||
            e.type === 'preferences.changed' ||
            e.type === 'characters.updated' ||
            e.type === 'character.activity.changed' ||
            e.type === 'conversation.created' ||
            e.type === 'conversation.updated'
          )
            void native.update().catch(() => {});
          if (
            ['run.started', 'run.completed', 'interaction.changed', 'delegation.updated'].includes(
              e.type,
            )
          )
            void native.refreshActivity().catch(() => {});
          if (e.type === 'run.completed' || e.type === 'message.posted')
            void native.update().catch(() => {});
          if (e.type === 'observation.watching') {
            const owner = e.data.personaId as string | undefined;
            void native.dock(owner).catch(() => {});
            later('avatar.release.' + (owner ?? 'all'), Date.now() + 12000, () =>
              native.release(owner).catch(() => {}),
            );
          }
          if (e.type === 'observation.paused') {
            for (const key of clockKeys) if (key.startsWith('avatar.release.')) clock.cancel(key);
            void native.release().catch(() => {});
          }
        }),
      );
      void native.start().catch(() => {});
      dispose(() => native.shutdown());
      dispose(() => {
        for (const key of clockKeys) clock.cancel(key);
      });
      dispose(() => {
        context = undefined;
      });
      registry.register({
        name: 'avatar.status',
        description: '原生呈现与气泡状态',
        owner: 'avatar',
        permission: 'avatar.read',
        mcp: false,
        input: z.object({ personaId: id.optional() }),
        output: z.unknown(),
        run: ({ personaId }) => native.status(personaId),
      });
      registry.register({
        name: 'avatar.dock',
        description: '停靠右下角',
        owner: 'avatar',
        permission: 'avatar.write',
        mcp: false,
        input: z.object({}),
        output: z.unknown(),
        run: async () => {
          await native.dock();
          return { accepted: true };
        },
      });
      registry.register({
        name: 'avatar.deliveries',
        description: '领取尚未展示的气泡',
        owner: 'avatar',
        permission: 'avatar.read',
        mcp: false,
        input: z.object({}),
        output: z.any(),
        run: () =>
          store.pendingDeliveries().filter((d) => Date.now() - Date.parse(d.createdAt) < 600000),
      });
      registry.register({
        name: 'avatar.claim',
        description: '原子领取一条待展示气泡',
        owner: 'avatar',
        permission: 'avatar.write',
        mcp: false,
        input: z.object({ claimId: id }),
        output: z.any(),
        run: (v) =>
          store.transaction(() => {
            const pending = store
              .pendingDeliveries()
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            for (const old of pending) {
              if (Date.now() - Date.parse(old.createdAt) > 600000) {
                store.saveReceipt(old.id, { ...old, state: 'expired' });
                continue;
              }
              const claimed = {
                ...old,
                state: 'claimed',
                claimId: v.claimId,
                claimedAt: new Date().toISOString(),
              };
              store.saveReceipt(old.id, claimed);
              return claimed;
            }
            return null;
          }),
      });
      registry.register({
        name: 'avatar.ack',
        description: '记录气泡真实显示回执',
        owner: 'avatar',
        permission: 'avatar.write',
        mcp: false,
        input: z.object({ id, claimId: id, state: z.enum(['shown', 'dismissed']) }),
        output: z.any(),
        run: (v) => {
          const old = store.receipt(v.id);
          invariant(
            old?.kind === 'bubble' && old.claimId === v.claimId,
            'missing_delivery',
            '气泡不属于此窗口的领取。',
          );
          if (old.state === 'claimed')
            store.saveReceipt(v.id, {
              ...old,
              state: v.state,
              acknowledgedAt: new Date().toISOString(),
            });
          return store.receipt(v.id);
        },
      });
    },
  };
}
