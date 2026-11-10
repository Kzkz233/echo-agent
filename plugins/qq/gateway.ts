import WebSocket from 'ws';
import { Agent as HttpsAgent } from 'node:https';
import { setTimeout as pause } from 'node:timers/promises';
import { dispatchEvent, type InboundMessage } from '@tencent-connect/qqbot-nodejs/protocol';
type Options = {
  signal: AbortSignal;
  appId: string;
  token: () => Promise<string>;
  clearToken: () => void;
  url: (token: string) => Promise<string>;
  ready: () => void;
  disconnected: () => void;
  error: (e: Error) => void;
  message: (m: InboundMessage) => Promise<void>;
};
/** Local transport policy over the official protocol decoder, with explicit heartbeat ACK deadlines. */
export class QqGateway {
  private session?: string;
  private sequence: number | null = null;
  private attempts = 0;
  constructor(readonly options: Options) {}
  async start() {
    const o = this.options;
    while (!o.signal.aborted) {
      let close: { code: number; delay?: number } = { code: 1006 };
      try {
        const token = await o.token();
        if (o.signal.aborted) return;
        close = await this.link(await o.url(token), token);
      } catch (error) {
        if (o.signal.aborted) return;
        o.error(error instanceof Error ? error : new Error('QQ_GATEWAY_ERROR'));
      }
      if (o.signal.aborted) return;
      if ([4914, 4915].includes(close.code))
        throw Object.assign(new Error('QQ gateway rejected account/intents'), {
          code: 'GATEWAY_FATAL_CLOSE',
        });
      if (
        [4004, 4006, 4007, 4009].includes(close.code) ||
        (close.code >= 4900 && close.code <= 4913)
      ) {
        this.session = undefined;
        this.sequence = null;
        o.clearToken();
      }
      o.disconnected();
      const delays = [1000, 2000, 5000, 10000, 30000, 60000];
      const delay =
        close.code === 4008
          ? 60000
          : (close.delay ?? delays[Math.min(this.attempts++, delays.length - 1)]);
      try {
        await pause(delay, undefined, { signal: o.signal });
      } catch {
        return;
      }
    }
  }
  private link(url: string, token: string) {
    const o = this.options;
    return new Promise<{ code: number; delay?: number }>((resolve) => {
      const direct = url.startsWith('wss:') ? new HttpsAgent({ keepAlive: false }) : undefined;
      const ws = new WebSocket(url, {
        agent: direct,
        handshakeTimeout: 30000,
        headers: { 'User-Agent': 'Echo/0.2' },
      });
      let heartbeat: NodeJS.Timeout | undefined,
        awaiting = false,
        requestedDelay: number | undefined;
      const fail = (code: string) => {
        o.error(Object.assign(new Error(code), { code }));
        ws.terminate();
      };
      const deadline = setTimeout(() => fail('QQ_READY_TIMEOUT'), 30000);
      deadline.unref();
      const abort = () => ws.terminate();
      o.signal.addEventListener('abort', abort, { once: true });
      ws.on('error', () => {});
      ws.on('message', (raw) => {
        let p: any;
        try {
          p = JSON.parse(raw.toString());
        } catch {
          fail('QQ_GATEWAY_PARSE');
          return;
        }
        if (typeof p.s === 'number') this.sequence = p.s;
        if (p.op === 10) {
          const interval = Number(p.d?.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 100 || interval > 120000) {
            fail('QQ_HEARTBEAT_INTERVAL');
            return;
          }
          ws.send(
            JSON.stringify(
              this.session && this.sequence !== null
                ? {
                    op: 6,
                    d: { token: 'QQBot ' + token, session_id: this.session, seq: this.sequence },
                  }
                : { op: 2, d: { token: 'QQBot ' + token, intents: 1 << 25, shard: [0, 1] } },
            ),
          );
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (awaiting) {
              fail('QQ_HEARTBEAT_ACK_TIMEOUT');
              return;
            }
            awaiting = true;
            ws.send(JSON.stringify({ op: 1, d: this.sequence }));
          }, interval);
          heartbeat.unref();
        } else if (p.op === 11) awaiting = false;
        else if (p.op === 0) {
          try {
            const event = dispatchEvent(p.t ?? '', p.d, o.appId);
            if (event.action === 'ready') {
              this.session = event.sessionId;
              this.attempts = 0;
              clearTimeout(deadline);
              o.ready();
            } else if (event.action === 'resumed') {
              this.attempts = 0;
              clearTimeout(deadline);
              o.ready();
            } else if (event.action === 'message')
              void o
                .message(event.msg)
                .catch(() =>
                  o.error(
                    Object.assign(new Error('QQ_MESSAGE_HANDLER'), { code: 'QQ_MESSAGE_HANDLER' }),
                  ),
                );
          } catch {
            fail('QQ_EVENT_PARSE');
          }
        } else if (p.op === 7) {
          requestedDelay = 1000;
          ws.terminate();
        } else if (p.op === 9) {
          if (!p.d) {
            this.session = undefined;
            this.sequence = null;
            o.clearToken();
          }
          requestedDelay = 3000;
          ws.terminate();
        }
      });
      ws.on('close', (code) => {
        direct?.destroy();
        clearTimeout(deadline);
        clearInterval(heartbeat);
        o.signal.removeEventListener('abort', abort);
        resolve({ code, delay: requestedDelay });
      });
      if (o.signal.aborted) abort();
    });
  }
}
