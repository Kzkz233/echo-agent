import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { agendaItemSchema, type AgendaItem } from './contracts.ts';
import type { Agenda } from './index.ts';

export const agendaImport = z.object({
  source: z.string().min(1).max(100),
  requestId: id,
  commit: z.boolean().default(false),
  items: z
    .array(z.object({ sourceId: id, existingId: id.optional(), item: agendaItemSchema }))
    .max(10000),
});
/** Import is insert-only. Existing destination records win, including completion and rescheduling. */
export async function importAgenda(
  agenda: Agenda,
  input: z.infer<typeof agendaImport>,
  signal: AbortSignal,
) {
  const value = agendaImport.parse(input),
    fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...value, commit: undefined, requestId: undefined }))
      .digest('hex');
  const receipt = agenda.store.receipt('agenda.import.' + value.requestId);
  if (receipt) {
    invariant(receipt.hash === fingerprint, 'idempotency_conflict', '导入请求内容已变化。');
    return receipt.result;
  }
  invariant(
    new Set(value.items.map((item) => item.sourceId)).size === value.items.length,
    'duplicate_source',
    '导入来源编号重复。',
  );
  const existing = agenda.items(),
    mapping = new Map<string, string>();
  for (const entry of value.items) {
    const match = existing.find((item) => {
      const source = item.extensions['agenda-import'] as any;
      return source?.source === value.source && source?.id === entry.sourceId;
    });
    if (entry.existingId)
      invariant(
        existing.some((item) => item.id === entry.existingId),
        'missing_destination',
        '指定的已有日程不存在。',
      );
    mapping.set(
      entry.sourceId,
      match?.id ??
        entry.existingId ??
        'import-' +
          createHash('sha256')
            .update(value.source + '\0' + entry.sourceId)
            .digest('hex')
            .slice(0, 32),
    );
  }
  const inserted: AgendaItem[] = [],
    preserved: string[] = [],
    pending: any[] = [];
  for (const entry of value.items) {
    const target = mapping.get(entry.sourceId)!;
    if (existing.some((item) => item.id === target)) {
      preserved.push(target);
      continue;
    }
    const item = {
      ...entry.item,
      id: target,
      revision: 0,
      parentId: entry.item.parentId
        ? (mapping.get(entry.item.parentId) ?? entry.item.parentId)
        : undefined,
      reminder: { ...entry.item.reminder, enabled: false },
      extensions: {
        ...entry.item.extensions,
        'agenda-import': {
          source: value.source,
          id: entry.sourceId,
          original: entry.item,
          importedAt: new Date().toISOString(),
        },
      },
    };
    pending.push(item);
  }
  const result = {
    created: pending.length,
    preserved: preserved.length,
    remindersDisabled: pending.length,
    mapping: Object.fromEntries(mapping),
    committed: value.commit,
  };
  if (!value.commit) return result;
  signal.throwIfAborted();
  return agenda.store.transaction(() => {
    while (pending.length) {
      const index = pending.findIndex(
        (item) => !item.parentId || agenda.store.document('agenda', item.parentId),
      );
      invariant(index >= 0, 'agenda_parent', '导入父子关系缺失或形成循环。');
      const [item] = pending.splice(index, 1);
      inserted.push(agenda.save(item));
    }
    agenda.store.saveReceipt('agenda.import.' + value.requestId, {
      kind: 'agenda.import',
      state: 'succeeded',
      hash: fingerprint,
      result,
      at: new Date().toISOString(),
    });
    return result;
  });
}
