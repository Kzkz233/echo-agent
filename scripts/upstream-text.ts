/** Fetch the same public GitHub file through its contents API if the raw host is unavailable. */
export async function readUpstreamText(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  let failure: unknown;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30000) });
    if (response.ok) return await response.text();
    failure = new Error(`Upstream returned HTTP ${response.status}`);
  } catch (error) { failure = error; }
  const source = new URL(url);
  const [, owner, repository, ref, ...segments] = source.pathname.split('/');
  if (source.protocol === 'https:' && source.hostname === 'raw.githubusercontent.com' &&
      owner && repository && ref && segments.length && !source.search && !source.hash) {
    const path = segments.map(decodeURIComponent).join('/');
    const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      '/contents/' + segments.map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/') +
      '?ref=' + encodeURIComponent(decodeURIComponent(ref));
    try {
      const response = await fetcher(api, { headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`GitHub contents returned HTTP ${response.status}`);
      const body: any = await response.json();
      if (body.type !== 'file' || body.path !== path || body.encoding !== 'base64' || typeof body.content !== 'string')
        throw new Error('GitHub contents did not return the requested file');
      return Buffer.from(body.content.replace(/\s/g, ''), 'base64').toString('utf8');
    } catch (error) { failure = error; }
  }
  throw new Error(`Required upstream text unavailable: ${url}`, { cause: failure });
}
