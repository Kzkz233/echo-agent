import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ExternalMcp } from '../packages/kernel/external-mcp.ts';
import { internal, Registry, type Caller } from '../packages/kernel/registry.ts';
import { Secrets } from '../packages/kernel/secrets.ts';
import { Store } from '../packages/kernel/store.ts';
import { temporary, setup, conversation } from './helpers.ts';
import { PiBackend } from '../packages/backends/pi.ts';
import { conversationPermissions } from '../packages/contracts/interaction.ts';

const role: Caller = {
  kind: 'mcp',
  personaId: 'role',
  conversationId: 'thread',
  permissions: new Set(),
};
const token = 'synthetic-external-mcp-test-credential';

test('the DeepSeek template is inert until configured and uses the shared role tool boundary', async (t) => {
  const root = await temporary(t, false);
  const store = new Store(join(root, 'echo.sqlite')),
    registry = new Registry();
  const requests: { url: string; body: unknown }[] = [];
  const granted = new Set(['web.search.read', 'web.fetch.read']);
  const mcp = new ExternalMcp(
    store,
    new Secrets(join(root, 'keys')),
    registry,
    (_caller, permission) => granted.has(permission),
    () => {},
    async (input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json(
        url.endsWith('/search')
          ? {
              results: [
                {
                  title: 'Fixture',
                  url: 'https://example.org/page',
                  snippet: 'Excerpt',
                  content: 'omit me',
                },
              ],
            }
          : { title: 'Fixture', content: 'Fetched document' },
      );
    },
  );
  t.after(async () => {
    await mcp.close();
    store.close();
    await (await import('node:fs/promises')).rm(root, { recursive: true, force: true });
  });
  mcp.install();
  const [initial] = mcp.list();
  assert.equal(initial.id, 'deepseek-search');
  assert.equal(initial.hasCredential, false);
  assert.equal(registry.list(internal, true).length, 0);
  assert.deepEqual(
    mcp.pendingPermissions().map((tool) => tool.permission),
    [...granted],
  );
  await assert.rejects(
    registry.call('external-mcp.discover', { id: initial.id }, internal),
    /API key/,
  );
  const saved = await registry.call(
    'external-mcp.save',
    { id: initial.id, config: { kind: 'deepseek', enabled: true, token } },
    internal,
  );
  assert.equal(saved.hasCredential, true);
  assert(!JSON.stringify(saved).includes(token));
  assert(!JSON.stringify(store.documents('external-mcp-servers')).includes(token));
  await registry.call('external-mcp.discover', { id: initial.id }, internal);
  assert.equal(requests.length, 0, 'discovery must not bill or validate the key');
  const caller = { ...role, permissions: new Set(granted) };
  assert.equal(registry.list({ kind: 'mcp', permissions: new Set(['*']) }, true).length, 0);
  await assert.rejects(registry.call('web.search', { query: 'fixture' }, role), /权限/);
  const result = await registry.call('web.search', { query: 'fixture' }, caller);
  assert.match(result.content[0].text, /Excerpt/);
  assert.doesNotMatch(result.content[0].text, /omit me/);
  assert.deepEqual(requests[0], {
    url: 'https://api.deepseek.com/v1/tools/search',
    body: { query: 'fixture', count: 5, need_content: false },
  });
  assert.match(
    (await registry.call('web.fetch', { url: 'https://example.org/page' }, caller)).content[0].text,
    /Fetched document/,
  );
  granted.delete('web.search.read');
  await assert.rejects(
    registry.call('web.search', { query: 'stale grant' }, caller),
    /not been granted/,
  );
  const disabled = await registry.call(
    'external-mcp.save',
    { id: initial.id, config: { kind: 'deepseek', enabled: false, token: '' } },
    internal,
  );
  assert.equal(disabled.hasCredential, true);
  assert.equal(registry.list(caller, true).length, 0);
});

