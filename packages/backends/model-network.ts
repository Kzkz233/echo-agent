import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { NetworkSettings } from '../contracts/network-settings.ts';
import { Agent, EnvHttpProxyAgent, ProxyAgent } from 'undici';
import { hasEnvironmentProxy } from '../kernel/network.ts';

const execute = promisify(execFile);

// Windows PowerShell uses the user's system proxy resolver, including PAC and its
// per-destination DIRECT decisions. Only the destination is passed to the helper.
async function windowsProxy(destination: string) {
  const shell = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$target = [Uri]$env:ECHO_PROXY_DESTINATION',
    '$proxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy($target)',
    'if ($proxy -and $proxy -ne $target) { $proxy.AbsoluteUri }',
  ].join('\n');
  try {
    const { stdout } = await execute(shell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, ECHO_PROXY_DESTINATION: destination },
      windowsHide: true, timeout: 12000, maxBuffer: 16384,
    });
    const value = stdout.trim();
    if (!value) return;
    const proxy = new URL(value);
    if (['http:', 'https:'].includes(proxy.protocol) && !proxy.username && !proxy.password)
      return proxy.origin;
  } catch {
    throw Error('无法读取 Windows 对模型服务的代理设置，请检查系统代理或 PAC 服务。');
  }
  throw Error('Windows 为模型服务指定的代理类型暂不受支持。');
}

function waitForRoute<T>(route: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return route;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    route.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

function isLoopback(hostname: string) {
  return (isIP(hostname) === 4 && hostname.startsWith('127.')) || hostname === '[::1]' || /(^|\.)localhost\.?$/i.test(hostname);
}

export function windowsModelFetch(resolveProxy = windowsProxy, transport: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  const routes = new Map<string, { expires: number; proxy: Promise<string | undefined> }>();
  const agents = new Map<string, EnvHttpProxyAgent>();
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if ((init && 'dispatcher' in init) || !['https:', 'http:'].includes(url.protocol) || isLoopback(url.hostname))
      return transport(input, init);
    // Match browsers' HTTPS PAC lookup. Avoid disclosing credentials, queries or
    // document paths; ordinary HTTP routing may additionally use the path.
    const destination = url.origin + (url.protocol === 'https:' ? '/' : url.pathname);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const now = Date.now();
    let route = routes.get(destination);
    if (!route || route.expires <= now) {
      for (const [key, value] of routes) if (value.expires <= now) routes.delete(key);
      const next = { expires: now + 60_000, proxy: resolveProxy(destination) };
      routes.set(destination, next);
      next.proxy.catch(() => { if (routes.get(destination) === next) routes.delete(destination); });
      route = next;
    }
    const proxy = await waitForRoute(route.proxy, signal);
    signal?.throwIfAborted();
    let options = init;
    if (proxy) {
      let dispatcher = agents.get(proxy);
      if (!dispatcher) {
        dispatcher = new EnvHttpProxyAgent({ httpProxy: proxy, httpsProxy: proxy });
        agents.set(proxy, dispatcher);
        if (agents.size > 16) {
          const oldest = agents.keys().next().value!;
          const retired = agents.get(oldest)!;
          agents.delete(oldest);
          void retired.close().catch(() => {});
        }
      }
      options = { ...init, dispatcher } as RequestInit;
    }
    try {
      return await transport(input, options);
    } catch (error) {
      // Re-evaluate PAC on the next request if the user's proxy went up or down.
      // Repeating this request could duplicate a charged generation.
      if (!signal?.aborted && routes.get(destination) === route) routes.delete(destination);
      throw error;
    }
  };
}

const systemFetch = windowsModelFetch();
export function createModelNetwork(settings: () => NetworkSettings) {
  const direct = new Agent();
  let manual: { address: string; agent: ProxyAgent } | undefined;
  const request: typeof fetch = (input, init) => {
    const config = settings();
    if (manual && (config.mode !== 'manual' || config.proxy !== manual.address)) {
      void manual.agent.close().catch(() => {});
      manual = undefined;
    }
    const url = new URL(input instanceof Request ? input.url : input);
    const loopback = isLoopback(url.hostname);
    if (config.mode === 'system' && !loopback)
      return process.platform === 'win32' && !hasEnvironmentProxy() ? systemFetch(input, init) : fetch(input, init);
    if (config.mode === 'manual' && !loopback)
      manual ??= { address: config.proxy, agent: new ProxyAgent(config.proxy) };
    return fetch(input, { ...init, dispatcher: loopback ? direct : manual?.agent ?? direct } as RequestInit);
  };
  return { fetch: request, close: () => Promise.all([direct.close(), manual?.agent.close()]) };
}
