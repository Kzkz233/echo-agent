import { z } from 'zod';
import { conversationSchema, id, invariant, messageSchema } from '../contracts/index.ts';
import type { ExtensionPoint } from './capabilities.ts';

const block = z.object({
  id,
  layer: z.enum(['stable', 'turn']),
  historyDependent: z.boolean().optional(),
  label: z.string().max(120).optional(),
  worker: z.enum(['default', 'optional', 'required']).optional(),
  before: z.array(id).optional(),
  after: z.array(id).optional(),
});
const item = z.object({ text: z.string(), record: z.record(z.string(), z.unknown()).optional() });
const turn = z.object({
  action: z.literal('prepare'),
  conversation: conversationSchema.extend({ id, createdAt: z.string() }),
  text: z.string(),
  effective: z.array(messageSchema),
  source: messageSchema.shape.source,
  presentation: z.enum(['external', 'bubble']).optional(),
  replyStyles: z.array(z.object({ id, label: z.string(), text: z.string(), supportsImages: z.boolean().optional() })).optional(),
  outputTargets: z.array(id).optional(),
  phase: z.enum(['stable', 'turn']).optional(),
});
export const contextPoint: ExtensionPoint = {
  id: 'core.context@3',
  description: 'Declare and prepare ordered, attributed inference context blocks',
  input: z.discriminatedUnion('action', [z.object({ action: z.literal('describe') }), turn]),
  output: z.union([z.array(block), z.record(id, z.array(item))]),
  providePermission: 'context.contribute',
  consumePermission: 'context.read',
  cardinality: 'many',
};
export type ContextBlock = z.infer<typeof block>;
export type ContextItem = z.infer<typeof item>;
export type ContextTurn = z.infer<typeof turn>;
export type ContextProvider = {
  id: string;
  blocks: ContextBlock[];
  prepare: (turn: ContextTurn, signal: AbortSignal) =>
    Record<string, ContextItem[]> | Promise<Record<string, ContextItem[]>>;
};

export function orderContext<T extends ContextBlock>(blocks: T[]): T[] {
  const byId = new Map(blocks.map((value) => [value.id, value]));
  invariant(byId.size === blocks.length, 'context_block_duplicate', '上下文块编号重复。');
  const incoming = new Map(blocks.map((value) => [value.id, new Set<string>()]));
  for (const value of blocks) {
    for (const target of value.before ?? [])
      if (byId.has(target)) incoming.get(target)!.add(value.id);
    for (const target of value.after ?? [])
      if (byId.has(target)) incoming.get(value.id)!.add(target);
  }
  for (const value of blocks)
    for (const dependency of incoming.get(value.id)!)
      invariant(byId.get(dependency)!.layer === value.layer, 'context_layer_order',
        '上下文块只能对同层内容声明先后关系：' + value.id);
  const ordered: T[] = [];
  for (const layer of ['stable', 'turn']) {
    const remaining = blocks.filter((value) => value.layer === layer).map((value) => value.id).sort();
    while (remaining.length) {
      const index = remaining.findIndex((id) => !incoming.get(id)!.size);
      invariant(index >= 0, 'context_order_cycle', '上下文块顺序存在循环：' + remaining.join('、'));
      const [id] = remaining.splice(index, 1);
      ordered.push(byId.get(id)!);
      for (const next of remaining) incoming.get(next)!.delete(id);
    }
  }
  return ordered;
}
