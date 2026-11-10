import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import type { Store } from '../../packages/kernel/store.ts';
import { characterEnabled } from '../../packages/kernel/characters.ts';
import { avatarStateRule } from './states.ts';

const clipName = z.string().regex(/^[\w.-]{1,80}$/);
export const frameMotion = z.object({
  idle: clipName.default('idle'),
  working: clipName.default('walk'),
  speaking: clipName.default('jump'),
});

export const avatarConfigSchema = z.object({
  personaId: id.optional(),
  enabled: z.boolean().default(false),
  renderer: z.string().default('frames'),
  conversationId: z.string().default(''),
  assetDirectory: z.string().default(''),
  animationClips: frameMotion.default(() => frameMotion.parse({})),
  stateRules: z.record(id, avatarStateRule).default({}),
  roam: z.boolean().default(true),
  corner: z.enum(['left', 'right']).default('right'),
  scale: z.number().min(0.4).max(2).default(1),
  fps: z.number().int().min(1).max(30).default(10),
  bubbleSeconds: z.number().int().min(5).max(120).default(25),
});
export type AvatarConfig = z.infer<typeof avatarConfigSchema>;

function configuredAvatar(store: Store): AvatarConfig {
  const config = avatarConfigSchema.parse(store.get('avatar.config', {}));
  if (config.personaId) return config;
  const observed = store.get<{ personaId?: string }>('observation.config', {});
  return {
    ...config,
    personaId:
      store.conversation(config.conversationId)?.personaId ??
      observed.personaId ??
      store.conversations()[0]?.personaId ??
      store.documents<{ id: string }>('personas')[0]?.id,
  };
}

export function displayAvatar(store: Store, personaId?: string): AvatarConfig {
  const config = personaId ? roleAvatar(store, personaId) : configuredAvatar(store);
  return {
    ...config,
    enabled:
      config.enabled && !store.get('avatar.hidden', false) && (!config.personaId || characterEnabled(store, config.personaId, 'avatar')),
  };
}
export function displayAvatars(store: Store): AvatarConfig[] {
  const current = configuredAvatar(store);
  const ids = new Set(
    store
      .documents<AvatarConfig>('avatar-profiles')
      .map((p) => p.personaId)
      .filter((id): id is string => Boolean(id)),
  );
  if (current.personaId) ids.add(current.personaId);
  return [...ids].map((id) => displayAvatar(store, id));
}

export function roleAvatar(store: Store, personaId: string): AvatarConfig {
  const active = configuredAvatar(store);
  if (active.personaId === personaId) return active;
  const profile = store.document<AvatarConfig>('avatar-profiles', personaId);
  return avatarConfigSchema.parse({ ...profile, personaId });
}

export function saveRoleAvatar(store: Store, personaId: string, patch: Partial<AvatarConfig>) {
  invariant(store.document('personas', personaId), 'persona_missing', '请选择有效角色。');
  const active = configuredAvatar(store);
  const next = avatarConfigSchema.parse({ ...roleAvatar(store, personaId), ...patch, personaId });
  invariant(
    !patch.conversationId || store.conversation(patch.conversationId)?.personaId === personaId,
    'avatar_conversation',
    '桌宠回复会话必须属于当前角色。',
  );
  store.transaction(() => {
    if (active.personaId === personaId || !store.get<any>('avatar.config', {}).personaId) {
      store.set('avatar.config', next);
    }
    store.put('avatar-profiles', personaId, next);
  });
  return next;
}
