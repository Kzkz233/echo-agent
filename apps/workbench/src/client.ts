export type Connection = { url: string; token: string };
import { t, errorText } from './i18n.ts';
let current: Connection = { url: location.origin, token: '' };
let sequence = 0;
export async function connect(): Promise<Connection> {
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    current = await invoke<Connection>('connection');
  } else {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get('token');
    if (token) {
      sessionStorage.setItem('echo.connection', JSON.stringify({ url: location.origin, token }));
      history.replaceState(null, '', location.pathname + location.search);
    }
    const saved = sessionStorage.getItem('echo.connection');
    if (saved) current = JSON.parse(saved);
  }
  return current;
}
export function setConnection(connection: Connection) {
  current = connection;
  sessionStorage.setItem('echo.connection', JSON.stringify(connection));
}
export function extensionURL(ticket: string) {
  return current.url + '/extension-view/' + encodeURIComponent(ticket);
}
export async function mediaURL(vaultId: string, hash: string) {
  const grant = await rpc('files.media', { vaultId, hash });
  return current.url + '/media/' + grant.ticket;
}
export async function rpc<T = any>(method: string, params: unknown = {}): Promise<T> {
  const response = await fetch(current.url + '/rpc', {
    method: 'POST',
    headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
  });
  if (response.status === 401)
    throw new Error(t('连接凭据无效，请从 Echo 启动器打开，或填写本机连接信息。'));
  const result = await response.json();
  if (!response.ok || result.error)
    throw new Error(errorText(result.error?.code, result.error?.message ?? '请求未完成。'));
  return result.result;
}
export async function events(callback: (event: any) => void, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const response = await fetch(current.url + '/events', {
        headers: { Authorization: `Bearer ${current.token}` },
        signal,
      });
      if (!response.ok || !response.body) throw Error('事件连接失败。');
      callback({ type: 'connection.ready', data: {} });
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (event.startsWith('data: ')) callback(JSON.parse(event.slice(6)));
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (e) {
      if (signal.aborted) return;
      callback({ type: 'connection.issue', data: {} });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
