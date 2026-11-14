import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { workerTask } from '../../packages/kernel/worker-task.ts';
import type { Plugin } from '../../packages/kernel/registry.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Secrets } from '../../packages/kernel/secrets.ts';
import { Mineru, documentConfig } from './mineru.ts';
import { z } from 'zod';
import type { Files } from '../files/index.ts';
import { extname } from 'node:path';
import { createHash } from 'node:crypto';
export class Documents {
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly secrets: Secrets,
    readonly files: Files,
  ) {}
  plugin(): Plugin {
    return {
      manifest: defineManifest(packageManifest),
      config: { schema: documentConfig },
      activate: (ctx) => {
        const mineru = new Mineru(this.root, this.store, this.secrets);
        const localExtensions = ['.pdf', '.docx', '.pptx', '.xlsx'];
        const choices = [
          ['documents.local', '本地文档正文', localExtensions],
          [
            'documents.mineru-api',
            'MinerU · API',
            ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg'],
          ],
          [
            'documents.mineru-local',
            'MinerU · 本地模型',
            ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg'],
          ],
        ] as const;
        for (const [id, label, extensions] of choices) {
          ctx.capabilities.provide('files.parsers@1', id, label, () => ({
            id,
            label,
            version: '2',
            contract: 'files.extract@3',
            extensions: [...extensions],
            maxBytes: 16000000,
            ...(id === 'documents.local' ? {} : { prepare: id }),
          }));
          if (id !== 'documents.local')
            ctx.capabilities.provide('files.prepare-parse@1', id, label, ({ requestId }) => {
              const key = createHash('sha256')
                .update(JSON.stringify([id === 'documents.mineru-local', requestId]))
                .digest('hex');
              const config = documentConfig.parse(
                this.store.document<any>('document-tasks', key)?.config ??
                  this.store.get('documents.config', {}),
              );
              const { apiKeyRef, command, args, endpoint, timeoutSeconds, ...provenance } = config;
              return { options: { config }, provenance };
            });
          ctx.capabilities.provide('files.extract@3', id, label, async (v, signal) => {
            const file = await this.files.original(v.vaultId, v.fileId, v.sourceHash);
            const data = (await this.files.parsers.read(file, signal)).toString('base64');
            const input = {
              name: v.name,
              extension: extname(v.name).toLowerCase(),
              data,
              requestId: v.requestId,
            };
            if (id === 'documents.local')
              return workerTask(
                this.root,
                'parse-worker',
                'plugins/documents/parse-worker.ts',
                input,
                signal,
              );
            return mineru.parse(
              input,
              signal,
              id === 'documents.mineru-local',
              v.plan.options.config,
            );
          });
        }
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
