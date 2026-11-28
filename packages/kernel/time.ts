import type { Store } from './store.ts';
import { followAppTimezone } from '../contracts/daily-time.ts';
export function scheduleTimezone(store: Store, timezone?: string) {
  return !timezone || timezone === followAppTimezone ? configuredTimezone(store) : timezone;
}
export function configuredTimezone(store: Store) {
  const configured = store.get<{ timezone?: string }>('clock.config', {}).timezone;
  return !configured || configured === 'system' ? Intl.DateTimeFormat().resolvedOptions().timeZone : configured;
}
/** Human-readable local time for model input; persisted timestamps remain UTC. */
export function localTimestamp(date: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const offset = get('timeZoneName').replace('GMT', 'UTC');
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${offset}`;
}

export function localDay(date: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const offsets = new Map<string, Intl.DateTimeFormat>();
function offsetAt(at: number, timezone: string) {
  let formatter = offsets.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' });
    offsets.set(timezone, formatter);
  }
  const value = formatter.formatToParts(at).find(part => part.type === 'timeZoneName')!.value;
  const match = value.match(/GMT([+-])(\d\d):(\d\d)/);
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60000 : 0;
}

/** Use the first occurrence of a repeated time, and shift a missing time forward by the DST gap. */
export function localTime(day: string, hour: number, minute: number, timezone: string) {
  const wall = Date.parse(day + 'T00:00:00Z') + hour * 3600000 + minute * 60000;
  const before = offsetAt(wall - 86400000, timezone), after = offsetAt(wall + 86400000, timezone);
  const earlierOffset = wall - before, laterOffset = wall - after;
  if (before === after) return earlierOffset;
  const matches = [earlierOffset, laterOffset].filter(at => at + offsetAt(at, timezone) === wall);
  return matches.length ? Math.min(...matches) : Math.max(earlierOffset, laterOffset);
}

/** First strictly future local HH:mm. A repeated wall time schedules only one daily run. */
export function nextDaily(now: Date, hour: number, minute: number, timezone: string) {
  const day = localDay(now, timezone);
  const today = localTime(day, hour, minute, timezone);
  if (today > now.getTime()) return today;
  const tomorrow = new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0,10);
  return localTime(tomorrow, hour, minute, timezone);
}
