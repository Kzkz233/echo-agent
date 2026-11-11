export const extensionCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

export function extensionDocument(html: string, bridge: string, context: object) {
  const install = function (bridge: string, context: object) {
    let sequence = 0;
    const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== parent || data?.bridge !== bridge || data?.type !== 'echo:result') return;
      const call = calls.get(data.id);
      if (!call) return;
      calls.delete(data.id); clearTimeout(call.timer);
      data.error ? call.reject(Error(data.error)) : call.resolve(data.result);
    });
    Object.defineProperty(window, 'Echo', { value: Object.freeze({ context: Object.freeze(context),
      call(operation: string, input: unknown = {}) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { calls.delete(id); reject(Error('Echo page request timed out')); }, 30000);
          calls.set(id, { resolve, reject, timer });
          parent.postMessage({ type: 'echo:call', bridge, id, operation, input }, '*');
        });
      },
      host(method: string, input: unknown = {}) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { calls.delete(id); reject(Error('Echo page request timed out')); }, 30000);
          calls.set(id, { resolve, reject, timer });
          parent.postMessage({ type: 'echo:host', bridge, id, method, input }, '*');
        });
      },
    }) });
    addEventListener('message', (event) => {
      if (event.source === parent && event.data?.bridge === bridge && event.data?.type === 'echo:event')
        dispatchEvent(new CustomEvent('echo-event', { detail: event.data.event }));
    });
  };
  return '<!doctype html><meta charset="utf-8"><script>(' + install.toString() + ')(' +
    JSON.stringify(bridge) + ',' + JSON.stringify(context) + ');</script>' + html;
}
