import { z } from 'zod';
import type { PluginContext } from '../../packages/kernel/registry.ts';
import type { Store } from '../../packages/kernel/store.ts';
import type { Router } from '../../packages/kernel/router.ts';

export const avatarStateRule = z.object({
  priority: z.number().int().min(0).max(1000).optional(),
  clip: z
    .string()
    .regex(/^[\w.-]{1,80}$/)
    .optional(),
});
export const stateDescriptor = z.object({
  priority: z.number().int().min(0).max(1000),
  fallback: z.string().default('avatar.idle'),
  clip: z.string().default('idle'),
  instances: z
    .array(z.object({ id: z.string().max(160), expiresAt: z.number().finite() }))
    .max(200)
    .default([]),
});
export function defineAvatarStates(ctx: PluginContext, store: Store, router: Router) {
  ctx.capabilities.define({
    id: 'avatar.states@1',
    description: '可并存的角色活动状态及其动画默认值；实例必须提供到期时间',
    input: z.object({ personaId: z.string().optional() }),
    output: stateDescriptor,
    providePermission: 'avatar.state',
    consumePermission: 'avatar.read',
    cardinality: 'many',
  });
  for (const [id, label, priority, clip] of [
    ['idle', '空闲', 0, 'idle'],
    ['working', '主会话执行', 40, 'walk'],
    ['speaking', '气泡展示', 70, 'jump'],
    ['dragging', '拖动', 100, 'picked'],
    ['roaming', '漫游', 20, 'walk'],
    ['falling', '下落', 95, 'fall'],
    ['landing', '落地', 90, 'land'],
    ['waiting', '等待确认', 60, 'idle'],
  ] as const)
    ctx.capabilities.provide('avatar.states@1', 'avatar.' + id, label, ({ personaId }) => ({
      priority,
      clip,
      fallback: 'avatar.idle',
      instances: !personaId
        ? []
        : id === 'working'
          ? store
              .unresolved()
              .filter(
                (run) =>
                  run.state === 'running' &&
                  store.conversation(run.conversationId)?.personaId === personaId &&
                  store.conversation(run.conversationId)?.kind !== 'worker',
              )
              .map((run) => ({ id: run.id, expiresAt: Date.now() + 120000 }))
          : id === 'waiting'
            ? store
                .conversations()
                .filter((c) => c.personaId === personaId)
                .flatMap((c) =>
                  router.interactions
                    .list(c.id)
                    .map((i) => ({ id: i.id, expiresAt: Date.now() + 120000 })),
                )
            : [],
    }));
}
export async function avatarStates(ctx: PluginContext, personaId?: string) {
  const providers = ctx.capabilities.list('avatar.states@1').filter((p) => p.state === 'active');
  const results = await Promise.allSettled(
    providers.map(async (p) => ({
      ...p,
      ...stateDescriptor.parse(
        await ctx.capabilities.invoke('avatar.states@1', p.id, { personaId }),
      ),
    })),
  );
  return results.flatMap((r) =>
    r.status === 'fulfilled'
      ? [{ ...r.value, instances: r.value.instances.filter((i) => i.expiresAt > Date.now()) }]
      : [],
  );
}
