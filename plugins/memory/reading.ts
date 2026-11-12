import { invariant, type Memory } from '../../packages/contracts/index.ts';
import type { Store } from '../../packages/kernel/store.ts';

export const memorySummary = (memory: Memory) => ({ id: memory.id, version: memory.version,
  title: memory.title, core: memory.core, tags: memory.tags, perspective: memory.perspective,
  confirmation: memory.confirmation, occurredAt: memory.occurredAt, updatedAt: memory.updatedAt,
  excerpt: memory.text.slice(0, 240), totalChars: memory.text.length });
const key = (conversationId: string, memory: Memory) => JSON.stringify([conversationId, memory.id, memory.version]);
export function recordRead(store: Store, conversationId: string, memory: Memory, start: number, end: number) {
  const id = key(conversationId, memory);
  const previous = store.document<{ ranges: number[][] }>('memory-reads', id)?.ranges ?? [];
  const ranges: number[][] = [];
  for (const range of [...previous, [start, end]].sort((a, b) => a[0] - b[0])) {
    const last = ranges.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([...range]);
  }
  store.put('memory-reads', id, { ranges });
}
export function requireRead(store: Store, conversationId: string, memory: Memory) {
  const ranges = store.document<{ ranges: number[][] }>('memory-reads', key(conversationId, memory))?.ranges;
  invariant(ranges?.[0]?.[0] === 0 && ranges[0][1] >= memory.text.length,
    'memory_read_required', '修改或合并前请用 memory_read 完整阅读当前版本的记忆。');
}
