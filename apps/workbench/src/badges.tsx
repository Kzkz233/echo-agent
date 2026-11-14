import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';

export function usePageBadges(connected: boolean, page: string, personaId?: string) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    if (!connected) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const next = await rpc('frontend.badges');
      if (!alive) return;
      const visible = document.visibilityState === 'visible' && document.hasFocus();
      const current = next.find((r: any) => r.page === page && r.personaId === personaId);
      if (visible && current?.cursors.length && current.count > current.pending) {
        await rpc('frontend.read', { page, personaId, cursors: current.cursors });
        if (alive) setRows(await rpc('frontend.badges'));
      } else setRows(next);
    };
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load().catch(() => {}), 350);
    };
    const event = (e: any) => {
      if (
        /message|output|notification|approval|knowledge|semantic|task|interaction/.test(
          e.detail?.type ?? '',
        )
      )
        refresh();
    };
    void load().catch(() => {});
    window.addEventListener('echo-event', event);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('echo-event', event);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [connected, page, personaId]);
  return (pages: string[], role?: string) =>
    rows.reduce(
      (sum, r) => sum + (pages.includes(r.page) && r.personaId === role ? r.count : 0),
      0,
    );
}
export function UnreadDot({ count }: { count: number }) {
  return count > 0 ? (
    <span
      className="unread-dot"
      role="status"
      aria-label={t('有未读内容')}
      title={t('有未读内容')}
    />
  ) : null;
}
