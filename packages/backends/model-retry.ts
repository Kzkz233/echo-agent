import { setTimeout as sleep } from 'node:timers/promises';
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { isRetryableAssistantError, retryDelayMs } from '@earendil-works/pi-ai/utils/retry';
import type { GenerateRequest } from '../contracts/index.ts';

export const maxModelRetries = 5;
const transientStatus = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

/** One budget per inference step, including failures reported inside a successful HTTP stream. */
export class ModelStepRetry {
  private status?: number;
  private minimumDelay = 0;
  private transport = '';
  constructor(readonly signal: AbortSignal, private onItem: GenerateRequest['onItem'], private step: number,
    private budget = { used: 0 }) {}

  async fetch(fetcher: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit) {
    this.status = undefined;
    this.minimumDelay = 0;
    this.transport = '';
    try {
      const response = await fetcher(input, { ...init, redirect: 'error' });
      this.status = response.status;
      const header = response.headers.get('retry-after')?.trim();
      if (header) this.minimumDelay = /^\d+(?:\.\d+)?$/.test(header)
        ? Number(header) * 1000 : Math.max(0, (Date.parse(header) || 0) - Date.now());
      return response;
    } catch (error: any) {
      this.transport = [error?.name, error?.message, error?.cause?.code, error?.cause?.message].filter(Boolean).join(' ');
      throw error;
    }
  }

  async again(message: string) {
    if (this.budget.used >= maxModelRetries || this.signal.aborted || this.minimumDelay > 30000) return false;
    if (this.status && this.status >= 400 && !transientStatus.has(this.status)) return false;
    const detail = [this.status, this.transport, message].join(' ');
    if (/cert(?:ificate|_)|ERR_TLS|ERR_INVALID_URL|redirect count|insufficient.balance|credits? exhausted|content_filter|invalid_api_key/i.test(detail)) return false;
    // The upstream classifier only inspects these two fields. Preserve its billing/limit exclusions.
    const hint = this.status && transientStatus.has(this.status) ? ' server_busy' : '';
    if (!isRetryableAssistantError({ stopReason: 'error', errorMessage: detail + hint } as AssistantMessage)) return false;
    const attempt = ++this.budget.used;
    const delay = Math.max(this.minimumDelay, retryDelayMs({ baseDelayMs: 800 }, attempt) + Math.floor(Math.random() * 200));
    this.onItem?.({ id: `model-retry-${this.step}-${attempt}`, kind: 'status', state: 'completed',
      title: '模型连接重试', text: `第 ${attempt}/${maxModelRetries} 次重试，等待 ${(delay / 1000).toFixed(1)} 秒。` });
    await sleep(delay, undefined, { signal: this.signal });
    return true;
  }
}

export function retryModelStream(model: Model<Api>, policy: ModelStepRetry, open: () => AssistantMessageEventStream) {
  const output = createAssistantMessageEventStream();
  async function forward() {
    for (;;) {
      let start: Extract<AssistantMessageEvent, { type: 'start' }> | undefined;
      let published = false;
      let retry = false;
      const stream = open();
      for await (const event of stream) {
        if (event.type === 'start') { start = event; continue; }
        if (event.type === 'error' && event.reason !== 'aborted' && !published &&
            await policy.again(event.error.errorMessage ?? '')) { retry = true; break; }
        if (start) { output.push(start); start = undefined; }
        published = true;
        output.push(event);
        if (event.type === 'done' || event.type === 'error') { output.end(); return; }
      }
      // Provider streams normally send a terminal event. An early iterator exit must not
      // silently open another request unless a retry was explicitly approved above.
      if (!retry) {
        output.end(await stream.result());
        return;
      }
    }
  }
  void forward().catch((error: Error) => {
    const reason = policy.signal.aborted ? 'aborted' : 'error';
    output.push({ type: 'error', reason, error: { role: 'assistant', content: [], stopReason: reason,
      api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
      errorMessage: error.message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    output.end();
  });
  return output;
}
