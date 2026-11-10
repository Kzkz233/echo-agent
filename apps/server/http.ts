import { listenBrowserHttp } from '../../packages/kernel/http-listener.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { z } from 'zod';
import { EchoError } from '../../packages/contracts/index.ts';
import { internal } from '../../packages/kernel/registry.ts';
import { Application } from './application.ts';
import { version } from '../../packages/contracts/version.ts';
import { echoToolPermissions } from '../../packages/kernel/tool-access.ts';
import type { AgentPrincipal } from '../../packages/contracts/index.ts';
import { extensionCsp } from '../../packages/kernel/frontend-document.ts';
import { cliRequest } from './cli-rpc.ts';

export async function serve(
  app: Application,
  options: { port?: number; webRoot: string; token?: string },
) {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const harnessPrincipals = new Map<string, AgentPrincipal>();
  const principalTokens = new Map<string, string>();
  const authorized = (req: IncomingMessage, credential: string) => {
    const received = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const expected = Buffer.from(credential);
    return received.length === expected.length && timingSafeEqual(received, expected);
  };
  const connections = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
    const allowedOrigin =
      !origin ||
      origin === `http://${host}` ||
      [
        'http://tauri.localhost',
        'https://tauri.localhost',
        'tauri://localhost',
        'http://127.0.0.1:5173',
        'http://localhost:5173',
      ].includes(origin);
    if (!localHost || !allowedOrigin) {
      res.writeHead(403).end();
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, version }));
      return;
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const harnessPrincipal =
      url.pathname === '/mcp' ? harnessPrincipals.get(bearer) : undefined;
    const harness = Boolean(harnessPrincipal);
    if (['/rpc', '/events', '/mcp', '/cli'].includes(url.pathname) && !authorized(req, token) && !harness) {
      res.writeHead(401).end();
      return;
    }
    if (harnessPrincipal) {
      const conversation = app.store.conversation(harnessPrincipal.conversationId);
      if (!conversation || conversation.personaId !== harnessPrincipal.personaId) {
        harnessPrincipals.delete(bearer);
        res.writeHead(401).end();
        return;
      }
    }
    try {
      if (url.pathname.startsWith('/extension-view/') && req.method === 'GET') {
        const ticket = url.pathname.slice('/extension-view/'.length);
        if (!/^[\w-]{32}$/.test(ticket)) { res.writeHead(404).end(); return; }
        const html = await app.frontend.document(ticket);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', extensionCsp);
        res.end(html);
        return;
      }
      if (url.pathname === '/mcp' && req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      if (url.pathname === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        connections.add(res);
        const off = app.events.subscribe((event) => {
          if (res.writableLength > 2000000) {
            res.end();
            return;
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 30000);
        timer.unref();
        req.on('close', () => {
          off();
          clearInterval(timer);
          connections.delete(res);
        });
        return;
      }
      if (url.pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(req.method ?? '')) {
        const ticket = url.pathname.slice('/media/'.length);
        if (!/^[\w-]{32}$/.test(ticket)) {
          res.writeHead(404).end();
          return;
        }
        const object = await app.files.resolveMedia(ticket);
        let start = 0,
          end = object.bytes - 1,
          status = 200;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) {
            res.writeHead(416, { 'Content-Range': `bytes */${object.bytes}` }).end();
            return;
          }
          start = match[1] ? Number(match[1]) : Math.max(0, object.bytes - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start > end ||
            start >= object.bytes
          ) {
            res.writeHead(416, { 'Content-Range': `bytes */${object.bytes}` }).end();
            return;
          }
          status = 206;
        }
        const inline = /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|wav)|video\/(mp4|webm))$/.test(
          object.mediaType,
        );
        res.setHeader('Content-Type', inline ? object.mediaType : 'application/octet-stream');
        res.setHeader('Content-Disposition', inline ? 'inline' : 'attachment');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', Math.max(0, end - start + 1));
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${object.bytes}`);
        res.writeHead(status);
        if (req.method === 'HEAD' || !object.bytes) {
          res.end();
          return;
        }
        const stream = createReadStream(object.path, { start, end, signal: object.signal });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (req.method === 'POST' && ['/rpc', '/mcp', '/cli'].includes(url.pathname)) {
        if (url.pathname === '/cli' && origin) {
          res.writeHead(403).end();
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > (url.pathname === '/cli' ? 650000 : 12000000)) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname === '/mcp') {
          const [{ McpServer }, { StreamableHTTPServerTransport }] = await Promise.all([
            import('@modelcontextprotocol/sdk/server/mcp.js'),
            import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
          ]);
          const mcp = new McpServer({ name: 'echo', version });
          const caller = {
            kind: 'mcp' as const,
            permissions: echoToolPermissions(
              app.store,
              !harness,
              harnessPrincipal,
              app.plugins.characterPermissions(),
            ),
            ...(harnessPrincipal ?? {}),
          };
          for (const op of app.registry.list(caller, true))
            mcp.registerTool(
              op.name.replaceAll('.', '_'),
              { description: op.description, inputSchema: op.input as any },
              async (input: any) => ({
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(await app.registry.call(op.name, input, caller)),
                  },
                ],
              }),
            );
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          await mcp.connect(transport);
          res.on('finish', () => {
            void transport.close();
            void mcp.close();
          });
          await transport.handleRequest(req, res, body);
          return;
        }
        const request = z
          .object({
            jsonrpc: z.literal('2.0'),
            id: z.union([z.string(), z.number()]),
            method: z.string(),
            params: z.unknown().default({}),
          })
          .parse(body);
        const result = url.pathname === '/cli'
          ? await cliRequest(app, request.method, request.params)
          : await app.registry.call(request.method, request.params, { ...internal, kind: 'ui' });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        return;
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/rpc')) {
        const root = await realpath(options.webRoot);
        let requested = decodeURIComponent(url.pathname);
        if (requested === '/' || !extname(requested)) requested = '/index.html';
        const path = await realpath(resolve(root, '.' + requested));
        const rel = relative(root, path);
        if (rel.startsWith('..') || rel.includes(':')) {
          res.writeHead(403).end();
          return;
        }
        const types: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2',
        };
        res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' http://127.0.0.1:*; connect-src 'self' http://127.0.0.1:*; frame-src 'self' http://127.0.0.1:*; frame-ancestors 'none'",
        );
        res.end(await readFile(path));
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(e instanceof EchoError ? 409 : 400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: e instanceof EchoError ? e.code : 'invalid_request',
            message: e instanceof Error ? e.message : '请求失败。',
          },
        }),
      );
    }
  });
  await listenBrowserHttp(server,options.port??0);
  const port = (server.address() as any).port as number;
  const removeConversationListener = app.events.subscribe((event) => {
    if (event.type !== 'conversation.deleted') return;
    const conversationId = event.data.conversationId as string;
    const key = principalTokens.get(conversationId);
    if (key) harnessPrincipals.delete(key);
    principalTokens.delete(conversationId);
  });
  app.bindHarnessMcp((principal) => {
    const previous = principalTokens.get(principal.conversationId);
    if (previous && harnessPrincipals.get(previous)?.personaId === principal.personaId)
      return { url: `http://127.0.0.1:${port}/mcp`, token: previous };
    if (previous) harnessPrincipals.delete(previous);
    const bridgeToken = randomBytes(32).toString('base64url');
    harnessPrincipals.set(bridgeToken, principal);
    principalTokens.set(principal.conversationId, bridgeToken);
    return { url: `http://127.0.0.1:${port}/mcp`, token: bridgeToken };
  });
  return {
    server,
    port,
    token,
    close: async () => {
      removeConversationListener();
      app.bindHarnessMcp(undefined);
      harnessPrincipals.clear();
      principalTokens.clear();
      for (const res of connections) res.end();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
