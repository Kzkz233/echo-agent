import { z } from 'zod';
import { localDay, localTime } from './time.ts';
import type { AutomationField } from './automation.ts';
import type { Store } from './store.ts';

export const missedPolicy = z.enum(['once', 'valid', 'skip']);
export const validMinutes = z.number().int().min(1).max(525600).default(60);
export type MissedPolicy = z.infer<typeof missedPolicy>;
export const missedLabels = { once: '恢复后补一次', valid: '仍有效时补一次', skip: '跳过本次' } as const;
export function missedFields(window = true): AutomationField[] {
  return [
    { key: 'missedPolicy', label: '错过执行时间时', kind: 'select',
      options: missedPolicy.options.map(value => ({ value, label: missedLabels[value] })) },
    ...(window ? [{ key: 'validMinutes', label: '最多延迟（分钟）', kind: 'number' as const,
      min: 1, max: 525600, when: { key: 'missedPolicy', value: 'valid' } }] : []),
  ];
}
export function shiftDay(day: string, days: number) {
  return new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
export function latestDaily(now: number, hour: number, minute: number, timezone: string) {
  const day = localDay(new Date(now), timezone);
  const today = localTime(day, hour, minute, timezone);
  return today <= now ? today : localTime(shiftDay(day, -1), hour, minute, timezone);
}
export function latestSlot(first: number, now: number, schedule: {mode: string; hour: number; minute: number; minutes: number}, timezone: string) {
  if (schedule.mode === 'daily') return Math.max(first, latestDaily(now, schedule.hour, schedule.minute, timezone));
  if (schedule.mode === 'interval') {
    const period = schedule.minutes * 60000;
    return first + Math.max(0, Math.floor((now - first) / period)) * period;
  }
  return first;
}
// Normal timer jitter is not a missed run. Business expiry always takes precedence in valid mode.
export function decideOccurrence(first: number, scheduled: number, now: number, policy: MissedPolicy, expires: number) {
  const late = now - scheduled > 60000;
  const skip = policy === 'valid' ? now > expires : policy === 'skip' && late;
  return { first, scheduled, observed: now, policy, outcome: skip ? 'skipped' : late || first < scheduled ? 'catchup' : 'due' } as const;
}
type Occurrence = ReturnType<typeof decideOccurrence>;
export function recordOccurrence(store: Store, type: string, id: string, personaId: string | undefined, slot: Occurrence, source = '') {
  const key = JSON.stringify([type, id, slot.scheduled, source]);
  store.put('schedule-occurrences', key, { ...slot, type, taskId: id, personaId, source });
}
export function occurrenceHistory(store: Store, type: string, id: string, personaId?: string) {
  const rows = store.db.prepare(`SELECT data FROM documents WHERE namespace='schedule-occurrences'
    AND json_extract(data,'$.type')=? AND json_extract(data,'$.taskId')=?
    AND (? IS NULL OR json_extract(data,'$.personaId')=?) ORDER BY json_extract(data,'$.observed') DESC LIMIT 40`)
    .all(type, id, personaId ?? null, personaId ?? null) as {data: string}[];
  return rows.map(row => JSON.parse(row.data));
}
