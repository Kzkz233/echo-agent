import manifest from './echo-plugin.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Agent } from 'undici';
import { z } from 'zod';
import { invariant } from '../../packages/contracts/index.ts';
import type { ChannelTextMode } from '../../packages/contracts/delivery.ts';
import { replyPartGaps } from '../../packages/contracts/reply-pacing.ts';
import {
  defineManifest,
  type Plugin,
  type PluginContext,
  internal,
} from '../../packages/kernel/registry.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Secrets } from '../../packages/kernel/secrets.ts';
import { Events } from '../../packages/kernel/events.ts';
import { operations } from '../shared.ts';
import { QqFailure, networkFailure, qqAttempt } from './retry.ts';
import { qqTextParts } from './text-parts.ts';
const configSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  secretRef: z.string().default(''),
  apiBase: z.string().default('https://api.sgroup.qq.com'),
  tokenBase: z.string().default('https://bots.qq.com'),
  allowProactive: z.boolean().default(false),
});
type Part = {
  text: string;
  media?: boolean;
  fileInfo?: string;
  fileExpires?: number;
  seq: number;
  state: 'pending' | 'sending' | 'confirmed' | 'failed' | 'unknown';
  messageId?: string;
  traceId?: string;
};
type Progress = {
  id: string;
  hash: string;
  peer: string;
  replyTo?: string;
  parts: Part[];
  state: string;
  createdAt: string;
  error?: string;
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const safeEndpoint = (base: string, path: string) => {
  const url = new URL(base.replace(/\/$/, '') + path);
  invariant(
    !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))),
    'insecure_endpoint',
    'QQ endpoints require HTTPS',
  );
  return url;
};
export class QQ {
  private ctx?: PluginContext;
  private life?: AbortController;
  private agent?: Agent;
  private gateway?: Promise<void>;
  private queue = Promise.resolve();
  private token?: { value: string; until: number };
  private refreshing?: Promise<string>;
  private readonly replyPacing = new Map<string, Set<AbortController>>();
  private statusValue: any = { state: 'disabled' };
  constructor(
    readonly store: Store,
    readonly secrets: Secrets,
    readonly events: Events,
    readonly fetcher: typeof fetch = fetch,
    readonly sleep = (ms: number, signal: AbortSignal) => pause(ms, undefined, { signal }),
  ) {}
  config() {
    return configSchema.parse(this.store.get('qq.config', {}));
  }
  private status(state: string, issue?: string) {
    this.statusValue = { state, issue, direct: true, at: new Date().toISOString() };
    this.events.emit('qq.updated', this.statusValue);
  }
  private async request(url: URL, body: unknown, signal: AbortSignal, token?: string) {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'QQBot ' + token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        dispatcher: this.agent,
      } as any);
    } catch (e) {
      throw networkFailure(e);
    }
    const traceId = response.headers.get('x-tps-trace-id') ?? undefined;
    if (!response.ok) {
      await response.body?.cancel();
      throw new QqFailure('HTTP_' + response.status, false, response.status >= 500);
    }
    let json: any;
    try {
      json = await response.json();
    } catch {
      throw new QqFailure('RESPONSE_PARSE', false, true);
    }
    return { json, traceId };
  }
  private getToken(signal: AbortSignal) {
    if (this.token && this.token.until > Date.now()) return Promise.resolve(this.token.value);
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const cfg = this.config(),
        secret = await this.secrets.get(cfg.secretRef);
      invariant(secret, 'qq_secret', 'QQ credential missing');
      const fetchToken = () =>
        this.request(
          safeEndpoint(cfg.tokenBase, '/app/getAppAccessToken'),
          { appId: cfg.appId, clientSecret: secret },
          signal,
        );
      let result;
      try {
        result = await fetchToken();
      } catch (error) {
        if (
          error instanceof QqFailure &&
          (error.retryable || /^HTTP_5/.test(error.code)) &&
          !signal.aborted
        ) {
          await this.sleep(500, signal);
          result = await fetchToken();
        } else throw error;
      }
      invariant(
        typeof result.json.access_token === 'string' && result.json.access_token,
        'qq_token',
        'QQ did not return an access token',
      );
      const expires = Number(result.json.expires_in);
      invariant(Number.isFinite(expires) && expires > 0, 'qq_token', 'Token expiry missing');
      this.token = {
        value: result.json.access_token,
        until: Date.now() + Math.max(1, expires - 300) * 1000,
      };
      return this.token.value;
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async stop() {
    this.life?.abort();
    this.life = undefined;
    await this.gateway?.catch(() => {});
    this.gateway = undefined;
    const agent = this.agent;
    this.agent = undefined;
    await agent?.destroy();
    this.token = undefined;
    this.refreshing = undefined;
  }
  private async configure() {
    await this.stop();
    if (!this.ctx || this.ctx.signal.aborted || !this.config().enabled) {
      this.status('disabled');
      return;
    }
    const ctx = this.ctx,
      cfg = this.config();
    invariant(
      cfg.appId && cfg.secretRef,
      'qq_configuration',
      'Configure App ID and credential reference',
    );
    this.life = new AbortController();
    const signal = AbortSignal.any([ctx.signal, this.life.signal]);
    this.agent = new Agent({ connect: { timeout: 10000 } });
    this.status('connecting');
    const { QqGateway } = await import('./gateway.ts');
    signal.throwIfAborted();
    const gateway = new QqGateway({
      appId: cfg.appId,
      signal,
      token: () => this.getToken(signal),
      clearToken: () => {
        this.token = undefined;
      },
      url: async (token) => {
        const { json } = await this.request(
          safeEndpoint(cfg.apiBase, '/gateway'),
          undefined,
          signal,
          token,
        );
        const url = new URL(json.url);
        const local = ['127.0.0.1', 'localhost'].includes(new URL(cfg.apiBase).hostname);
        invariant(
          (url.protocol === 'wss:' &&
            (url.hostname.endsWith('.qq.com') || url.hostname === new URL(cfg.apiBase).hostname)) ||
            (local && url.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname)),
          'qq_gateway',
          'Unexpected gateway origin',
        );
        return url.href;
      },
      ready: () => this.status('ready'),
      disconnected: () => this.status('reconnecting'),
      error: (error) =>
        this.status(
          'reconnecting',
          String((error as any)?.code ?? error.message ?? 'QQ_NETWORK_ERROR'),
        ),
      message: async (msg) => {
        if (
          signal.aborted ||
          msg.senderIsBot ||
          !['c2c', 'group'].includes(msg.kind) ||
          !msg.content.trim()
        )
          return;
        const peer = msg.kind + ':' + (msg.kind === 'group' ? msg.groupOpenid : msg.senderId);
        const received = await ctx.registry.call(
          'channels.receive',
          {
            adapter: 'qq.bot',
            peer,
            remoteMessageId: msg.messageId,
            text: msg.content.replace(/<@!?\d+>/g, '').trim(),
          },
          internal,
          signal,
        );
        if (received.state === 'queued')
          for (const waiting of this.replyPacing.get(peer) ?? []) waiting.abort();
      },
    });
    this.gateway = gateway.start().catch((e) => {
      if (!signal.aborted) this.status('blocked', String((e as any)?.code ?? 'GATEWAY_STOPPED'));
    });
  }
  private update() {
    const work = this.queue.then(() => this.configure());
    this.queue = work.catch(() => {
      this.status('blocked', 'QQ configuration could not start');
    });
    return work;
  }
  async send(
    input: { peer: string; text: string; replyTo?: string; idempotencyKey: string; image?: string; textMode?: ChannelTextMode; parts?: string[] },
    signal: AbortSignal,
  ) {
    const cfg = this.config();
    if (!cfg.enabled || !this.agent || !this.life)
      return { state: 'failed', receipt: { code: 'QQ_DISABLED' } };
    const match = /^(c2c|group):([\w-]+)$/.exec(input.peer);
    invariant(match, 'qq_peer', 'QQ peer must be c2c:openid or group:openid');
    if (!input.replyTo && !cfg.allowProactive)
      return { state: 'failed', receipt: { code: 'PASSIVE_REPLY_ID_REQUIRED' } };
    // Existing receipts already freeze the message parts and sequence numbers.
    const { textMode, ...content } = input;
    const key = hash(input.idempotencyKey),
      fingerprint = hash(content);
    let row = this.store.document<Progress>('qq-deliveries', key);
    if (row) {
      invariant(row.hash === fingerprint, 'idempotency_conflict', 'QQ delivery content changed');
      if (row.state === 'delivered' || row.state === 'unknown')
        return { state: row.state, receipt: row };
    } else {
      const sequenceKey = 'qq.sequence.' + hash([input.peer, input.replyTo ?? key]),
        last = this.store.get<number>(sequenceKey, 0);
      const chunks = qqTextParts(input.text, 5 - last, Boolean(input.image), textMode, input.parts);
      if (!chunks.length) return { state: 'skipped' };
      if (chunks.length > 5)
        return {
          state: 'failed',
          receipt: { code: 'TEXT_REQUIRES_MORE_THAN_FIVE_REPLIES', retainedInHistory: true },
        };
      if (input.replyTo && last + chunks.length > 5)
        return { state: 'failed', receipt: { code: 'REPLY_SEQUENCE_BUDGET_EXHAUSTED' } };
      const parts: Part[] = chunks.map((text, i) => ({ text, seq: last + i + 1, state: 'pending' }));
      if (input.image && last + parts.length < 5)
        parts.push({ text: '', media: true, seq: last + parts.length + 1, state: 'pending' });
      this.store.set(sequenceKey, last + parts.length);
      row = {
        id: key,
        hash: fingerprint,
        peer: input.peer,
        replyTo: input.replyTo,
        parts,
        state: 'pending',
        createdAt: new Date().toISOString(),
      };
      this.store.put('qq-deliveries', key, row);
    }
    const combined = AbortSignal.any([signal, this.life.signal]);
    const textParts = row.parts.filter((part) => !part.media);
    const conversational = input.replyTo && textMode !== 'combined' && input.parts?.length === textParts.length &&
      input.parts.every((part, index) => part === textParts[index].text);
    const gaps = conversational ? replyPartGaps(textParts.map((part) => part.text), 'qq') : [];
    const pacing = new AbortController();
    const pacedSignal = AbortSignal.any([combined, pacing.signal]);
    const waiting = this.replyPacing.get(input.peer) ?? new Set<AbortController>();
    if (gaps.length) {
      waiting.add(pacing);
      this.replyPacing.set(input.peer, waiting);
    }
    const resource = `/v2/${match[1] === 'group' ? 'groups' : 'users'}/${encodeURIComponent(match[2])}`;
    let effectStarted = false;
    try {
      const token = await this.getToken(combined);
      let lastTextAt: number | undefined;
      for (const [index, part] of row.parts.entries()) {
        if (part.state === 'confirmed') continue;
        effectStarted = false;
        if (!part.media && lastTextAt !== undefined) {
          const gap = gaps[index - 1];
          const wait = gap === undefined ? 600 : gap - (performance.now() - lastTextAt);
          if (wait > 0 && !pacing.signal.aborted) {
            try { await this.sleep(Math.ceil(wait), pacedSignal); }
            catch (error) { if (!pacing.signal.aborted || combined.aborted) throw error; }
          }
        }
        combined.throwIfAborted();
        if (part.media && (!part.fileInfo || (part.fileExpires ?? 0) <= Date.now())) {
          const upload = await qqAttempt(() => this.request(
            safeEndpoint(cfg.apiBase, resource + '/files'),
            { file_type: 1, file_data: input.image, srv_send_msg: false }, combined, token,
          ), combined, this.sleep);
          if (typeof upload.json.file_info !== 'string' || !upload.json.file_info)
            throw new QqFailure('FILE_INFO_MISSING', false, false);
          part.fileInfo = upload.json.file_info;
          part.fileExpires = Date.now() + Math.max(0, Number(upload.json.ttl) || 0) * 1000;
        }
        part.state = 'sending';
        effectStarted = true;
        this.store.put('qq-deliveries', key, row);
        const result = await qqAttempt(
          async () => {
            if (!part.media) lastTextAt = performance.now();
            const result = await this.request(
              safeEndpoint(cfg.apiBase, resource + '/messages'),
              {
                ...(part.media ? { msg_type: 7, media: { file_info: part.fileInfo } }
                  : { content: part.text, msg_type: 0 }),
                ...(input.replyTo ? { msg_id: input.replyTo } : {}),
                msg_seq: part.seq,
              },
              combined,
              token,
            );
            if (typeof result.json.id !== 'string' || !result.json.id)
              throw new QqFailure('MESSAGE_ID_MISSING', false, true);
            return result;
          },
          combined,
          this.sleep,
        );
        part.state = 'confirmed';
        part.messageId = result.json.id;
        part.traceId = result.traceId;
        this.store.put('qq-deliveries', key, row);
      }
      row.state = 'delivered';
    } catch (e) {
      const failure = e instanceof QqFailure ? e : networkFailure(e);
      row.state = effectStarted && failure.uncertain ? 'unknown' : 'failed';
      row.error = failure.code;
      const part = row.parts.find((p) => p.state === 'sending');
      if (part) part.state = failure.uncertain ? 'unknown' : 'failed';
    } finally {
      if (waiting.delete(pacing) && !waiting.size) this.replyPacing.delete(input.peer);
    }
    this.store.put('qq-deliveries', key, row);
    return { state: row.state, receipt: row };
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      config: { schema: configSchema },
      activate: (ctx) => {
        this.ctx = ctx;
        for (const row of this.store.documents<Progress>('qq-deliveries'))
          if (row.parts.some((p) => p.state === 'sending'))
            this.store.put('qq-deliveries', row.id, { ...row, state: 'unknown' });
        ctx.dispose(async () => {
          this.ctx = undefined;
          await this.stop();
          await this.queue.catch(() => {});
          await this.stop();
        });
        ctx.capabilities.provide('channels.send@1', 'qq.bot', 'QQ bot', (v, s) => this.send(v, s));
        ctx.capabilities.provide('channels.image-adapters@1', 'qq.bot', 'QQ bot', () => ({}));
        ctx.capabilities.provide('channels.inspect@1', 'qq.bot', 'Inspect QQ receipts', (v) => {
          const row = this.store.document<Progress>('qq-deliveries', hash(v.idempotencyKey));
          return {
            state:
              row?.state === 'delivered'
                ? 'delivered'
                : row?.state === 'failed'
                  ? 'failed'
                  : 'unknown',
            receipt: row,
          };
        });
        operations(ctx, 'qq')(
          'status',
          'QQ connection and delivery state',
          z.object({}),
          'qq.read',
          () => this.statusValue,
          false,
        );
        ctx.dispose(
          this.events.subscribe((e) => {
            if (e.type === 'settings.changed' && e.data.pluginId === 'qq')
              void this.update().catch(() => {});
          }),
        );
        void this.update().catch(() => {});
      },
    };
  }
}
