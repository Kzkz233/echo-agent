import { isDeepStrictEqual } from 'node:util';
import { providerSnapshot } from './provider-snapshot.ts';
import { z } from 'zod';
import { id, invariant } from '../contracts/index.ts';
import type { Capabilities } from './capabilities.ts';
import type { PluginContext } from './registry.ts';

const point = 'core.automation.types@1';
const value = z.record(z.string(), z.unknown());
const option = z.object({
  value: z.string(),
  label: z.string(),
  scope: z.string().optional(),
  owner: z.string().optional(),
});
const condition = z.object({ key: id, value: z.union([z.string(), z.boolean()]) });
const field = z.object({
  key: id,
  label: z.string(),
  advanced: z.boolean().optional(),
  kind: z.enum([
    'text',
    'datetime',
    'textarea',
    'number',
    'boolean',
    'select',
    'multi',
    'json',
    'records',
    'reasoning',
    'model',
    'executor',
    'outputs',
    'execution',
    'work-context',
  ]),
  inferenceTask: id.optional(),
  modelFallback: z.literal('main').optional(),
  modelField: id.optional(),
  outputSource: z.string().optional(),
  outputSourceField: z.string().optional(),
  outputSources: z.record(z.string(),z.string()).optional(),
  legacyBubble: z.boolean().optional(),
  description: z.string().max(1000).optional(),
  rowTitleKey: id.optional(),
  rowDefaults: value.optional(),
  addLabel: z.string().min(1).max(100).optional(),
  portability: z.enum(['value','resource','private']).optional(),
  rowFields: z
    .array(
      z.object({
        key: id,
        label: z.string(),
        kind: z.enum(['text', 'textarea', 'boolean', 'select']),
        options: z.array(option).optional(),
      }),
    )
    .optional(),
  options: z.array(option).optional(),
  allowEmpty: z.boolean().optional(),
  filterBy: id.optional(),
  when: z.union([condition, z.array(condition)]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
const item = z.object({
  id,
  name: z.string(),
  enabled: z.boolean(),
  state: z.enum(['running', 'paused', 'waiting', 'failed', 'completed', 'unavailable']),
  subject: z.string().optional(),
  suspendedByCharacter: z.boolean().optional(),
  personaId: id.optional(),
  nextAt: z.number().optional(),
  lastAt: z.string().optional(),
  settings: value.optional(),
  // Canonical configuration for migrations; UI settings may include derived fields.
  persistedSettings: value.optional(),
});
const descriptor = z.object({
  scope: z.enum(['workspace', 'character']).default('workspace'),
  fields: z.array(field).max(400).default([]),
  defaults: value.default({}),
  items: z.array(item),
  page: id.optional(),
  statusPage: id.optional(),
  previewOperation: id.optional(),
  // Optional read-only projection of failed jobs with provider-owned checkpoints.
  failuresOperation: id.optional(),
  supportsPatch: z.boolean().optional(),
  canRun: z.boolean().default(false),
  canRemove: z.boolean().default(false),
});
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog'), view: z.enum(['definition','instances']).optional() }),
  z.object({ action: z.literal('save'), id, settings: value, patch: z.boolean().optional(), requireExisting: z.boolean().optional(), expected: value.optional(),
    actor: z.object({ personaId: id, conversationId: id, permissions: z.array(z.string()) }).optional() }),
  z.object({ action: z.literal('remove'), id }),
  z.object({ action: z.literal('run'), id, requestId: id }),
]);
export type AutomationField = z.input<typeof field>;
export type AutomationItem = z.infer<typeof item>;
export type AutomationType = z.infer<typeof descriptor> & {
  id: string;
  name: string;
  owner: string;
};
type Scope = ReturnType<Capabilities['forOwner']>;
type Description = Omit<z.input<typeof descriptor>,'items'> & { items?: AutomationItem[] };
type Handler = {
  items?: (signal: AbortSignal) => AutomationItem[] | Promise<AutomationItem[]>;
  describe: (signal: AbortSignal) =>
    Description | undefined | Promise<Description | undefined>;
  save?: (id: string, settings: Record<string, unknown>, actor?: { personaId: string; conversationId: string; permissions: string[] }) => unknown;
  remove?: (id: string) => unknown;
  run?: (id: string, requestId: string, signal: AbortSignal) => unknown;
};

export function mergeTaskSettings(current: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const result = { ...current };
  for (const [key, next] of Object.entries(changes)) {
    invariant(!['__proto__', 'prototype', 'constructor'].includes(key), 'task_field', '任务字段无效。');
    const old = current[key];
    result[key] = next && typeof next === 'object' && !Array.isArray(next) && old && typeof old === 'object' && !Array.isArray(old)
      ? mergeTaskSettings(old as Record<string, unknown>, next as Record<string, unknown>) : next;
  }
  return result;
}

export function defineAutomation(scope: Scope) {
  scope.define({
    id: point,
    description: '自动化任务类型及其配置、启停和执行入口',
    input: request,
    output: z.object({ catalog: descriptor.optional(), saved: value.optional() }),
    providePermission: 'automation.contribute',
    consumePermission: 'automation.invoke',
    cardinality: 'many',
  });
}

export function contributeAutomation(
  ctx: Pick<PluginContext, 'capabilities'>,
  type: string,
  label: string,
  handler: Handler,
) {
  const pending = new Map<string, Promise<unknown>>();
  ctx.capabilities.provide(point, type, label, async (input: z.infer<typeof request>, signal) => {
    if (input.action === 'catalog') {
      if (input.view === 'instances' && handler.items) return { catalog: { items:await handler.items(signal) } };
      const catalog = await handler.describe(signal);
      return catalog
        ? { catalog: { ...catalog, supportsPatch:true, items:input.view === 'definition' ? [] : handler.items ? await handler.items(signal) : catalog.items ?? [], canRun: !!handler.run, canRemove: !!handler.remove } }
        : {};
    }
    signal.throwIfAborted();
    if (input.action === 'run') {
      invariant(handler.run, 'automation_unsupported', '此任务不支持手动触发。');
      await handler.run(input.id, input.requestId, signal);
      return {};
    }
    const change = async () => {
      signal.throwIfAborted();
      if (input.action === 'remove') {
        invariant(handler.remove, 'automation_unsupported', '此任务不支持移除。');
        await handler.remove(input.id);
        return {};
      }
      invariant(handler.save, 'automation_unsupported', '请打开专用页面配置此任务。');
      if (!input.patch) {
        await handler.save(input.id, input.settings, input.actor);
        return {};
      }
      const readItem = async () => {
        const items = handler.items ? await handler.items(signal) : (await handler.describe(signal))?.items;
        return items?.find(row => row.id === input.id);
      };
      const item = await readItem();
      invariant(item || !input.requireExisting, 'task_missing', '任务不存在。');
      const current = item?.persistedSettings ?? item?.settings ?? {};
      invariant(!item || !input.actor || (item.personaId ?? current.personaId) === input.actor.personaId,
        'task_owner', '不能编辑其他角色的任务。');
      const expected = input.expected ?? {};
      for (const key of Object.keys(expected))
        invariant(isDeepStrictEqual(current[key], expected[key]) || isDeepStrictEqual(current[key], input.settings[key]),
          'revision_conflict', '任务字段已变化：' + key);
      await handler.save(input.id, mergeTaskSettings(current, input.settings), input.actor);
      const saved = await readItem();
      invariant(saved, 'task_missing', '无法核对已保存的任务。');
      return { saved: saved.persistedSettings ?? saved.settings };
    };
    const work = (pending.get(input.id) ?? Promise.resolve()).catch(() => {}).then(change);
    pending.set(input.id, work);
    try { return await work; }
    finally { if (pending.get(input.id) === work) pending.delete(input.id); }
  });
}

export class Automation {
  constructor(readonly scope: Scope) {}
  async catalog(signal: AbortSignal, view?: 'definition' | 'instances', only?: string) {
    const available = this.scope.list(point).filter((type) => type.state === 'active' && (!only || type.id === only));
    const rows = await Promise.allSettled(
      available.map(async (type) => {
        const result = (await providerSnapshot(
          (bounded) => this.scope.invoke(point, type.id, { action: 'catalog', ...(view && { view }) }, bounded), signal,
        )) as {
          catalog?: z.infer<typeof descriptor>;
        };
        return (
          result.catalog && { ...result.catalog, ...(view === 'definition' && { items:[] }), id: type.id, name: type.label, owner: type.owner }
        );
      }),
    );
    signal.throwIfAborted();
    return {
      types: rows.flatMap((result) =>
        result.status === 'fulfilled' && result.value ? [result.value] : [],
      ),
      unavailable: rows.flatMap((result, i) =>
        result.status === 'rejected' ? [available[i].label] : [],
      ),
    };
  }
  async mutate(
    type: string,
    input: Exclude<z.infer<typeof request>, { action: 'catalog' }>,
    signal: AbortSignal,
  ) {
    const result = await this.scope.invoke(point, type, input, signal) as { saved?: Record<string, unknown> };
    return { accepted: true, ...result };
  }
}
