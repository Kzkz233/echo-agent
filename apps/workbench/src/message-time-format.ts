const formats = new Map<string, Intl.DateTimeFormat>();
function formatter(language: string, timezone: string | undefined, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify([language, timezone, options]);
  let value = formats.get(key);
  if (!value) {
    try { value = new Intl.DateTimeFormat(language, { ...options, timeZone: timezone }); }
    catch { value = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }); }
    formats.set(key, value);
  }
  return value;
}
export function messageDay(at: Date, timezone?: string): string {
  if (!Number.isFinite(at.getTime())) return '';
  const parts = formatter('en-CA', timezone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-');
}
export function messageTime(value: string, options: { language: string; timezone?: string; now?: Date }) {
  const at = new Date(value), now = options.now ?? new Date();
  if (!Number.isFinite(at.getTime())) return { label: '—', title: '', day: '' };
  const { language, timezone } = options;
  const day = messageDay(at, timezone), today = messageDay(now, timezone);
  // Calendar arithmetic, rather than elapsed hours, also handles daylight-saving days.
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  const clock = formatter(language, timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const date = day === today ? '' : day === yesterday ? (language.startsWith('zh') ? '昨天' : 'Yesterday') :
    formatter(language, timezone, { ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}), month: 'numeric', day: 'numeric' }).format(at);
  return {
    day, label: [date, clock].filter(Boolean).join(' '),
    title: formatter(language, timezone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(at),
  };
}
