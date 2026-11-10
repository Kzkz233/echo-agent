import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
let configured = false;
export function configureNetwork() {
  if (configured) return;
  configured = true;
  if (
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy
  )
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        noProxy: [
          process.env.NO_PROXY ?? process.env.no_proxy ?? '',
          '127.0.0.1',
          'localhost',
          '::1',
        ]
          .filter(Boolean)
          .join(','),
      }),
    );
}
