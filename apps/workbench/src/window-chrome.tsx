import { useEffect, useRef, useState } from 'react';
import { t } from './i18n.ts';
import { requestNavigation } from './ui.tsx';

// The native window factory opts in before the first document script runs.
// Browser access and other platforms retain their normal system decorations.
export const nativeWindowChrome = Boolean(
  (window as unknown as { __ECHO_WINDOW_CHROME__?: boolean }).__ECHO_WINDOW_CHROME__,
);
if (nativeWindowChrome) document.documentElement.dataset.echoWindowChrome = 'true';

export function WindowControls({ guarded = true }: { guarded?: boolean }) {
  const maximize = useRef<HTMLButtonElement>(null);
  const owner = useRef(crypto.randomUUID());
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [snap, setSnap] = useState({ hovered: false, pressed: false });
  const [issue, setIssue] = useState('');
  useEffect(() => {
    if (!nativeWindowChrome) return;
    let active = true,
      frame = 0,
      sending = false,
      again = false,
      previous = '';
    const disposers: (() => void)[] = [];
    let send: (() => void) | undefined;
    const schedule = () => {
      if (!active || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        send?.();
      });
    };
    const observer = new ResizeObserver(schedule);
    if (maximize.current) observer.observe(maximize.current);
    observer.observe(document.documentElement);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    void (async () => {
      const [{ getCurrentWindow }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/core'),
      ]);
      if (!active) return;
      const current = getCurrentWindow();
      const refresh = async () => {
        const value = await current.isMaximized();
        if (active) setMaximized(value);
        schedule();
      };
      const listen = async (promise: Promise<() => void>) => {
        const off = await promise;
        if (active) disposers.push(off);
        else off();
      };
      await Promise.all([
        refresh(),
        listen(current.onResized(() => void refresh())),
        listen(current.onScaleChanged(schedule)),
        listen(
          current.onFocusChanged((event) => {
            if (active) setFocused(event.payload);
          }),
        ),
        listen(
          current.listen<{ hovered: boolean; pressed: boolean }>('echo:chrome-snap', (event) => {
            if (active) setSnap(event.payload);
          }),
        ),
      ]);
      send = () => {
        if (!active || !maximize.current) return;
        if (sending) {
          again = true;
          return;
        }
        const rect = maximize.current.getBoundingClientRect(),
          scale = window.devicePixelRatio;
        if (!rect.width || !rect.height) return;
        const bounds = {
          right: Math.round((window.innerWidth - rect.right) * scale),
          top: Math.round(rect.top * scale),
          width: Math.round(rect.width * scale),
          height: Math.round(rect.height * scale),
          scale,
        };
        const key = JSON.stringify(bounds);
        if (key === previous) return;
        sending = true;
        void invoke<boolean>('window_chrome_update', { owner: owner.current, bounds })
          .then((ok) => {
            if (ok) {
              previous = key;
              if (active) setIssue('');
            }
          })
          .catch((error) => {
            if (active) setIssue(String(error));
          })
          .finally(() => {
            sending = false;
            if (again) {
              again = false;
              schedule();
            }
          });
      };
      if (active) schedule();
      disposers.push(() => {
        void invoke('window_chrome_update', { owner: owner.current, bounds: null }).catch(() => {});
      });
    })().catch((error) => {
      if (active) setIssue(String(error));
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      for (const off of disposers) off();
    };
  }, []);
  if (!nativeWindowChrome) return null;
  const act = async (action: 'minimize' | 'maximize' | 'close') => {
    try {
      const current = (await import('@tauri-apps/api/window')).getCurrentWindow();
      if (action === 'minimize') await current.minimize();
      else if (action === 'maximize') await current.toggleMaximize();
      else if (guarded)
        requestNavigation(() => void current.close().catch((error) => setIssue(String(error))));
      else await current.close();
    } catch (error) {
      setIssue(String(error));
    }
  };
  return (
    <div
      className="window-controls"
      data-tauri-drag-region="false"
      data-focused={focused}
      role="group"
      aria-label={t('窗口操作')}
    >
      <button
        className="window-control"
        aria-label={t('最小化窗口')}
        title={t('最小化窗口')}
        onClick={() => void act('minimize')}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8h10" />
        </svg>
      </button>
      <button
        ref={maximize}
        className="window-control window-maximize"
        data-native-hover={snap.hovered}
        data-native-pressed={snap.pressed}
        aria-label={t(maximized ? '还原窗口' : '最大化窗口')}
        title={t(maximized ? '还原窗口' : '最大化窗口')}
        onClick={() => void act('maximize')}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          {maximized ? <path d="M5 5V3h8v8h-2M3 5h8v8H3z" /> : <path d="M3 3h10v10H3z" />}
        </svg>
      </button>
      <button
        className="window-control window-close"
        aria-label={t('关闭窗口')}
        title={t('关闭窗口')}
        onClick={() => void act('close')}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m3 3 10 10M3 13 13 3" />
        </svg>
      </button>
      {issue && (
        <span role="status" className="window-controls-issue">
          {t('窗口操作失败')} · {issue}
        </span>
      )}
    </div>
  );
}
