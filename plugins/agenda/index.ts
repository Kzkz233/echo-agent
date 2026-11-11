import { characterFeature } from '../../packages/kernel/characters.ts';
import manifest from './echo-plugin.json' with { type: 'json' };
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { defineManifest, type Plugin, type PluginContext } from '../../packages/kernel/registry.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Events } from '../../packages/kernel/events.ts';
import { Clock } from '../../packages/kernel/clock.ts';
import { MaterialSources } from '../../packages/kernel/materials.ts';
import { localDay, localTime, configuredTimezone } from '../../packages/kernel/time.ts';
import { operations } from '../shared.ts';
import { agendaImport, importAgenda } from './import.ts';
import {
  agendaItemSchema,
  parsedItems,
  projectionInput,
  projectionOutput,
  type AgendaItem,
  agendaField,
  rescheduleInput,
} from './contracts.ts';
export class Agenda {
  private ctx?: PluginContext;
  private cancel?: () => void;
  constructor(
    readonly store: Store,
    readonly events: Events,
    readonly materials: MaterialSources,
    readonly clock: Clock,
  ) {}
  config() {
    return {
      ...this.store.get<any>('agenda.config', {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        allDayReminderHour: 9,
        conversationId: '',
      }),
      timezone: configuredTimezone(this.store),
    };
  }
  items() {
    return this.store.documents<AgendaItem>('agenda');
  }
  remove(id: string, revision: number) {
    const old = this.store.document<AgendaItem>('agenda', id);
    invariant(old?.revision === revision, 'revision_conflict', '条目已变化');
    this.store.remove('agenda', id);
    this.arm();
    this.events.emit('agenda.updated', { id });
    return { removed: true };
  }
  save(raw: unknown) {
    const v = agendaItemSchema.parse(raw),
      itemId = v.id ?? randomUUID(),
      old = this.store.document<AgendaItem>('agenda', itemId);
    invariant((old?.revision ?? 0) === v.revision, 'revision_conflict', '条目已变化，请重新读取');
    invariant(!v.end || !!v.start, 'agenda_range', '结束时间必须有开始时间');
    invariant(
      !v.end || Date.parse(v.end) >= Date.parse(v.start!),
      'agenda_range',
      '结束时间不能早于开始时间',
    );
    invariant(!(v.date && v.start), 'agenda_date', '全天日期和具体时间二选一');
    invariant(
      !v.dateEnd || (v.date && v.dateEnd >= v.date),
      'agenda_date',
      '全天结束日期不能早于开始日期。',
    );
    if (v.parentId) {
      const visited = new Set([itemId]);
      let parent: AgendaItem | undefined = this.store.document('agenda', v.parentId);
      invariant(parent, 'agenda_parent', '父条目不存在。');
      while (parent) {
        invariant(!visited.has(parent.id), 'agenda_cycle', '子任务不能形成循环。');
        visited.add(parent.id);
        parent = parent.parentId ? this.store.document('agenda', parent.parentId) : undefined;
      }
    }
    invariant(
      !v.reminder.enabled || !!(v.start || v.date),
      'agenda_reminder',
      '设置提醒前请先选择日期或开始时间',
    );
    invariant(
      !v.conversationId || !!this.store.conversation(v.conversationId),
      'missing_conversation',
      '绑定会话不存在',
    );
    invariant(
      Buffer.byteLength(JSON.stringify(v.extensions)) <= 32768,
      'agenda_metadata',
      '扩展资料超过32KB',
    );
    const row = { ...v, id: itemId, revision: v.revision + 1, updatedAt: new Date().toISOString() };
    this.store.put('agenda', itemId, row);
    this.events.emit('agenda.updated', { id: itemId });
    this.arm();
    return row;
  }
  private async validateFields(item: z.infer<typeof agendaItemSchema>, signal: AbortSignal) {
    const before = item.id ? this.store.document<AgendaItem>('agenda', item.id) : undefined;
    for (const provider of this.ctx?.capabilities
      .list('agenda.fields@1')
      .filter((p) => p.state === 'active') ?? []) {
      if (
        JSON.stringify(before?.extensions?.[provider.owner]) ===
        JSON.stringify(item.extensions[provider.owner])
      )
        continue;
      await this.ctx!.capabilities.invoke(
        'agenda.fields@1',
        provider.id,
        { action: 'validate', value: item.extensions[provider.owner] ?? {} },
        signal,
      );
    }
  }
  async reschedule(raw: z.infer<typeof rescheduleInput>, signal: AbortSignal) {
    const input = rescheduleInput.parse(raw),
      fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = this.store.document<any>('agenda-changes', input.requestId);
    if (prior) {
      invariant(prior.fingerprint === fingerprint, 'idempotency_conflict', '改期请求内容已变化。');
      return prior;
    }
    const root = this.store.document<AgendaItem>('agenda', input.id);
    invariant(root?.revision === input.revision, 'revision_conflict', '日程已变化，请刷新后重试。');
    const all = this.items(),
      ids = new Set([root.id]);
    if (input.moveChildren) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of all)
          if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
            ids.add(item.id);
            changed = true;
          }
      }
    }
    const before = all.filter((item) => ids.has(item.id)),
      timezone = this.config().timezone;
    const day = (item: AgendaItem) =>
      item.date ?? (item.start ? localDay(new Date(item.start), timezone) : undefined);
    const base = day(root),
      delta = base ? Math.round((Date.parse(input.date) - Date.parse(base)) / 86400000) : 0;
    const shift = (value: string, n: number) =>
      new Date(Date.parse(value + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const moveTime = (value: string, n: number) => {
      const date = new Date(value),
        local = new Intl.DateTimeFormat('en-GB', {
          timeZone: timezone,
          hourCycle: 'h23',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).formatToParts(date);
      const number = (key: string) => Number(local.find((p) => p.type === key)?.value ?? 0);
      return new Date(
        localTime(shift(localDay(date, timezone), n), number('hour'), number('minute'), timezone) +
          number('second') * 1000 +
          date.getUTCMilliseconds(),
      ).toISOString();
    };
    const proposals: AgendaItem[] = [];
    for (const item of before) {
      let next = { ...item };
      if (item.start) {
        next.start = moveTime(item.start, delta);
        if (item.end) next.end = moveTime(item.end, delta);
      } else if (item.date) {
        next.date = shift(item.date, delta);
        if (item.dateEnd) next.dateEnd = shift(item.dateEnd, delta);
      }
      if (!day(item)) next.date = input.date;
      if (input.extensions)
        for (const [owner, patch] of Object.entries(input.extensions)) {
          const old = (next.extensions[owner] as Record<string, unknown>) ?? {},
            original = (root.extensions[owner] as Record<string, unknown>) ?? {};
          const inherited = Object.fromEntries(
            Object.entries(patch).filter(
              ([key]) => item.id === root.id || old[key] === original[key],
            ),
          );
          next.extensions = {
            ...next.extensions,
            [owner]: Object.fromEntries(
              Object.entries({ ...old, ...inherited }).filter(([, value]) => value !== null),
            ),
          };
        }
      for (const provider of this.ctx?.capabilities
        .list('agenda.reschedule@1')
        .filter((p) => p.state === 'active') ?? []) {
        const result = (await this.ctx!.capabilities.invoke(
          'agenda.reschedule@1',
          provider.id,
          { item: next, from: day(item), to: day(next), deltaDays: delta },
          signal,
        )) as { value?: unknown };
        if (result.value !== undefined)
          next.extensions = { ...next.extensions, [provider.owner]: result.value };
      }
      await this.validateFields(next, signal);
      proposals.push(next);
    }
    signal.throwIfAborted();
    return this.store.transaction(() => {
      const receipt = this.store.document<any>('agenda-changes', input.requestId);
      if (receipt) {
        invariant(
          receipt.fingerprint === fingerprint,
          'idempotency_conflict',
          '改期请求内容已变化。',
        );
        return receipt;
      }
      for (const item of before)
        invariant(
          this.store.document<AgendaItem>('agenda', item.id)?.revision === item.revision,
          'revision_conflict',
          '日程已变化，未进行改期。',
        );
      const after = proposals.map((item) => this.save(item));
      const result = {
        id: input.requestId,
        fingerprint,
        before,
        after,
        at: new Date().toISOString(),
      };
      this.store.put('agenda-changes', input.requestId, result);
      return this.store.document('agenda-changes', input.requestId);
    });
  }
  private schedule(item: AgendaItem) {
    if (!item.reminder.enabled || item.state !== 'open') return;
    const cfg = this.config(),
      at =
        (item.start
          ? Date.parse(item.start)
          : item.date
            ? localTime(item.date, cfg.allDayReminderHour ?? 9, 0, cfg.timezone)
            : NaN) -
        item.reminder.minutesBefore * 60000;
    if (!Number.isFinite(at)) return;
    const conversationId = item.conversationId || cfg.conversationId || '';
    const key = createHash('sha256')
      .update(JSON.stringify([item.id, at, conversationId]))
      .digest('hex');
    return { at, id: key, conversationId };
  }
  private arm() {
    this.cancel?.();
    this.cancel = undefined;
    if (!this.ctx) return;
    const due = this.items().flatMap((item) => {
      const s = this.schedule(item);
      return s && !this.store.document('agenda-reminders', s.id) ? [s.at] : [];
    });
    if (due.length)
      this.cancel = this.clock.at('agenda.reminders', Math.min(...due), () => this.tick());
  }
  async tick(now = Date.now()) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (const item of this.items()) {
      if (ctx.signal.aborted) return;
      const s = this.schedule(item);
      if (!s || s.at > now || this.store.document('agenda-reminders', s.id)) continue;
      const notice = {
        id: s.id,
        itemId: item.id,
        conversationId: s.conversationId,
        title: item.title,
        text: item.notes || item.title,
        scheduledAt: new Date(s.at).toISOString(),
        createdAt: new Date().toISOString(),
        state: now - s.at > 86400000 ? 'missed' : 'recorded',
      };
      this.store.put('agenda-reminders', s.id, notice);
      this.events.emit('agenda.reminder', notice);
      if (notice.state === 'missed') continue;
      const provider = ctx.capabilities
        .list('agenda.reminders@1')
        .find((p) => p.state === 'active' && p.id === 'notifications.agenda');
      if (provider) {
        try {
          const receipt = await ctx.capabilities.invoke(
            'agenda.reminders@1',
            provider.id,
            notice,
            ctx.signal,
          );
          this.store.put('agenda-reminders', s.id, { ...notice, state: 'delivered', receipt });
        } catch {
          this.store.put('agenda-reminders', s.id, { ...notice, state: 'unknown' });
        }
      }
    }
    this.arm();
  }
  plugin(): Plugin {
    return {
      api: { version: 1, value: this },
      manifest: defineManifest(manifest),
      references: (id) => [
        ...(this.config().conversationId === id
          ? [{ label: '日程提醒', page: 'agenda', role: 'report' as const }]
          : []),
        ...this.items()
          .filter((item) => item.conversationId === id)
          .map((item) => ({ label: item.title, page: 'agenda', role: 'report' as const })),
      ],
      character: characterFeature(this.store, 'agenda', z.object({}), [], []),
      config: {
        schema: z.object({
          allDayReminderHour: z.number().int().min(0).max(23).default(9),
          conversationId: z.string().default(''),
        }),
      },
      activate: (ctx) => {
        ctx.capabilities.define({
          id: 'agenda.fields@1',
          description: '日程编辑器的可选字段及保存校验',
          input: z.discriminatedUnion('action', [
            z.object({ action: z.literal('describe') }),
            z.object({ action: z.literal('validate'), value: z.record(z.string(), z.unknown()) }),
          ]),
          output: z.object({ fields: z.array(agendaField).default([]) }),
          providePermission: 'agenda.fields',
          consumePermission: 'agenda.read',
          cardinality: 'many',
        });
        ctx.capabilities.define({
          id: 'agenda.reschedule@1',
          description: '改期时同步所属扩展的派生日期信息',
          input: z.object({
            item: agendaItemSchema,
            from: z.string().optional(),
            to: z.string().optional(),
            deltaDays: z.number().int(),
          }),
          output: z.object({ value: z.record(z.string(), z.unknown()).optional() }),
          providePermission: 'agenda.fields',
          consumePermission: 'agenda.read',
          cardinality: 'many',
        });
        this.ctx = ctx;
        ctx.dispose(() => {
          this.ctx = undefined;
          this.cancel?.();
        });
        const op = operations(ctx, 'agenda');
        op(
          'import',
          '预览或导入外部日程，保留已有记录并禁用历史提醒',
          agendaImport,
          'agenda.write',
          (v, s) => importAgenda(this, v, s),
          false,
        );
        op(
          'fields',
          '读取已注册的日程字段',
          z.object({}),
          'agenda.read',
          async (_v, signal) => {
            const providers = ctx.capabilities
              .list('agenda.fields@1')
              .filter((p) => p.state === 'active');
            return Promise.all(
              providers.map(async (p) => ({
                ...p,
                ...((await ctx.capabilities.invoke(
                  'agenda.fields@1',
                  p.id,
                  { action: 'describe' },
                  signal,
                )) as object),
              })),
            );
          },
          false,
        );
        op('reschedule', '统一移动日程和子任务日期', rescheduleInput, 'agenda.write', (v, s) =>
          this.reschedule(v, s),
        );
        op(
          'undo',
          '撤销未被后续编辑覆盖的改期',
          z.object({ changeId: id, requestId: id }),
          'agenda.write',
          (v) => {
            const key = 'undo-' + v.requestId,
              old = this.store.document<any>('agenda-changes', key);
            if (old) {
              invariant(
                old.changeId === v.changeId,
                'idempotency_conflict',
                '撤销请求内容已变化。',
              );
              return old;
            }
            const change = this.store.document<any>('agenda-changes', v.changeId);
            invariant(change?.before && change?.after, 'agenda_change', '改期记录不存在。');
            return this.store.transaction(() => {
              for (const item of change.after)
                invariant(
                  this.store.document<AgendaItem>('agenda', item.id)?.revision === item.revision,
                  'revision_conflict',
                  '条目已有后续编辑，不能直接撤销。',
                );
              const items = change.before.map((item: AgendaItem) =>
                this.save({
                  ...item,
                  revision: this.store.document<AgendaItem>('agenda', item.id)!.revision,
                }),
              );
              const result = { id: key, changeId: v.changeId, items };
              this.store.put('agenda-changes', key, result);
              return result;
            });
          },
          false,
        );
        ctx.capabilities.define({
          id: 'agenda.inputs@1',
          description: 'Convert input to drafts; never saves automatically',
          input: z.object({ text: z.string().max(20000) }),
          output: parsedItems,
          providePermission: 'agenda.input',
          consumePermission: 'agenda.read',
          cardinality: 'one',
        });
        ctx.capabilities.define({
          id: 'agenda.projections@1',
          description: 'Read-only optional projections referencing canonical item IDs',
          input: projectionInput,
          output: projectionOutput,
          providePermission: 'agenda.projection',
          consumePermission: 'agenda.read',
          cardinality: 'many',
        });
        ctx.capabilities.define({
          id: 'agenda.reminders@1',
          description: 'Optional reminder presentation, independently of inference',
          input: z
            .object({
              id,
              title: z.string(),
              text: z.string(),
              conversationId: z.string(),
              createdAt: z.string(),
            })
            .passthrough(),
          output: z.object({ accepted: z.boolean() }),
          providePermission: 'agenda.delivery',
          consumePermission: 'agenda.notify',
          cardinality: 'one',
        });
        op('list', 'List canonical calendar entries', z.object({}), 'agenda.read', () =>
          this.items(),
        );
        op(
          'save',
          'Create or update a calendar entry',
          agendaItemSchema,
          'agenda.write',
          async (v, s) => {
            await this.validateFields(v, s);
            s.throwIfAborted();
            return this.save(v);
          },
        );
        op(
          'remove',
          'Remove exactly this revision',
          z.object({ id, revision: z.number().int().min(1) }),
          'agenda.write',
          (v) => {
            return this.remove(v.id, v.revision);
          },
        );
        op('calendar', 'Project entries over a date range', projectionInput, 'agenda.read', (v) => {
          invariant(
            v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 370 * 86400000,
            'agenda_range',
            '日期范围应在一年以内',
          );
          const timezone = this.config().timezone;
          return this.items().filter((i) => {
            if (v.personaId && i.personaId !== v.personaId) return false;
            if (i.date) return i.date <= v.to && (i.dateEnd ?? i.date) >= v.from;
            if (!i.start) return false;
            const start = localDay(new Date(i.start), timezone),
              end = localDay(new Date(i.end ?? i.start), timezone);
            return start <= v.to && end >= v.from;
          });
        });
        op('reminders', 'Read reminder history', z.object({}), 'agenda.read', () =>
          this.store.documents('agenda-reminders').slice(-300),
        );
        op(
          'parse',
          'Preview drafts from an explicitly selected input provider',
          z.object({ provider: z.string(), text: z.string().max(20000) }),
          'agenda.read',
          (v, s) => ctx.capabilities.invoke('agenda.inputs@1', v.provider, { text: v.text }, s),
        );
        op(
          'projection',
          'Read a selected optional projection',
          projectionInput.extend({ provider: z.string() }),
          'agenda.read',
          (v, s) => ctx.capabilities.invoke('agenda.projections@1', v.provider, v, s),
        );
        this.materials.register(
          {
            id: 'agenda',
            label: 'Calendar entries',
            read: async (personaId) =>
              this.items()
                .filter((i) => i.personaId === personaId)
                .map((i) => ({
                  id: i.id + '.' + i.revision,
                  personaId,
                  timestamp: i.updatedAt,
                  text: `${i.title} · ${i.state} · ${i.start ?? i.date ?? 'unscheduled'}\n${i.notes}`,
                })),
          },
          ctx.capabilities,
        );
        ctx.capabilities.subscribe(() => this.arm());
        ctx.dispose(
          this.events.subscribe((e) => {
            if (
              e.type === 'settings.changed' &&
              ['agenda', 'clock'].includes(String(e.data.pluginId))
            )
              this.arm();
          }),
        );
        this.arm();
      },
    };
  }
}
