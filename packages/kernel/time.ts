import type { Store } from './store.ts';
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
export function localTime(day: string, hour: number, minute: number, timezone: string) {
  const wall = Date.parse(day + 'T00:00:00Z') + hour * 3600000 + minute * 60000;
  const offset = (at: number) => {
    const part = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')!.value;
    const m = part.match(/GMT([+-])(\d\d):(\d\d)/);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0;
  };
  let value = wall - offset(wall);
  value = wall - offset(value);
  return value;
}
/** First strictly future local HH:mm; offset is recalculated for DST transitions. */
export function nextDaily(now: Date, hour: number, minute: number, timezone: string) {
  const date = localDay(now, timezone);
  const offset = (time: number) => {
    const s = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(time)
      .find((p) => p.type === 'timeZoneName')!.value;
    const m = s.match(/GMT([+-])(\d\d):(\d\d)/);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0;
  };
  const base = Date.parse(date + 'T00:00:00Z') + hour * 3600000 + minute * 60000;
  for (let days = 0; days < 3; days++) {
    const target = base + days * 86400000;
    let value = target - offset(target);
    value = target - offset(value);
    if (value > now.getTime()) return value;
  }
  return now.getTime() + 86400000;
}
