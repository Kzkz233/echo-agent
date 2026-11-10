import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { EchoError, invariant } from '../contracts/index.ts';
import { deepSeekMcp, deepSeekTools } from './deepseek-search.ts';
import type { Caller, Registry } from './registry.ts';
import type { Secrets } from './secrets.ts';
import type { Store } from './store.ts';

const namespace = 'external-mcp-servers';
const templateId = 'deepseek-search';
const recordId = z.union([z.uuid(), z.literal(templateId)]);
const envSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192));
const endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  );
}, 'Use HTTPS or a loopback HTTP URL, without credentials or query parameters.');
const config = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deepseek'),
    enabled: z.boolean(),
    token: z.string().trim().max(8192).optional(),
  }),
  z.object({
    kind: z.literal('http'),
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    url: endpoint,
    token: z.string().trim().max(8192).optional(),
  }),
  z.object({
    kind: z.literal('stdio'),
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    command: z.string().trim().min(1).max(1000),
    args: z.array(z.string().max(2000)).max(48),
    cwd: z.string().trim().max(1000).optional(),
    env: envSchema.optional(),
    confirmed: z.literal(true),
  }),
]);
const settings = z.object({ id: recordId.optional(), config });
type ConnectionConfig = z.infer<typeof config>;
type Descriptor = Pick<Tool, 'name' | 'description' | 'inputSchema'>;
type Connection = {
  id: string;
  identity: string;
  name: string;
  enabled: boolean;
  credential?: string;
  config:
    | { kind: 'deepseek' }
    | { kind: 'http'; url: string }
    | { kind: 'stdio'; command: string; args: string[]; cwd?: string };
  tools: Descriptor[];
};
type Session = { controller: AbortController; ready: Promise<Client>; close: () => Promise<void> };
const defaultDeepSeek: Connection = {
  id: templateId,
  identity: templateId,
  name: 'DeepSeek 网页搜索',
  enabled: true,
  config: { kind: 'deepseek' },
  tools: deepSeekTools as Descriptor[],
};

function operation(connection: Connection, tool: Descriptor) {
  const suffix = createHash('sha256').update(tool.name).digest('hex').slice(0, 12);
  const stem = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  const base =
    connection.config.kind === 'deepseek'
      ? `web.${tool.name}`
      : `external_mcp_${connection.identity.replaceAll('-', '').slice(0, 12)}.${stem}_${suffix}`;
  return {
    name: base,
    permission: `${base}.${connection.config.kind === 'deepseek' ? 'read' : 'write'}`,
  };
}

function publicRecord(connection: Connection) {
  const { id, name, config, enabled, tools, credential } = connection;
  return {
    id,
    name,
    config,
    enabled,
    hasCredential: Boolean(credential),
    tools: tools.map((tool) => ({
      ...operation(connection, tool),
      title: tool.name,
      description: tool.description,
    })),
  };
}

export class ExternalMcp {
  private readonly sessions = new Map<string, Session>();
  private readonly registrations = new Map<string, (() => void)[]>();
  private readonly lifecycle = new AbortController();
  private queue = Promise.resolve();
  constructor(
    private readonly store: Store,
    private readonly secrets: Secrets,
    private readonly registry: Registry,
    private readonly authorize: (caller: Caller, permission: string) => boolean,
    private readonly changed: () => void,
    private readonly request: typeof fetch = fetch,
  ) {}

  private connections() {
    const saved = this.store.documents<Connection>(namespace);
    return saved.some((row) => row.id === templateId) ? saved : [defaultDeepSeek, ...saved];
  }

  list() {
    return this.connections().map(publicRecord);
  }

  pendingPermissions() {
    const deepSeek = this.connections().find((row) => row.id === templateId)!;
    return !deepSeek.enabled || !deepSeek.credential ? publicRecord(deepSeek).tools : [];
  }

