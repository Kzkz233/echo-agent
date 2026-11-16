import test from 'node:test';
import assert from 'node:assert/strict';
import { readUpstreamText } from '../scripts/upstream-text.ts';

test('license download preserves the exact repository, revision and path on GitHub API fallback', async () => {
  const urls: string[] = [];
  const text = 'Synthetic license text';
  const result = await readUpstreamText('https://raw.githubusercontent.com/example/library/v1.2.3/legal/LICENSE.txt', async input => {
    urls.push(String(input));
    if (urls.length === 1) throw new TypeError('Synthetic raw-host reset');
    return Response.json({ type: 'file', path: 'legal/LICENSE.txt', encoding: 'base64', content: Buffer.from(text).toString('base64') });
  });
  assert.equal(result, text);
  assert.equal(urls[1], 'https://api.github.com/repos/example/library/contents/legal/LICENSE.txt?ref=v1.2.3');
});

test('license downloads fail closed for missing or mismatched upstream files', async () => {
  await assert.rejects(readUpstreamText('https://raw.githubusercontent.com/example/library/v1/LICENSE', async input =>
    String(input).includes('raw.githubusercontent.com') ? new Response('', { status: 404 }) :
      Response.json({ type: 'file', path: 'OTHER', encoding: 'base64', content: 'dGV4dA==' })), /unavailable/);
  let calls = 0;
  await assert.rejects(readUpstreamText('https://example.invalid/LICENSE', async () => {
    calls++; return new Response('', { status: 503 });
  }), /unavailable/);
  assert.equal(calls, 1);
});
