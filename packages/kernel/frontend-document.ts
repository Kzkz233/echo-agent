import {
  appearanceSnapshot,
  extensionBaseStyles,
  type AppearanceSnapshot,
} from '../contracts/appearance.ts';

export const extensionCsp =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

export function extensionDocument(
  html: string,
  bridge: string,
  context: object,
  appearance = appearanceSnapshot(),
) {
  const install = function (bridge: string, context: object, initial: AppearanceSnapshot) {
    let sequence = 0;
    const allowed = new Set(Object.keys(initial.tokens));
    let appearance: AppearanceSnapshot;
    let appearanceRevision = 0;
    const theme = {
      apply(next: AppearanceSnapshot) {
        if (
          !next ||
          next.version !== 1 ||
          !['light', 'dark'].includes(next.mode) ||
          !next.tokens ||
          [...allowed].some(
            (key) =>
              typeof next.tokens[key] !== 'string' ||
              !/^(?:#[a-f0-9]{6}(?:[a-f0-9]{2})?|\d{1,3}px)$/i.test(next.tokens[key]),
          )
        )
          return;
        const tokens = Object.fromEntries([...allowed].map((key) => [key, next.tokens[key]]));
        const revision = ++appearanceRevision;
        document.documentElement.dataset.echoThemeChanging = 'true';
        appearance = Object.freeze({
          version: 1,
          mode: next.mode,
          reducedMotion: next.reducedMotion === true,
          tokens: Object.freeze(tokens),
        });
        for (const [key, value] of Object.entries(tokens))
          document.documentElement.style.setProperty(key, value);
        document.documentElement.style.colorScheme = appearance.mode;
        document.documentElement.dataset.echoTheme = appearance.mode;
        document.documentElement.dataset.echoReducedMotion = String(appearance.reducedMotion);
        dispatchEvent(new CustomEvent('echo-theme-changed', { detail: appearance }));
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (revision === appearanceRevision)
              delete document.documentElement.dataset.echoThemeChanging;
          }),
        );
      },
    };
    theme.apply(initial);
    const calls = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== parent || data?.bridge !== bridge || data?.type !== 'echo:result')
        return;
      const call = calls.get(data.id);
      if (!call) return;
      calls.delete(data.id);
      clearTimeout(call.timer);
      data.error ? call.reject(Error(data.error)) : call.resolve(data.result);
    });
    Object.defineProperty(window, 'Echo', {
      value: Object.freeze({
        context: Object.freeze(context),
        get appearance() {
          return appearance;
        },
        call(operation: string, input: unknown = {}) {
          const id = ++sequence;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              calls.delete(id);
              reject(Error('Echo page request timed out'));
            }, 30000);
            calls.set(id, { resolve, reject, timer });
            parent.postMessage({ type: 'echo:call', bridge, id, operation, input }, '*');
          });
        },
        host(method: string, input: unknown = {}) {
          const id = ++sequence;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              calls.delete(id);
              reject(Error('Echo page request timed out'));
            }, 30000);
            calls.set(id, { resolve, reject, timer });
            parent.postMessage({ type: 'echo:host', bridge, id, method, input }, '*');
          });
        },
      }),
    });
    addEventListener('message', (event) => {
      if (
        event.source === parent &&
        event.data?.bridge === bridge &&
        event.data?.type === 'echo:theme'
      )
        theme.apply(event.data.appearance);
      if (
        event.source === parent &&
        event.data?.bridge === bridge &&
        event.data?.type === 'echo:event'
      )
        dispatchEvent(new CustomEvent('echo-event', { detail: event.data.event }));
    });
    parent.postMessage({ type: 'echo:ready', bridge }, '*');
  };
  return (
    '<!doctype html><meta charset="utf-8"><style>' +
    extensionBaseStyles +
    '</style><script>(' +
    install.toString() +
    ')(' +
    JSON.stringify(bridge) +
    ',' +
    JSON.stringify(context) +
    ',' +
    JSON.stringify(appearance) +
    ');</script>' +
    html
  );
}
