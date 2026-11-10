import {
  EchoError,
  invariant,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
  type Profile,
} from '../contracts/index.ts';
import { readModelListing, selectedReasoning, effectiveReasoning } from './model-metadata.ts';
import { endpoint, modelApiKey, modelListRequest, modelProtocol } from './protocol.ts';
export { endpoint } from './protocol.ts';

export type SecretResolver = (reference: string) => Promise<string | undefined>;
export function thinking(profile: Profile, override?: string) {
  if (profile.reasoningStyle === 'none') return {};
  profile = { ...profile, reasoningSupport: effectiveReasoning(profile, profile.reasoningSupport) };
  const { effort } = selectedReasoning(profile, override);
  const style =
    profile.reasoningStyle === 'auto'
      ? (profile.reasoningSupport?.style ?? 'none')
      : profile.reasoningStyle;
  if (!effort || style === 'none') return {};
  if (style === 'enable_thinking') return { enable_thinking: effort !== 'off' };
  if (style === 'chat_template')
    return { chat_template_kwargs: { enable_thinking: effort !== 'off' } };
  if (style === 'deepseek')
    return {
      thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
      ...(effort === 'off' ? {} : { reasoning_effort: effort }),
    };
  const wire = profile.reasoningSupport?.wireValues?.[effort];
  return wire === null ? {} : { reasoning_effort: wire ?? (effort === 'off' ? 'none' : effort) };
}
export class ApiBackend implements Backend {
  kind = 'api' as const;
  constructor(
    readonly secrets: SecretResolver,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  async listModels(profile: Profile) {
    const key = await this.secrets(profile.apiKeyRef);
    const { url, headers } = modelListRequest(profile, key);
    const response = await this.fetcher(url, {
      method: 'GET',
      redirect: 'error',
      headers,
      signal: AbortSignal.timeout(profile.timeoutMs),
    });
    invariant(
      response.ok,
      'provider_http_' + response.status,
      `模型目录返回 HTTP ${response.status}。`,
    );
    const body: any = await response.json();
    invariant(Array.isArray(body?.data), 'provider_format', '模型目录格式无效。');
    return readModelListing(body.data);
  }
  async checkConnection(profile: Profile) {
    const models = await this.listModels(profile);
    return { ok: true, kind: 'api', verified: 'upstream', modelCount: models.length, models };
  }
  async checkGeneration(profile: Profile, signal: AbortSignal) {
    const { model, streams } = await modelProtocol({ ...profile, reasoningStyle: 'none' });
    const apiKey = modelApiKey(profile, await this.secrets(profile.apiKeyRef));
    invariant(apiKey, 'missing_credential', '请先保存此连接的 API Key。');
    const { normalizeContext } = await import('@earendil-works/pi-ai');
    const messages: import('@earendil-works/pi-ai').Message[] = [
      {
        role: 'user', timestamp: Date.now(),
        content: 'Call echo_connection_test once and then reply with its result as plain text.',
      },
    ];
    const tool: import('@earendil-works/pi-ai').Tool = {
      name: 'echo_connection_test',
      description: 'Returns a fixed connection-test string without accessing any data.',
      parameters: { type: 'object', properties: {}, additionalProperties: false } as import('@earendil-works/pi-ai').Tool['parameters'],
    };
    const options = {
      apiKey, maxTokens: 256, maxRetries: 0, cacheRetention: 'none' as const,
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(30000, profile.timeoutMs))]),
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        this.fetcher(input, { ...init, redirect: 'error' }),
    };
    const run = async () => {
      const stream = streams.streamSimple(model, normalizeContext({ messages, tools: [tool] }), options);
      let textStreamed = false;
      for await (const event of stream)
        if (event.type === 'text_delta' && event.delta.trim()) textStreamed = true;
      const result = await stream.result();
      invariant(['stop', 'toolUse'].includes(result.stopReason),
        'provider_probe_failed', '推理测试未收到完整回复。请检查 API 协议、凭据和模型。');
      return { result, textStreamed };
    };
    const first = await run();
    const call = first.result.content.find((part) => part.type === 'toolCall' && part.name === tool.name);
    if (!call || call.type !== 'toolCall') {
      invariant(first.textStreamed, 'provider_probe_failed', '推理测试未收到流式正文。');
      return { ok: true, verified: 'generation', toolCall: false };
    }
    messages.push(first.result, {
      role: 'toolResult', toolName: tool.name, toolCallId: call.id,
      timestamp: Date.now(), isError: false, content: [{ type: 'text', text: 'ECHO_OK' }],
    });
    const second = await run();
    invariant(second.textStreamed && second.result.stopReason === 'stop' &&
      second.result.content.some((part) => part.type === 'text' && part.text.includes('ECHO_OK')),
      'provider_probe_failed', '推理测试未收到工具调用后的流式回复。');
    return { ok: true, verified: 'generation', toolCall: true };
  }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const { profile } = request;
    invariant(profile.model, 'missing_model', '请填写模型名称。');
    const key = await this.secrets(profile.apiKeyRef);
    if (profile.protocol !== 'openai-completions') return this.generateWithProtocol(request, key);
    const messages = request.messages.map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.images?.length
        ? [
            { type: 'text', text: m.text },
            ...m.images.map((i) => ({
              type: 'image_url',
              image_url: { url: `data:${i.mimeType};base64,${i.data}` },
            })),
          ]
        : m.text,
    }));
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(profile.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetcher(endpoint(profile, '/chat/completions'), {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: profile.model,
          messages,
          max_tokens: profile.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...thinking(profile, request.reasoning),
        }),
        signal,
      });
    } catch (e) {
      throw new EchoError(
        'provider_connection',
        '模型请求未取得完整回执。请检查连接后手动决定是否重试。',
        true,
      );
    }
    if (!response.ok) {
      let excerpt = '';
      const reader = response.body?.getReader();
      if (reader)
        try {
          while (excerpt.length < 8192) {
            const chunk = await reader.read();
            if (chunk.done) break;
            excerpt += Buffer.from(chunk.value).toString('utf8');
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      if (
        /content[_ -]?(?:filter|policy|moderation)|sensitive[_ -]?(?:content|words)|data_inspection_failed/i.test(
          excerpt.slice(0, 8192),
        )
      )
        throw new EchoError('provider_content_rejected', '提供方拒绝了本次内容。');
      throw new EchoError(
        `provider_http_${response.status}`,
        `模型接口返回 HTTP ${response.status}。`,
      );
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const raw = await response.text();
      invariant(raw.length < 16000000, 'provider_too_large', '模型响应超过限制。');
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new EchoError('provider_format', '模型没有返回有效 JSON。', true);
      }
      const text = data.choices?.[0]?.message?.content;
      invariant(data.choices?.[0]?.finish_reason !== 'length', 'provider_output_limit', '模型达到输出上限，结果未完成；请调整本任务的输出预算。');
      if (
        data.choices?.[0]?.message?.refusal ||
        data.choices?.[0]?.finish_reason === 'content_filter'
      )
        throw new EchoError('provider_content_rejected', '提供方拒绝了本次内容。');
      invariant(typeof text === 'string', 'provider_format', '模型响应缺少正文。');
      invariant(text.trim(), 'provider_empty', '模型没有返回正文。');
      request.onDelta?.(text);
      return { text, usage: data.usage };
    }
    invariant(response.body, 'provider_empty', '模型返回空响应。');
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '',
      text = '',
      usage: Record<string, number> | undefined,
      complete = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        invariant(
          buffer.length < 2000000 && text.length < 8000000,
          'provider_too_large',
          '模型流超过限制。',
        );
        let lineEnd: number;
        while ((lineEnd = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') {
            complete = true;
            continue;
          }
          let data: any;
          try {
            data = JSON.parse(raw);
          } catch {
            throw new EchoError('provider_format', '模型流中出现无效 JSON。', true);
          }
          if (data.error) throw new EchoError('provider_stream_error', '模型流返回错误。', true);
          invariant(data.choices?.[0]?.finish_reason !== 'length', 'provider_output_limit', '模型达到输出上限，结果未完成；请调整本任务的输出预算。');
          if (
            data.choices?.[0]?.delta?.refusal ||
            data.choices?.[0]?.finish_reason === 'content_filter'
          )
            throw new EchoError('provider_content_rejected', '提供方拒绝了本次内容。');
          const delta = data.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') {
            text += delta;
            request.onDelta?.(delta);
          }
          if (data.choices?.[0]?.finish_reason) complete = true;
          if (data.usage) usage = data.usage;
        }
      }
      invariant(complete, 'provider_truncated', '模型流提前结束，未确认完整结果。');
      invariant(text.trim(), 'provider_empty', '模型没有返回正文。');
      return { text, usage };
    } catch (e) {
      if (e instanceof EchoError) {
        if (!['provider_output_limit','provider_empty','provider_content_rejected'].includes(e.code)) e.uncertain = true;
        throw e;
      }
      throw new EchoError('provider_stream_lost', '读取模型结果时连接中断，未自动重试。', true);
    } finally {
      reader.releaseLock();
    }
  }
  private async generateWithProtocol(request: GenerateRequest, key?: string): Promise<GenerateResult> {
    const { profile } = request;
    const { model, streams, reasoning, onPayload } = await modelProtocol(profile, request.reasoning);
    const apiKey = modelApiKey(profile, key);
    invariant(apiKey, 'missing_credential', '请先保存此连接的 API Key。');
    const { normalizeContext } = await import('@earendil-works/pi-ai');
    const stream = streams.streamSimple(model, normalizeContext({
      messages: request.messages.map((message) => {
        if (message.role === 'system')
          return { role: 'system', content: message.text, timestamp: Date.now() };
        if (message.role === 'assistant')
          return {
            role: 'assistant', content: [{ type: 'text', text: message.text }],
            api: model.api, provider: model.provider, model: model.id,
            stopReason: 'stop', timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
        return {
          role: 'user', timestamp: Date.now(),
          content: [{ type: 'text', text: message.text },
            ...(message.images ?? []).map((image) => ({ type: 'image' as const, ...image }))],
        };
      }),
    }), {
      apiKey, reasoning, onPayload, maxTokens: profile.maxOutputTokens, maxRetries: 0,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(profile.timeoutMs)]),
      fetch: (input, init) => this.fetcher(input, { ...init, redirect: 'error' }),
    });
    let chars = 0;
    for await (const event of stream)
      if (event.type === 'text_delta') {
        chars += event.delta.length;
        invariant(chars < 8000000, 'provider_too_large', '模型流超过限制。');
        request.onDelta?.(event.delta);
      }
    const result = await stream.result();
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      if (/content[_ -]?(?:filter|policy|moderation)|\brefusal\b/i.test(result.errorMessage ?? ''))
        throw new EchoError('provider_content_rejected', '提供方拒绝了本次内容。');
      throw new EchoError('provider_stream_lost', '模型请求未取得完整回执。请检查连接后手动决定是否重试。', true);
    }
    invariant(result.stopReason !== 'length', 'provider_output_limit', '模型达到输出上限，结果未完成；请调整本任务的输出预算。');
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    invariant(text.trim(), 'provider_empty', '模型没有返回正文。');
    const usage = result.usage;
    return { text, usage: {
      prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
      completion_tokens: usage.output,
      total_tokens: usage.totalTokens,
      cached_tokens: usage.cacheRead,
    } };
  }
  async embed(profile: Profile, input: string[], signal: AbortSignal): Promise<number[][]> {
    const key = await this.secrets(profile.apiKeyRef);
    const response = await this.fetcher(endpoint(profile, '/embeddings'), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: profile.model,
        input,
        ...(profile.embeddingDimensions ? { dimensions: profile.embeddingDimensions } : {}),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutMs)]),
    });
    invariant(response.ok, 'embedding_error', `向量接口 HTTP ${response.status}`);
    const result: any = await response.json();
    invariant(
      Array.isArray(result.data) && result.data.length === input.length,
      'embedding_format',
      '向量数量不匹配。',
    );
    invariant(
      new Set(result.data.map((d: any) => d.index)).size === input.length &&
        result.data.every(
          (d: any) => Number.isInteger(d.index) && d.index >= 0 && d.index < input.length,
        ),
      'embedding_format',
      '向量输入顺序无效。',
    );
    const vectors = result.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => d.embedding);
    invariant(
      vectors.every((v: any) => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite)),
      'embedding_format',
      '向量格式无效。',
    );
    return vectors;
  }
}
