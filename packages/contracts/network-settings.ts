import { z } from 'zod';

const proxyAddress = z.string().trim().max(2048).url().refine(value => {
  const url = URL.parse(value);
  return !!url && ['http:', 'https:'].includes(url.protocol) && !!url.hostname && url.port !== '0' &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
}, '请输入 HTTP 或 HTTPS 代理地址，可包含端口。').transform(value => new URL(value).origin);

export const networkSettings = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('system') }),
  z.object({ mode: z.literal('direct') }),
  z.object({ mode: z.literal('manual'), proxy: proxyAddress }),
]);
export type NetworkSettings = z.infer<typeof networkSettings>;
export const defaultNetworkSettings: NetworkSettings = { mode: 'system' };
