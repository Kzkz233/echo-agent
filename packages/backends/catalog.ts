import { z } from 'zod';
import { generationProtocol, type Backend, invariant } from '../contracts/index.ts';
import {
  generationInput,
  rerankOutput,
  generationOutput,
  type AdapterDescriptor,
} from '../contracts/inference.ts';
import { modelListingSchema } from '../contracts/reasoning.ts';
import { InferenceCatalog } from '../kernel/inference.ts';
import { ApiBackend, endpoint } from './api.ts';
import type { Capabilities } from '../kernel/capabilities.ts';
export function installCoreInference(
  catalog: InferenceCatalog,
  backends: Map<string, Backend>,
  api: ApiBackend,
) {
  const caps = catalog.capabilities,
    owner = catalog.owner;
  caps.define(owner, {
    id: 'core.inference.generate@1',
    description: 'Stateless generation provider',
    input: generationInput,
    output: generationOutput,
    providePermission: 'inference.provide',
    consumePermission: 'inference.use',
    cardinality: 'one',
  });
  caps.provide(owner, 'semantic.rerank-model@1', 'core.api', 'Rerank API', async ({ profile, query, documents }, signal) => {
    const key = await api.secrets(profile.apiKeyRef);
    const response = await api.fetcher(endpoint(profile, '/rerank'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutMs)]),
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: profile.model, query, documents, top_n: documents.length, return_documents: false }),
    });
    invariant(response.ok, 'rerank_http', `重排接口返回 HTTP ${response.status}`);
    const body: any = await response.json();
    const rows = rerankOutput.parse((body.results ?? body.data)?.map((row: any) => ({ index: row.index, score: row.relevance_score ?? row.score })));
    invariant(new Set(rows.map((row) => row.index)).size === rows.length && rows.every((row) => row.index < documents.length), 'rerank_output', '重排结果包含无效编号');
    return rows;
  });
  registerInferenceAdapters(caps.forOwner(owner, () => {}), backends, ['api', 'pi'], 'core');
  // A pending provider consumes no resources; Embeddings owns the task contract.
  caps.provide(owner, 'embeddings.encode@1', 'core.api', 'API embeddings', async (v, signal) => {
    invariant(v.profile.kind === 'api', 'adapter_mismatch', '此向量接口仅接受 API 连接');
    invariant(v.inputs.every((i: any) => i.content.every((p: any) => p.type === 'text')),
      'modality_unsupported', '此 API 适配器只实现文本向量输入');
    return { vectors: await api.embed(v.profile,
      v.inputs.map((i: any) => i.content.map((p: any) => p.text).join('\n')), signal) };
  });
}
export function registerInferenceAdapters(
  caps: ReturnType<Capabilities['forOwner']>, backends: Map<string, Backend>,
  kinds: string[], namespace: string,
) {
  const common = { endpoint: z.string().default(''), apiKeyRef: z.string().default('') };
  for (const kind of kinds) {
    const providerId = namespace === 'core' ? 'core.' + kind : namespace + '.provider';
    const protocolField = {
      key: 'protocol',
      label: 'API 协议',
      type: 'select',
      options: generationProtocol.options,
      optionLabels: {
        'openai-completions': 'OpenAI Chat Completions',
        'openai-responses': 'OpenAI Responses',
        'anthropic-messages': 'Anthropic Messages',
      },
    };
    const connectionSchema =
      kind === 'api'
        ? z.object({ ...common, provider: z.string().default('openai'), protocol: generationProtocol.default('openai-completions') }).strict()
        : kind === 'pi'
          ? z.object({ ...common, provider: z.string().default('openai'), protocol: generationProtocol.default('openai-completions') }).strict()
          : z
              .object({
                ...(kind === 'codex' ? {} : common),
                command: z.string().default(kind === 'codex' ? 'codex' : 'dsh'),
                args: z
                  .array(z.string())
                  .default(kind === 'codex' ? ['app-server'] : ['--profile', 'sdk']),
                cwd: z.string().default(''),
                ...(kind === 'dsh'
                  ? {
                      provider: z
                        .string()
                        .min(1)
                        .max(100)
                        .regex(/^[\w.-]+$/)
                        .default('deepseek-official'),
                      api: z
                        .enum(['openai-completions', 'openai-responses', 'anthropic-messages'])
                        .default('openai-responses'),
                    }
                  : {}),
              })
              .strict();
    const fields: any[] = [
      ...(kind === 'codex'
        ? []
        : [
            { key: 'endpoint', label: 'API Base URL', type: 'text' },
            { key: 'apiKeyRef', label: '凭据引用', type: 'text' },
          ]),
      ...(['codex', 'dsh'].includes(kind)
        ? [
            { key: 'command', label: '可执行程序', type: 'path', pathMode: 'file' },
            { key: 'args', label: '启动参数（每行一个）', type: 'string-list' },
            { key: 'cwd', label: '专用工作目录', type: 'path', pathMode: 'directory' },
          ]
        : []),
      ...(kind === 'pi' ? [{ key: 'provider', label: 'Provider ID', type: 'text' }] : []),
      ...(['api', 'pi'].includes(kind) ? [protocolField] : []),
      ...(kind === 'dsh'
        ? [
            { key: 'provider', label: 'DSH Provider ID', type: 'text' },
            {
              key: 'api',
              label: 'DSH API protocol',
              type: 'select',
              options: ['openai-completions', 'openai-responses', 'anthropic-messages'],
              optionLabels: {
                'openai-completions': 'OpenAI Chat Completions',
                'openai-responses': 'OpenAI Responses',
                'anthropic-messages': 'Anthropic Messages',
              },
            },
          ]
        : []),
    ];
    const descriptor: AdapterDescriptor = {
      id: providerId,
      engine: kind,
      label:
        kind === 'api'
          ? 'OpenAI-compatible API'
          : kind === 'pi'
            ? 'OpenAI-compatible API'
            : kind === 'codex'
              ? 'Codex App Server'
              : 'DeepSeek Harness SDK',
      family: ['api', 'pi'].includes(kind) ? 'api' : 'harness',
      workerOnly: ['codex', 'dsh'].includes(kind),
      sessionBackend: true,
      connectionSchema: z.toJSONSchema(connectionSchema),
      modelSchema: z.toJSONSchema(z.object(kind === 'codex' ? { contextWindowTokens: z.number().int().min(8000).max(2000000).optional() } :
        ['api', 'pi'].includes(kind) ? { maxTokensField: z.enum(['auto', 'max_tokens', 'max_completion_tokens']).default('auto'),
          contextWindowTokens: z.number().int().min(1024).max(2000000).optional() } : {}).strict()),
      connectionFields: fields,
      modelFields: ['api', 'pi'].includes(kind) ? [{ key: 'maxTokensField', label: '输出长度参数', type: 'select',
        options: ['auto', 'max_tokens', 'max_completion_tokens'], optionLabels: {
          auto: '自动选择', max_tokens: 'max_tokens', max_completion_tokens: 'max_completion_tokens',
        } }] : [],
      presets: [],
      generation: ['text', 'image'],
      embedding: kind === 'api' ? ['text'] : [],
      generationProvider: providerId,
      modelCatalogProvider: providerId,
      ...(kind === 'api' ? { embeddingProvider: 'core.api', reranking: ['text'] as const as any, rerankingProvider: 'core.api' } : {}),
    };
    caps.provide(
      'core.inference.adapters@1',
      descriptor.id,
      descriptor.label,
      () => descriptor,
    );
    caps.provide(
      'core.inference.models@1',
      descriptor.id,
      descriptor.label,
      async ({ profile }) => {
        const backend = backends.get(kind);
        invariant(backend?.listModels, 'model_catalog_unavailable', '此接入器没有可读取的模型目录。');
        return z.array(modelListingSchema).parse(await backend.listModels(profile));
      },
    );
    caps.provide(
      'core.inference.generate@1',
      descriptor.id,
      descriptor.label,
      async (v, signal) => {
        invariant(v.profile.kind === kind, 'adapter_mismatch', '模型与接入器不匹配');
        const backend = backends.get(kind);
        invariant(backend, 'adapter_unavailable', '接入器不可用');
        return backend.generate({ ...v, signal, requestId: crypto.randomUUID() });
      },
    );
  }
}
