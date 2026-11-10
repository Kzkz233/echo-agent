import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { workerTask } from '../../packages/kernel/worker-task.ts';
import type { Plugin } from '../../packages/kernel/registry.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Secrets } from '../../packages/kernel/secrets.ts';
import { Mineru, documentConfig } from './mineru.ts';
import { z } from 'zod';
export class Documents {
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly secrets: Secrets,
  ) {}
  plugin(): Plugin {
    return {
      manifest: defineManifest(packageManifest),
      config: { schema: documentConfig },
      activate: (ctx) => {
        const mineru = new Mineru(this.root, this.store, this.secrets);
        ctx.registry.register({
          name: 'documents.status',
          owner: 'documents',
          description: '读取解析连接配置状态，不上传文档或创建解析任务',
          permission: 'documents.read',
          mcp: false,
          input: z.object({}),
          output: z.object({
            api: z.object({ configured: z.boolean(), endpoint: z.string() }),
            local: z.object({ configured: z.boolean() }),
          }),
          run: async () => {
            const config = documentConfig.parse(this.store.get('documents.config', {}));
            return {
              api: {
                configured: Boolean(await this.secrets.get(config.apiKeyRef)),
                endpoint: config.endpoint,
              },
              local: { configured: Boolean(config.command.trim()) },
            };
          },
        });
        ctx.capabilities.provide(
          'files.extract@1',
          'documents.local',
          '本地文档正文',
          async (v, signal) => {
            if (!['.pdf', '.docx', '.pptx', '.xlsx'].includes(v.extension)) return null;
            return workerTask(
              this.root,
              'parse-worker',
              'plugins/documents/parse-worker.ts',
              v,
              signal,
            );
          },
        );
        for (const [id, label, local] of [
          ['documents.mineru-api', 'MinerU · API', false],
          ['documents.mineru-local', 'MinerU · 本地模型', true],
        ] as const)
          ctx.capabilities.provide('files.extract@1', id, label, (v, signal) =>
            mineru.parse(v, signal, local),
          );
        ctx.registry.register({
          name: 'documents.tasks',
          owner: 'documents',
          description: '读取文档解析回执',
          permission: 'documents.read',
          mcp: false,
          input: z.object({}),
          output: z.array(
            z.object({
              id: z.string(),
              state: z.string(),
              local: z.boolean(),
              batchId: z.string().optional(),
              createdAt: z.string(),
              completedAt: z.string().optional(),
            }),
          ),
          run: () =>
            this.store.documents<any>('document-tasks').map((j) => ({
              id: j.id,
              state: j.state,
              local: j.local,
              batchId: j.batchId,
              createdAt: j.createdAt,
              completedAt: j.completedAt,
            })),
        });
      },
    };
  }
}
