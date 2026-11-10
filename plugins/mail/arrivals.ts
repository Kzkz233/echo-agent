import { z } from 'zod';
import { id } from '../../packages/contracts/index.ts';
import type { Store } from '../../packages/kernel/store.ts';
import type { PluginContext } from '../../packages/kernel/registry.ts';

const reminderDecision = z.object({ remind: z.boolean(), rule: z.string().optional() });
export const arrival = z.object({
  id,
  seq: z.number().int(),
  accountId: id,
  accountName: z.string(),
  personaId: id.optional(),
  mailbox: z.string(),
  primary: z.boolean(),
  subject: z.string(),
  from: z.string(),
  date: z.string(),
  observedAt: z.string(),
  unread: z.boolean(),
  reminder: reminderDecision.optional(),
});
export type Arrival = z.infer<typeof arrival>;
// Mail owns this journal. Consumers only see the bounded public metadata contract.
export function recordArrival(
  store: Store,
  mail: { id: string; accountId: string; seenAt: string; subject: string; from: string },
) {
  if (store.document('mail-arrivals', mail.id)) return;
  const seq = store.get<number>('mail.arrivalSequence', 0) + 1;
  store.put('mail-arrivals', mail.id, {
    id: mail.id,
    accountId: mail.accountId,
    seq,
    observedAt: mail.seenAt,
  });
  store.set('mail.arrivalSequence', seq);
}
export function trimArrivals(store: Store, now = Date.now()) {
  const rows = store
    .documents<{ id: string; seq: number; observedAt: string }>('mail-arrivals')
    .sort((a, b) => b.seq - a.seq);
  for (let i = 0; i < rows.length; i++)
    if (i >= 10000 || Date.parse(rows[i].observedAt) < now - 30 * 86400000)
      store.remove('mail-arrivals', rows[i].id);
}
export function arrivalsContract(store: Store, ctx: PluginContext) {
  ctx.capabilities.define({
    id: 'mail.arrivals@1',
    description: '新增邮件的持久元数据流；不包含历史回填或首次同步基线',
    input: z.object({
      after: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(200).default(100),
      fullEnvelope: z.boolean().default(false),
    }),
    output: z.object({
      last: z.number().int(),
      cursor: z.number().int(),
      hasMore: z.boolean(),
      accounts: z.array(z.object({ id, name: z.string() })),
      items: z.array(arrival),
    }),
    providePermission: 'mail.read',
    consumePermission: 'mail.read',
    cardinality: 'one',
  });
  ctx.capabilities.provide('mail.arrivals@1', 'mail.arrivals', 'New mail metadata', (input) => {
    const accounts = store.documents<any>('mail-accounts'),
      last = store.get<number>('mail.arrivalSequence', 0);
    const rows =
      input.after === undefined
        ? []
        : store
            .documents<any>('mail-arrivals')
            .filter((r) => r.seq > input.after)
            .sort((a, b) => a.seq - b.seq);
    const batch = rows.slice(0, input.limit),
      items: Arrival[] = [];
    for (const row of batch) {
      const mail = store.document<any>('mail', row.id),
        account = accounts.find((a) => a.id === row.accountId);
      if (!mail || !account || mail.removedAt) continue;
      items.push({
        id: mail.id,
        seq: row.seq,
        accountId: mail.accountId,
        accountName: account.name,
        personaId: mail.personaId,
        mailbox: mail.mailbox,
        primary: mail.mailbox === account.mailbox,
        subject: input.fullEnvelope ? mail.subject : mail.subject.slice(0, 1000),
        from: input.fullEnvelope ? mail.from : mail.from.slice(0, 1000),
        date: mail.date,
        observedAt: row.observedAt,
        unread: !mail.flags?.includes('\\Seen'),
        reminder: row.reminder,
      });
    }
    return {
      last,
      cursor: batch.at(-1)?.seq ?? last,
      hasMore: rows.length > batch.length,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      items,
    };
  });
}