  install() {
    for (const connection of this.connections()) this.register(connection);
    const op = (
      name: string,
      input: z.ZodType,
      run: (value: any, signal: AbortSignal) => unknown,
    ) =>
      this.registry.register({
        name: `external-mcp.${name}`,
        description: 'Manage external MCP',
        owner: 'core',
        permission: name === 'list' ? 'system.read' : 'system.write',
        mcp: false,
        input,
        output: z.unknown(),
        run: (value, caller, signal) => {
          invariant(
            caller.kind === 'ui' || caller.kind === 'internal',
            'permission_denied',
            'External MCP settings require the workbench.',
          );
          return run(value, signal);
        },
      });
    op('list', z.object({}), () => this.list());
    op('save', settings, (value) => this.serial(() => this.save(value)));
    op('discover', z.object({ id: recordId }), (value, signal) =>
      this.serial(() => this.discover(value.id, signal)),
    );
    op('remove', z.object({ id: z.uuid() }), (value) => this.serial(() => this.remove(value.id)));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      this.lifecycle.signal.throwIfAborted();
      return fn();
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async save({ id, config: value }: z.infer<typeof settings>) {
    const existing = id ? this.connections().find((row) => row.id === id) : undefined;
    invariant(!id || existing, 'not_found', 'External MCP server not found.');
    invariant(
      value.kind !== 'deepseek' || id === templateId,
      'invalid_mcp',
      'Use the DeepSeek search template.',
    );
    invariant(
      id !== templateId || value.kind === 'deepseek',
      'invalid_mcp',
      'The DeepSeek template has a fixed endpoint.',
    );
    const nextConfig = this.transportConfig(value);
    const sameDestination = JSON.stringify(existing?.config) === JSON.stringify(nextConfig);
    const next: Connection = {
      id: id ?? randomUUID(),
      identity: sameDestination ? existing!.identity : randomUUID(),
      name: value.kind === 'deepseek' ? defaultDeepSeek.name : value.name,
      enabled: value.enabled,
      config: nextConfig,
      tools: sameDestination ? existing!.tools : [],
      credential: sameDestination ? existing?.credential : undefined,
    };
    const secret = value.kind === 'stdio' ? value.env && JSON.stringify(value.env) : value.token;
    if (secret) {
      next.credential = `external-mcp-${randomUUID()}`;
      await this.secrets.set(next.credential, secret);
    }
    try {
      this.store.put(namespace, next.id, next);
    } catch (error) {
      if (next.credential !== existing?.credential && next.credential)
        await this.secrets.remove(next.credential);
      throw error;
    }
    const closing = this.stop(next.id);
    this.register(next);
    if (existing?.credential && existing.credential !== next.credential)
      await this.secrets.remove(existing.credential);
    await closing;
    this.changed();
    return publicRecord(next);
  }

  private transportConfig(value: ConnectionConfig): Connection['config'] {
    switch (value.kind) {
      case 'deepseek':
        return { kind: value.kind };
      case 'http':
        return { kind: value.kind, url: value.url };
      case 'stdio':
        return {
          kind: value.kind,
          command: value.command,
          args: value.args,
          cwd: value.cwd || undefined,
        };
    }
  }

  private async remove(id: string) {
    const connection = this.store.document<Connection>(namespace, id);
    invariant(connection, 'not_found', 'External MCP server not found.');
    this.store.remove(namespace, id);
    const closing = this.stop(id);
    this.unregister(id);
    if (connection.credential) await this.secrets.remove(connection.credential);
    await closing;
    this.changed();
    return { id };
  }

  private async discover(id: string, signal: AbortSignal) {
    const connection = this.connections().find((row) => row.id === id);
    invariant(connection, 'not_found', 'External MCP server not found.');
    const temporary = !connection.enabled;
    const session = temporary ? this.open(connection) : this.session(connection);
    const combined = AbortSignal.any([signal, session.controller.signal]);
    try {
      const client = await session.ready;
      const tools = new Map<string, Descriptor>();
      let cursor: string | undefined;
      let page = 0;
      do {
        invariant(
          ++page <= 8,
          'mcp_catalog_limit',
          'External MCP tool catalog exceeds the discovery limit.',
        );
        const result = await client.listTools({ cursor }, { timeout: 12_000, signal: combined });
        for (const { name, description, inputSchema } of result.tools) {
          invariant(
            !tools.has(name) &&
              tools.size < 64 &&
              name.length <= 128 &&
              JSON.stringify(inputSchema).length <= 32_000,
            'mcp_catalog_limit',
            'Invalid or oversized external MCP tool catalog.',
          );
          tools.set(name, { name, description: description?.slice(0, 1200), inputSchema });
        }
        cursor = result.nextCursor;
      } while (cursor);
      combined.throwIfAborted();
      const updated = { ...connection, tools: [...tools.values()] };
      this.store.put(namespace, id, updated);
      this.register(updated);
      this.changed();
      return publicRecord(updated);
    } catch (error) {
      if (!temporary) await this.stop(id);
      throw this.failure(error);
    } finally {
      if (temporary) await session.close();
    }
  }

  private unregister(id: string) {
    for (const dispose of this.registrations.get(id) ?? []) dispose();
    this.registrations.delete(id);
  }

  private register(connection: Connection) {
    this.unregister(connection.id);
    if (!connection.enabled || (connection.config.kind === 'deepseek' && !connection.credential))
      return;
    this.registrations.set(
      connection.id,
      connection.tools.map((tool) => {
        const { name, permission } = operation(connection, tool);
        let input: z.ZodType;
        try {
          input = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
        } catch {
          input = z.object({}).catchall(z.unknown());
        }
        return this.registry.register({
          name,
          permission,
          description: tool.description || tool.name,
          owner: 'external-mcp',
          mcp: true,
          roleOnly: true,
          input,
          toolInputSchema: tool.inputSchema,
          output: z.unknown(),
          run: async (args, caller, signal) => {
            invariant(
              this.authorize(caller, permission),
              'permission_denied',
              'The role has not been granted this external MCP tool.',
            );
            const session = this.session(connection);
            try {
              const client = await session.ready;
              const combined = AbortSignal.any([signal, session.controller.signal]);
              combined.throwIfAborted();
              invariant(
                this.authorize(caller, permission),
                'permission_denied',
                'The role has not been granted this external MCP tool.',
              );
              const result = CallToolResultSchema.parse(
                await client.callTool({ name: tool.name, arguments: args }, CallToolResultSchema, {
                  timeout: 35_000,
                  signal: combined,
                }),
              );
              if (result.isError) {
                const detail =
                  connection.config.kind === 'deepseek'
                    ? result.content.find((item) => item.type === 'text')?.text
                    : '';
                const status = detail?.match(/DeepSeek Search HTTP (\d{3})/)?.[1];
                throw new EchoError(
                  'mcp_tool_failed',
                  status
                    ? `DeepSeek Search HTTP ${status}`
                    : 'The external MCP tool returned an error.',
                );
              }
              invariant(
                JSON.stringify(result).length <= 120_000,
                'mcp_output_limit',
                'The external MCP result is too large.',
              );
              return { content: result.content, structuredContent: result.structuredContent };
            } catch (error) {
              if (
                error instanceof StreamableHTTPError &&
                [404, 410].includes(error.code ?? 0) &&
                this.sessions.get(connection.id) === session
              )
                await this.stop(connection.id);
              throw this.failure(error);
            }
          },
        });
      }),
    );
  }

  private failure(error: unknown) {
    if (error instanceof EchoError) return error;
    if (error instanceof StreamableHTTPError && error.code)
      return new EchoError('mcp_connection', `External MCP HTTP ${error.code}`);
    return new EchoError(
      'mcp_connection',
      'External MCP request failed. Check the connection settings and try again.',
    );
  }

  private open(connection: Connection): Session {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifecycle.signal]);
    const client = new Client({ name: 'echo-agent', version: '1.0.0' });
    let disposePeer: (() => Promise<void>) | undefined;
    const ready = (async () => {
      const key = connection.credential ? await this.secrets.get(connection.credential) : undefined;
      signal.throwIfAborted();
      const config = connection.config;
      if (config.kind === 'deepseek') {
        invariant(key, 'mcp_credentials', 'Enter a DeepSeek API key first.');
        const local = await deepSeekMcp(key, this.request);
        disposePeer = local.close;
        await client.connect(local.transport, { signal, timeout: 12_000 });
      } else {
        const transport =
          config.kind === 'http'
            ? new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: {
                  headers: key ? { Authorization: `Bearer ${key}` } : undefined,
                  redirect: 'error',
                },
                fetch: (input, init) =>
                  this.request(input, {
                    ...init,
                    redirect: 'error',
                    ...(init?.method === 'DELETE'
                      ? {
                          signal: AbortSignal.any([
                            AbortSignal.timeout(2000),
                            ...(init.signal ? [init.signal] : []),
                          ]),
                        }
                      : {}),
                  }),
              })
            : new StdioClientTransport({
                command: config.command,
                args: config.args,
                cwd: config.cwd,
                env: key ? envSchema.parse(JSON.parse(key)) : undefined,
                stderr: 'ignore',
                maxBufferSize: 1_000_000,
              });
        if (transport instanceof StreamableHTTPClientTransport && config.kind === 'http')
          disposePeer = () => transport.terminateSession();
        await client.connect(transport, { signal, timeout: 12_000 });
      }
      return client;
    })();
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        controller.abort();
        await ready.catch(() => {});
        await disposePeer?.().catch(() => {});
        await client.close().catch(() => {});
      })());
    const session = { controller, ready, close };
    client.onclose = () => {
      if (this.sessions.get(connection.id) === session) this.sessions.delete(connection.id);
    };
    void ready.catch(() => close());
    return session;
  }

  private session(connection: Connection) {
    const existing = this.sessions.get(connection.id);
    if (existing) return existing;
    const session = this.open(connection);
    this.sessions.set(connection.id, session);
    return session;
  }

  private async stop(id: string) {
    const current = this.sessions.get(id);
    this.sessions.delete(id);
    await current?.close();
  }

  async close() {
    this.lifecycle.abort();
    await this.queue;
    for (const id of this.registrations.keys()) this.unregister(id);
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
