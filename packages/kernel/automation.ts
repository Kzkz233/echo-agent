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
  canRun: z.boolean().default(false),
  canRemove: z.boolean().default(false),
});
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog') }),
  z.object({ action: z.literal('save'), id, settings: value,
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
type Handler = {
  describe: () =>
    z.input<typeof descriptor> | undefined | Promise<z.input<typeof descriptor> | undefined>;
  save?: (id: string, settings: Record<string, unknown>, actor?: { personaId: string; conversationId: string; permissions: string[] }) => unknown;
  remove?: (id: string) => unknown;
  run?: (id: string, requestId: string, signal: AbortSignal) => unknown;
};

export function defineAutomation(scope: Scope) {
  scope.define({
    id: point,
    description: '自动化任务类型及其配置、启停和执行入口',
    input: request,
    output: z.object({ catalog: descriptor.optional() }),
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
  ctx.capabilities.provide(point, type, label, async (input: z.infer<typeof request>, signal) => {
    if (input.action === 'catalog') {
      const catalog = await handler.describe();
      return catalog
        ? { catalog: { ...catalog, canRun: !!handler.run, canRemove: !!handler.remove } }
        : {};
    }
    signal.throwIfAborted();
    if (input.action === 'save') {
      invariant(handler.save, 'automation_unsupported', '请打开专用页面配置此任务。');
      await handler.save(input.id, input.settings, input.actor);
    } else if (input.action === 'remove') {
      invariant(handler.remove, 'automation_unsupported', '此任务不支持移除。');
      await handler.remove(input.id);
    } else {
      invariant(handler.run, 'automation_unsupported', '此任务不支持手动触发。');
      await handler.run(input.id, input.requestId, signal);
    }
    return {};
  });
}

export class Automation {
  constructor(readonly scope: Scope) {}
  async catalog(signal: AbortSignal) {
    const available = this.scope.list(point).filter((type) => type.state === 'active');
    const rows = await Promise.allSettled(
      available.map(async (type) => {
        const result = (await this.scope.invoke(point, type.id, { action: 'catalog' }, signal)) as {
          catalog?: z.infer<typeof descriptor>;
        };
        return (
          result.catalog && { ...result.catalog, id: type.id, name: type.label, owner: type.owner }
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
    await this.scope.invoke(point, type, input, signal);
    return { accepted: true };
  }
}
