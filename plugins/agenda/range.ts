import { localDay } from '../../packages/kernel/time.ts';

type DatedItem = { date?: string; dateEnd?: string; start?: string; end?: string };
/** All-day dates include dateEnd; timed intervals include start and exclude end. */
export function agendaDayRange(item: DatedItem, timezone: string): [string, string] | undefined {
  if (item.date) return [item.date, item.dateEnd ?? item.date];
  if (!item.start) return;
  const start = Date.parse(item.start), end = Date.parse(item.end ?? item.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  return [localDay(new Date(start), timezone), localDay(new Date(end > start ? end - 1 : start), timezone)];
}
export function agendaOccursOn(item: DatedItem, day: string, timezone: string) {
  const range = agendaDayRange(item, timezone);
  return Boolean(range && range[0] <= day && range[1] >= day);
}
