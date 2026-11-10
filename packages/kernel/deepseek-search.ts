import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EchoError } from '../contracts/index.ts';

const search = z.object({
  query: z.string().trim().min(1).max(128),
  count: z.number().int().min(1).max(10).optional(),
});
const fetchPage = z.object({ url: z.url({ protocol: /^https?$/ }) });

export const deepSeekTools = [
  {
    name: 'search',
    description:
      'Search the live web with DeepSeek. Returns titles, links, and snippets. Send only the search terms needed.',
    inputSchema: z.toJSONSchema(search),
  },
  {
    name: 'fetch',
    description:
      'Read a public webpage using DeepSeek Fetch. Use a result URL when you need to verify the source.',
    inputSchema: z.toJSONSchema(fetchPage),
  },
];

export async function deepSeekMcp(key: string, request: typeof fetch) {
  const server = new McpServer({ name: 'echo-deepseek-search', version: '1.0.0' });
  const invoke = async (path: 'search' | 'fetch', body: object, signal: AbortSignal) => {
    const response = await request(`https://api.deepseek.com/v1/tools/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new EchoError('deepseek_search_failed', `DeepSeek Search HTTP ${response.status}`);
    }
    return (await response.json()) as any;
  };
  server.registerTool(
    'search',
    { description: deepSeekTools[0].description, inputSchema: search },
    async (input, extra) => {
      const result = await invoke(
        'search',
        { query: input.query, count: input.count ?? 5, need_content: false },
        extra.signal,
      );
      if (!Array.isArray(result.results)) throw new Error('Invalid DeepSeek search response');
      const results = result.results.slice(0, input.count ?? 5).map((row: any) => ({
        title: String(row.title ?? '').slice(0, 300),
        url: String(row.url ?? '').slice(0, 4096),
        snippet: String(row.snippet ?? row.summary ?? '').slice(0, 1200),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
    },
  );
  server.registerTool(
    'fetch',
    { description: deepSeekTools[1].description, inputSchema: fetchPage },
    async ({ url }, extra) => {
      const address = new URL(url);
      if (address.username || address.password)
        throw new Error('Webpage URLs cannot contain credentials');
      const result = await invoke('fetch', { url }, extra.signal);
      if (typeof result.content !== 'string') throw new Error('Invalid DeepSeek fetch response');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url,
              title: String(result.title ?? '').slice(0, 300),
              content: result.content.slice(0, 24_000),
              truncated: result.content.length > 24_000,
            }),
          },
        ],
      };
    },
  );
  const [client, peer] = InMemoryTransport.createLinkedPair();
  await server.connect(peer);
  return { transport: client, close: () => server.close() };
}
