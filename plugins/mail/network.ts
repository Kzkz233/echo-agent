import { invariant } from '../../packages/contracts/index.ts';

/** Resolve at connection time; proxy credentials never enter account documents. */
export function mailProxy(
  mode: 'direct' | 'environment-proxy' | undefined,
  host: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (
    mode !== 'environment-proxy' ||
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase())
  )
    return undefined;
  const value = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  invariant(value, 'mail_proxy_missing', '环境中未配置 HTTP(S) 代理');
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    /* Never expose a credential-bearing URL. */
  }
  invariant(
    parsed && ['http:', 'https:'].includes(parsed.protocol),
    'mail_proxy_protocol',
    '邮件环境代理需要 HTTP(S) CONNECT 地址',
  );
  return parsed.href;
}
