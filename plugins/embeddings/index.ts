import { z } from 'zod';
import manifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest, type Plugin } from '../../packages/kernel/registry.ts';
import { contributeInferenceTask } from '../../packages/kernel/inference.ts';
import {
  embeddingInput,
  embeddingOutput,
  embeddingItem,
  inferenceTasks,
} from '../../packages/contracts/inference.ts';
import { invariant } from '../../packages/contracts/index.ts';
import { Router } from '../../packages/kernel/router.ts';
export class Embeddings {
  constructor(readonly router: Router) {}
  async encode(
    modelId: string,
    inputs: z.infer<typeof embeddingItem>[],
    purpose: 'query' | 'document',
    signal: AbortSignal,
  ) {
    const catalog = this.router.inference,
      model = catalog.models().find((m) => m.id === modelId);
    invariant(model?.embedding.enabled, 'embedding_unsupported', '此模型未启用向量表示能力');
    const connection = catalog.connections().find((c) => c.id === model.connectionId)!;
    const adapter = catalog.adapter(connection.adapterId);
    const modalities = new Set(inputs.flatMap((i) => i.content.map((p) => p.type)));
    invariant(
      [...modalities].every(
        (m) => model.embedding.inputs.includes(m) && adapter.embedding.includes(m),
      ),
      'modality_unsupported',
      '所选模型或接入器不支持此输入模态',
    );
    invariant(adapter.embeddingProvider, 'embedding_unsupported', '此接入器不提供向量表示');
    const profile = catalog.resolve(modelId);
    const result = embeddingOutput.parse(
      await catalog.capabilities.invoke(
        catalog.owner,
        'embeddings.encode@1',
        adapter.embeddingProvider,
        { profile, inputs, purpose },
        signal,
      ),
    );
    signal.throwIfAborted();
    invariant(
      result.vectors.length === inputs.length &&
        result.vectors.every(
          (v) =>
            v.length === result.vectors[0].length &&
            (!model.embedding.dimensions || v.length === model.embedding.dimensions),
        ),
      'embedding_output',
      '向量数量或维度与模型配置不一致，未写入索引',
    );
    return result.vectors;
  }
  texts(texts: string[], signal: AbortSignal, purpose: 'query' | 'document' = 'document') {
    return this.encode(
      this.router.route(inferenceTasks.embedding).id,
      texts.map((text) => ({ content: [{ type: 'text', text }] })),
      purpose,
      signal,
    );
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      activate: (ctx) => {
        ctx.capabilities.define({
          id: 'embeddings.encode@1',
          description: 'Model vector representations; each input may contain multiple media parts',
          input: embeddingInput,
          output: embeddingOutput,
          providePermission: 'embeddings.provide',
          consumePermission: 'embeddings.use',
          cardinality: 'one',
        });
        contributeInferenceTask(ctx, {
          id: inferenceTasks.embedding,
          label: '共享语义向量',
          scope: 'shared',
          operation: 'embed',
          inputs: ['text'],
          description: '供知识检索、记忆召回及其他可选模块使用的共享向量模型',
        });
        ctx.registry.register({
          name: 'embeddings.encode',
          owner: 'embeddings',
          description: '使用已配置模型生成向量表示',
          permission: 'embeddings.use',
          mcp: false,
          input: z.object({
            modelId: z.string(),
            inputs: z.array(embeddingItem).min(1).max(256),
            purpose: z.enum(['query', 'document']).default('document'),
          }),
          output: embeddingOutput,
          run: async (v, _c, s) => ({
            vectors: await this.encode(v.modelId, v.inputs, v.purpose, s),
          }),
        });
      },
    };
  }
}
