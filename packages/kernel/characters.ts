import { z } from 'zod';
import { id, type Conversation } from '../contracts/index.ts';
import type { Store } from './store.ts';
import type { Capabilities } from './capabilities.ts';
import type { Field } from './registry.ts';

export const characterPoint = 'core.characters.features@1';
const configuration = z.record(z.string(), z.unknown());
export function managedConversation(store: Store, conversation: Conversation) {
  return (
    ['main', 'group-member', 'worker'].includes(conversation.kind ?? '') ||
    store
      .documents<{ mainConversationId: string }>('characters')
      .some((role) => role.mainConversationId === conversation.id)
  );
}
export type CharacterFeature = {
  version: number;
  fields: Field[];
  taskTypes?: string[];
  schema: z.ZodType;
  read: (personaId: string) => unknown;
  save: (personaId: string, value: any) => unknown | Promise<unknown>;
  pack?: (personaId: string) => Promise<Record<string, string>>;
  unpack?: (
    assets: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
};

export function defineCharacterFeatures(scope: ReturnType<Capabilities['forOwner']>) {
  scope.define({
    id: characterPoint,
    description: '角色能力配置、校验和任务模板入口',
    input: z.object({
      action: z.enum(['describe', 'read', 'validate', 'save', 'pack', 'unpack']),
      personaId: id.optional(),
      value: configuration.optional(),
      assets: z.record(z.string(), z.string().max(12000000)).optional(),
    }),
    output: z.object({
      version: z.number().int().positive(),
      fields: z
        .array(
          z.object({
            key: z.string(),
            label: z.string(),
            type: z.string(),
            resource: z.string().optional(),
            backendKinds: z.array(z.string()).optional(),
            inferenceTask:z.string().optional(),
            rowFields: z.array(z.any()).optional(),
            defaults: z.record(z.string(), z.unknown()).optional(),
            addLabel: z.string().optional(),
            removeLabel: z.string().optional(),
            options: z.array(z.string()).optional(),
            optionLabels: z.record(z.string(), z.string()).optional(),
            description: z.string().optional(),
            localOnly: z.boolean().optional(),
            min: z.number().optional(),
            max: z.number().optional(),
            pathMode: z.enum(['file', 'directory', 'save']).optional(),
          }),
        )
        .optional(),
      taskTypes: z.array(id).optional(),
      value: configuration.optional(),
      assets: z.record(z.string(), z.string().max(12000000)).optional(),
      requires: z.array(id).optional(),
      presentation: z
        .object({
          section: id,
          title: z.string(),
          order: z.number().optional(),
          editor: id.optional(),
        })
        .optional(),
    }),
    providePermission: 'character.contribute',
    consumePermission: 'character.configure',
    cardinality: 'many',
  });
}

export function characterActivity(store: Store, personaId: string) {
  return store.get<{enabled:boolean;revision:number;changedAt?:string}>('character.activity.'+personaId,{enabled:true,revision:0});
}
export function characterActive(store: Store, personaId: string) {
  return characterActivity(store,personaId).enabled;
}
export function characterEnabled(store: Store, personaId: string, feature: string) {
  if (!characterActive(store,personaId)) return false;
  if (feature === 'persona') return true;
  const role = store.document<{ features: string[]; state?: string }>('characters', personaId);
  return (
    !role ||
    ((!role.state || role.state === 'ready') &&
      (feature === 'delegation' || role.features.includes(feature)))
  );
}

export function characterSettings<T>(
  store: Store,
  personaId: string | undefined,
  feature: string,
  fallback: T,
): T {
  return (personaId && store.document<T>('character-settings.' + feature, personaId)) || fallback;
}

export function characterFeature(
  store: Store,
  feature: string,
  schema: z.ZodType,
  fields: Field[],
  taskTypes: string[] = [],
): CharacterFeature {
  return {
    version: 1,
    schema,
    fields,
    taskTypes,
    read: (personaId) =>
      schema.parse(
        characterSettings(store, personaId, feature, store.get(feature + '.config', {})),
      ),
    save: (personaId, value) => {
      store.put('character-settings.' + feature, personaId, value);
      return value;
    },
  };
}
