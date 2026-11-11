import type { Model, ProviderStreams, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { invariant, type GenerationProtocol, type Profile } from '../contracts/index.ts';
import { effectiveReasoning, selectedReasoning } from './model-metadata.ts';

export function endpoint(profile: Profile, suffix: string) {
  const url = new URL(profile.endpoint);
  invariant(
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLocal(url))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'insecure_endpoint',
    '远程模型接口需要 HTTPS；本机接口可用 HTTP。',
  );
  url.pathname = url.pathname.replace(/\/$/, '') + suffix;
  return url;
}

function isLocal(url: URL) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export const modelApiKey = (profile: Profile, key?: string) =>
  key || (isLocal(new URL(profile.endpoint)) ? 'echo-local-keyless' : undefined);

export function modelListRequest(
  profile: Profile,
  key?: string,
): { url: URL; headers: HeadersInit } {
  const anthropic = profile.protocol === 'anthropic-messages';
  const base = anthropic ? anthropicBase(profile) : profile.endpoint;
  return {
    url: endpoint({ ...profile, endpoint: base }, anthropic ? '/v1/models' : '/models'),
    headers: anthropic
      ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {},
  };
}

function anthropicBase(profile: Profile) {
  return endpoint(profile, '').href.replace(/\/$/, '').replace(/\/v1$/, '');
}

export async function modelProtocol(profile: Profile, override?: string) {
  const api = profile.protocol;
  endpoint(profile, '');
  const providers: Record<GenerationProtocol, () => Promise<ProviderStreams>> = {
    'openai-completions': async () =>
      (await import('@earendil-works/pi-ai/api/openai-completions.lazy')).openAICompletionsApi(),
    'openai-responses': async () =>
      (await import('@earendil-works/pi-ai/api/openai-responses.lazy')).openAIResponsesApi(),
    'anthropic-messages': async () =>
      (await import('@earendil-works/pi-ai/api/anthropic-messages.lazy')).anthropicMessagesApi(),
  };
  const support = effectiveReasoning(profile, profile.reasoningSupport);
  const { effort } =
    profile.reasoningStyle === 'none'
      ? { effort: undefined }
      : selectedReasoning({ ...profile, reasoningSupport: support }, override);
  const style = profile.reasoningStyle === 'auto' ? support?.style : profile.reasoningStyle;
  const nonChat = api !== 'openai-completions';
  const reasoning =
    effort && effort !== 'off' && (style === 'effort' || (nonChat && style === 'deepseek'))
      ? effort
      : undefined;
  const model: Model<GenerationProtocol> = {
    id: profile.model,
    name: profile.model,
    api,
    provider: 'echo-' + profile.id,
    baseUrl: api === 'anthropic-messages' ? anthropicBase(profile) : profile.endpoint,
    reasoning: Boolean(reasoning),
    ...(support?.wireValues ? { thinkingLevelMap: support.wireValues } : {}),
    input: profile.vision ? ['text', 'image'] : ['text'],
    contextWindow: typeof profile.modelOptions.contextWindowTokens === 'number'
      ? profile.modelOptions.contextWindowTokens
      : profile.contextChars,
    maxTokens: profile.maxOutputTokens,
    ...(api === 'openai-completions'
      ? {
          compat: {
            supportsMidConvoSystemMessages: true,
            supportsStore: false,
            maxTokensField:
              profile.modelOptions.maxTokensField === 'max_tokens' ||
              profile.modelOptions.maxTokensField === 'max_completion_tokens'
                ? profile.modelOptions.maxTokensField
                : new URL(profile.endpoint).hostname === 'api.openai.com'
                  ? 'max_completion_tokens'
                  : 'max_tokens',
          },
        }
      : {}),
    ...(api === 'openai-responses' ? { compat: { supportsMidConvoSystemMessages: true } } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const onPayload: SimpleStreamOptions['onPayload'] = (payload) => {
    if (api === 'openai-responses' && effort === 'off' && (style === 'effort' || style === 'deepseek')) {
      const wire = support?.wireValues?.off;
      if (wire !== null) return { ...(payload as object), reasoning: { effort: wire ?? 'none' } };
    }
    if (api === 'anthropic-messages' && style === 'deepseek' && effort) {
      return {
        ...(payload as object),
        thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
        ...(effort === 'off'
          ? {}
          : { output_config: { effort: support?.wireValues?.[effort] ?? effort } }),
      };
    }
    return payload;
  };
  return { model, streams: await providers[api](), reasoning, onPayload };
}