test('an HTTP MCP server can be discovered and used through Pi role permissions', async (t) => {
  const app = await setup(t, []);
  const c = conversation(app);
  let calls = 0;
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const mcp = new McpServer({ name: 'fixture', version: '1.0.0' });
    mcp.registerTool(
      'fixture-lookup',
      { inputSchema: z.object({ id: z.enum(['alpha', 'beta']) }) },
      ({ id }) => {
        calls++;
        return { content: [{ type: 'text', text: id }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('finish', () => void mcp.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => http.closeAllConnections());
  t.after(() => http.close());
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  const { id } = await app.registry.call(
    'external-mcp.save',
    { config: { kind: 'http', name: 'Fixture', enabled: true, url, token } },
    internal,
  );
  const found = await app.registry.call('external-mcp.discover', { id }, internal);
  const [tool] = found.tools;
  assert.equal(tool.title, 'fixture-lookup');
  assert(calls === 0);
  const principal = { personaId: c.personaId, conversationId: c.id };
  const untrusted = { kind: 'mcp' as const, ...principal, permissions: new Set([tool.permission]) };
  await assert.rejects(
    app.registry.call(tool.name, { id: 'alpha' }, untrusted),
    /not been granted/,
  );
  app.store.put('characters', c.personaId, {
    id: c.personaId,
    mainConversationId: c.id,
    independentToolGrants: true,
    toolPermissions: [tool.permission],
  });
  const catalog = await app.registry.call('system.bootstrap', {}, internal);
  assert.equal(
    catalog.mcpPermissionCatalog.find((row: any) => row.permission === tool.permission)?.external
      .tool,
    'fixture-lookup',
  );
  assert(!catalog.mcpAvailablePermissions.includes(tool.permission));
  assert(!JSON.stringify(catalog.externalMcpServers).includes(token));
  const pi = new PiBackend(
    app.registry,
    async () => undefined,
    () => untrusted.permissions,
  );
  assert(
    pi
      .toolCatalog({
        principal,
        permissions: conversationPermissions.parse({ pi: { echoTools: 'ask' } }),
      })
      .some((row) => row.name === tool.name.replaceAll('.', '_')),
  );
  assert.equal(
    (await app.registry.call(tool.name, { id: 'beta' }, untrusted)).content[0].text,
    'beta',
  );
  assert.equal(calls, 1);
  const changed = await app.registry.call(
    'external-mcp.save',
    { id, config: { kind: 'http', name: 'Other endpoint', enabled: true, url: url + '-changed' } },
    internal,
  );
  assert.equal(changed.hasCredential, false);
  assert.deepEqual(changed.tools, []);
  await assert.rejects(app.registry.call(tool.name, { id: 'alpha' }, untrusted), /未找到/);
});

test('stdio tools are opt-in, keep process state between calls and retire on removal', async (t) => {
  const app = await setup(t, []);
  const path = join(app.runtime, 'test-mcp.mjs');
  await writeFile(
    path,
    `
import { createInterface } from 'node:readline';
let count = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  const results = {
    initialize: { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } },
    'tools/list': { tools: [{ name: 'state', inputSchema: { type: 'object', properties: {} } }] },
    'tools/call': { content: [{ type: 'text', text: String(msg.method === 'tools/call' ? ++count : count) }] },
  };
  if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: results[msg.method] }) + '\\n');
}`,
  );
  const config = {
    kind: 'stdio',
    name: 'Fixture stdio',
    enabled: true,
    command: process.execPath,
    args: [path],
  };
  await assert.rejects(app.registry.call('external-mcp.save', { config }, internal));
  const { id } = await app.registry.call(
    'external-mcp.save',
    { config: { ...config, confirmed: true } },
    internal,
  );
  const {
    tools: [tool],
  } = await app.registry.call('external-mcp.discover', { id }, internal);
  const c = conversation(app);
  app.store.put('characters', c.personaId, {
    id: c.personaId,
    independentToolGrants: true,
    toolPermissions: [tool.permission],
  });
  const caller = {
    ...role,
    personaId: c.personaId,
    conversationId: c.id,
    permissions: new Set([tool.permission]),
  };
  assert.equal((await app.registry.call(tool.name, {}, caller)).content[0].text, '1');
  assert.equal((await app.registry.call(tool.name, {}, caller)).content[0].text, '2');
  await app.registry.call('external-mcp.remove', { id }, internal);
  await assert.rejects(app.registry.call(tool.name, {}, caller), /未找到/);
});
