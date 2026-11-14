import { z } from 'zod';
import { invariant } from '../contracts/index.ts';
import type { Capabilities } from './capabilities.ts';
import type { Store } from './store.ts';
import { providerSnapshot } from './provider-snapshot.ts';

const item = z.object({
  id: z.string(),
  page: z.string(),
  personaId: z.string().optional(),
  at: z.string().datetime(),
  pending: z.boolean().default(false),
});
type Cursor = { key: string; at: string; ids: string[] };
export class Badges {
  constructor(
    readonly core: ReturnType<Capabilities['forOwner']>,
    readonly store: Store,
  ) {
    core.define({
      id: 'core.ui.badges@1',
      description: 'Unread and actionable page indicators contributed by plugins',
      input: z.object({}),
      output: z.array(item).max(5000),
      providePermission: 'ui.contribute',
      consumePermission: 'ui.read',
    });
    if (!store.get('ui.badges.baseline', ''))
      store.set('ui.badges.baseline', new Date().toISOString());
  }
  async snapshot() {
    const seen = this.store.get<Record<string, Cursor>>('ui.badges.seen', {}),
      baseline = this.store.get('ui.badges.baseline', '');
    const result = new Map<
      string,
      { page: string; personaId?: string; count: number; pending: number; cursors: Cursor[] }
    >();
    const providers = await Promise.all(
      this.core
        .list('core.ui.badges@1')
        .filter((p) => p.state === 'active')
        .map(async (provider) => ({
          provider,
          rows: (await providerSnapshot((s) =>
            this.core.invoke('core.ui.badges@1', provider.id, {}, s),
          ).catch(() => [])) as z.infer<typeof item>[],
        })),
    );
    for (const { provider, rows } of providers) {
      const groups = new Map<string, z.infer<typeof item>[]>();
      for (const row of rows) {
        if (!row.id.startsWith(provider.owner + '.')) continue;
        const key = JSON.stringify([row.page, row.personaId ?? '']);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }
      for (const [target, items] of groups) {
        const key = JSON.stringify([provider.id, target]),
          cursor = seen[key] ?? { key, at: baseline, ids: [] };
        const unread = items.filter(
          (r) =>
            r.pending || r.at > cursor.at || (r.at === cursor.at && !cursor.ids.includes(r.id)),
        );
        const group = result.get(target) ?? {
          page: items[0].page,
          personaId: items[0].personaId,
          count: 0,
          pending: 0,
          cursors: [],
        };
        group.count += unread.length;
        group.pending += unread.filter((r) => r.pending).length;
        const readable = items.filter((r) => !r.pending);
        if (readable.length) {
          const at = readable
            .map((r) => r.at)
            .sort()
            .at(-1)!;
          group.cursors.push({
            key,
            at,
            ids: readable.filter((r) => r.at === at).map((r) => r.id),
          });
        }
        result.set(target, group);
      }
    }
    return [...result.values()];
  }
  async read(page: string, personaId: string | undefined, cursors: Cursor[]) {
    const target = (await this.snapshot()).find(
      (r) => r.page === page && r.personaId === personaId,
    );
    const seen = this.store.get<Record<string, Cursor>>('ui.badges.seen', {});
    for (const cursor of cursors) {
      const current = target?.cursors.find((c) => c.key === cursor.key);
      invariant(current && cursor.at <= current.at, 'badge_cursor', '未读标记已变化，请刷新');
      const old = seen[cursor.key];
      if (!old || cursor.at > old.at) seen[cursor.key] = cursor;
      else if (cursor.at === old.at)
        seen[cursor.key] = { ...old, ids: [...new Set([...old.ids, ...cursor.ids])] };
    }
    this.store.set('ui.badges.seen', seen);
    return { read: true };
  }
}
export const badgeRead = z.object({
  page: z.string(),
  personaId: z.string().optional(),
  cursors: z
    .array(
      z.object({ key: z.string(), at: z.string().datetime(), ids: z.array(z.string()).max(5000) }),
    )
    .max(100),
});
