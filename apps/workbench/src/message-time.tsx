import { createContext, useContext, useEffect, useState } from 'react';
import { locale } from './i18n.ts';
import { messageTime } from './message-time-format.ts';

export const AppTimezone = createContext<string | undefined>(undefined);
export function useAppTimezone() { return useContext(AppTimezone); }

export function AppTime({ at, detail = false, dateOnly = false }: { at: string | number; detail?: boolean; dateOnly?: boolean }) {
  const timezone = useAppTimezone();
  const date = new Date(at);
  if (!Number.isFinite(+date)) return <>—</>;
  const iso = date.toISOString();
  const value = messageTime(iso, { language: locale(), timezone });
  const title = timezone ? value.title + ' (' + timezone + ')' : value.title;
  return <time dateTime={iso} title={title}>{dateOnly ? value.day : detail ? title : value.label}</time>;
}

// One clock per visible conversation, rather than a timer for every message.
export function useMessageNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
export function MessageTime({ at, timezone, now, className }: { at: string; timezone?: string; now?: Date; className?: string }) {
  const value = messageTime(at, { language: locale(), timezone, now });
  return <time className={className} dateTime={value.day ? at : undefined} title={value.title}>{value.label}</time>;
}
