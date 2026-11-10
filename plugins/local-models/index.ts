import { z } from 'zod';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import manifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest, type Plugin } from '../../packages/kernel/registry.ts';
import { Store } from '../../packages/kernel/store.ts';
import { invariant } from '../../packages/contracts/index.ts';
import { adapterSchema } from '../../packages/contracts/inference.ts';
import { Events } from '../../packages/kernel/events.ts';
import { GgufSession, ggufOptions, prepareGguf } from './gguf.ts';
export const localRuntimeConfig = z.object({
  maxLoadedModels: z.number().int().min(1).max(4).default(1),
  idleSeconds: z.number().int().min(10).max(3600).default(120),
});
export const localModelOptions = z
  .object({
    weightsFile: z
      .string()
      .regex(/^[\w.-]+\.onnx$/)
      .default('model_quantized.onnx'),
    keepLoaded: z.boolean().default(false),
    allowDownload: z.boolean().default(false),
    downloadBaseUrl: z
      .string()
      .url()
      .regex(/^https:\/\//)
      .default('https://huggingface.co/'),
    promptStyle: z.enum(['auto', 'none', 'bge-zh', 'embeddinggemma']).default('auto'),
  })
  .strict();
type Session = {
  worker?: Worker;
  gguf?: GgufSession;
  timer?: NodeJS.Timeout;
  busy: boolean;
  lastUsed: number;
  model: string;
  profiles: Set<string>;
};
export class LocalModels {
  private sessions = new Map<string, Session>();
  private queue: Promise<any> = Promise.resolve();
  constructor(
    readonly store: Store,
    readonly root: string,
    readonly events: Events,
  ) {}
  status() {
    return {
      loaded: this.sessions.size,
      models: [...this.sessions.values()].map((s) => ({
        model: s.model,
        busy: s.busy,
        lastUsed: s.lastUsed,
      })),
    };
  }
  private async release(key: string) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    clearTimeout(s.timer);
    await s.worker?.terminate();
    await s.gguf?.close();
  }
  async close() {
    await Promise.all([...this.sessions.keys()].map((k) => this.release(k)));
    await this.queue.catch(() => {});
  }
  private releaseUnused() {
    const selected = new Set(Object.values(this.store.get<Record<string, string>>('routes', {})));
    for (const [key, s] of this.sessions)
      if (!s.busy && ![...s.profiles].some((id) => selected.has(id))) void this.release(key);
  }
  private encode(v: any, signal: AbortSignal) {
    const work = async () => {
      signal.throwIfAborted();
      const options = localModelOptions.parse(v.profile.modelOptions),
        cfg = localRuntimeConfig.parse(this.store.get('models.config', this.store.get('local-models.config', {})));
      invariant(v.profile.model, 'local_model_missing', '请填写本地 ONNX 模型目录或 ID');
      invariant(
        v.inputs.every((i: any) => i.content.every((p: any) => p.type === 'text')),
        'modality_unsupported',
        '此本地运行时只实现文本向量',
      );
      let texts: string[] = v.inputs.map((i: any) => i.content.map((p: any) => p.text).join('\n'));
      const style =
        options.promptStyle === 'auto'
          ? /embeddinggemma/i.test(v.profile.model)
            ? 'embeddinggemma'
            : /bge.*zh/i.test(v.profile.model)
              ? 'bge-zh'
              : 'none'
          : options.promptStyle;
      if (style === 'embeddinggemma')
        texts = texts.map((text) =>
          v.purpose === 'query'
            ? 'task: search result | query: ' + text
            : 'title: none | text: ' + text,
        );
      else if (style === 'bge-zh' && v.purpose === 'query')
        texts = texts.map((text) => '为这个句子生成表示以用于检索相关文章：' + text);
      const key = createHash('sha256')
        .update(JSON.stringify([v.profile.model, options]))
        .digest('hex');
      let session = this.sessions.get(key);
      if (!session) {
        while (this.sessions.size >= cfg.maxLoadedModels) {
          const oldest = [...this.sessions].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          await this.release(oldest[0]);
        }
        signal.throwIfAborted();
        const built = join(this.root, 'dist/embedding-worker.mjs'),
          source = join(this.root, 'plugins/local-models/embedding-worker.ts');
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            [
              'PATH',
              'SYSTEMROOT',
              'TEMP',
              'TMP',
              'HOME',
              'USERPROFILE',
              'LOCALAPPDATA',
              'APPDATA',
              'NUMBER_OF_PROCESSORS',
              'PROCESSOR_ARCHITECTURE',
              'NODE_EXTRA_CA_CERTS',
              'HTTP_PROXY',
              'HTTPS_PROXY',
              'NO_PROXY',
            ].includes(name.toUpperCase()),
          ),
        );
        const worker = new Worker(pathToFileURL(existsSync(source) ? source : built), {
          execArgv: existsSync(source) ? ['--import', 'tsx'] : [],
          env,
        });
        session = {
          worker,
          busy: false,
          lastUsed: Date.now(),
          model: v.profile.model,
          profiles: new Set(),
        };
        this.sessions.set(key, session);
        const owned = session;
        const ended = () => {
          clearTimeout(owned.timer);
          if (this.sessions.get(key) === owned) this.sessions.delete(key);
        };
        worker.on('exit', ended);
        worker.on('error', ended);
      }
      const owned = session;
      owned.profiles.add(v.profile.id);
      clearTimeout(owned.timer);
      owned.busy = true;
      const requestId = randomUUID();
      try {
        return await new Promise((resolve, reject) => {
          const worker = owned.worker!;
          const cleanup = () => {
            worker.off('message', message);
            worker.off('error', error);
            worker.off('exit', exit);
            signal.removeEventListener('abort', abort);
            clearTimeout(timer);
          };
          const message = (m: any) => {
            if (m.id !== requestId) return;
            cleanup();
            m.error ? reject(Error(m.error)) : resolve({ vectors: m.vectors });
          };
          const error = (e: Error) => {
            cleanup();
            void this.release(key);
            reject(e);
          };
          const exit = () => error(Error('本地向量工作进程已退出；下次请求可重新加载。'));
          const abort = () => error(Error('本地模型请求已取消。'));
          const timer = setTimeout(
            () => error(Error('本地模型请求超时。')),
            Math.min(v.profile.timeoutMs, 180000),
          );
          worker.on('message', message);
          worker.once('error', error);
          worker.once('exit', exit);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) {
            abort();
            return;
          }
          worker.postMessage({
            id: requestId,
            texts,
            config: {
              ...options,
              model: v.profile.model,
              modelPath: v.profile.model === 'Xenova/bge-small-zh-v1.5'
                ? [join(this.root,'models',v.profile.model),join(this.root,'dist/vendor/models',v.profile.model)]
                    .find(directory=>existsSync(join(directory,'onnx',options.weightsFile)))
                : undefined,
              cacheDir: join(dirname(this.store.path), 'models'),
            },
          });
        });
      } finally {
        owned.busy = false;
        owned.lastUsed = Date.now();
        if (this.sessions.get(key) === owned && !options.keepLoaded) {
          owned.timer = setTimeout(() => void this.release(key), cfg.idleSeconds * 1000);
          owned.timer.unref();
        }
      }
    };
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => {});
    return result;
  }
  private encodeGguf(v: any, signal: AbortSignal) {
    const work = async () => {
      signal.throwIfAborted();
      const options = ggufOptions.parse(v.profile.modelOptions),
        cfg = localRuntimeConfig.parse(this.store.get('models.config', this.store.get('local-models.config', {}))),
        images = v.inputs.some((i: any) => i.content.some((p: any) => p.type !== 'text')),
        video = v.inputs.some((i: any) => i.content.some((p: any) => p.type === 'video')),
        key = createHash('sha256')
          .update(
            JSON.stringify(['gguf', v.profile.command, v.profile.model, options, images, video]),
          )
          .digest('hex');
      let owned = this.sessions.get(key);
      if (!owned) {
        while (this.sessions.size >= cfg.maxLoadedModels)
          await this.release(
            [...this.sessions].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0],
          );
        signal.throwIfAborted();
        const gguf = new GgufSession(this.root);
        await gguf.start(v.profile, images, signal, video);
        owned = {
          gguf,
          busy: false,
          lastUsed: Date.now(),
          model: v.profile.model,
          profiles: new Set(),
        };
        this.sessions.set(key, owned);
      }
      const s = owned;
      s.profiles.add(v.profile.id);
      s.busy = true;
      clearTimeout(s.timer);
      try {
        return await s.gguf!.encode(
          v,
          AbortSignal.any([signal, AbortSignal.timeout(v.profile.timeoutMs)]),
        );
      } catch (e) {
        await this.release(key);
        throw e;
      } finally {
        s.busy = false;
        s.lastUsed = Date.now();
        if (this.sessions.get(key) === s && !options.keepLoaded) {
          s.timer = setTimeout(() => void this.release(key), cfg.idleSeconds * 1000);
          s.timer.unref();
        }
      }
    };
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => {});
    return result;
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      config: { schema: localRuntimeConfig },
      activate: (ctx) => {
        ctx.dispose(
          this.events.subscribe((event) => {
            if (['routes.changed', 'models.changed', 'connections.changed'].includes(event.type))
              this.releaseUnused();
          }),
        );
        const descriptor = adapterSchema.parse({
          id: 'local-models.onnx',
          engine: 'onnx',
          label: 'ONNX Runtime · CPU',
          family: 'local-runtime',
          connectionSchema: z.toJSONSchema(z.object({}).strict()),
          modelSchema: z.toJSONSchema(localModelOptions),
          connectionFields: [],
          modelFields: [
            { key: 'weightsFile', label: 'ONNX 权重文件名', type: 'text' },
            { key: 'keepLoaded', label: '保留已加载的本地模型', type: 'boolean' },
            { key: 'allowDownload', label: '允许首次下载模型', type: 'boolean' },
            { key: 'downloadBaseUrl', label: 'HTTPS 模型下载源', type: 'text' },
            {
              key: 'promptStyle',
              label: '检索输入格式',
              type: 'select',
              options: ['auto', 'none', 'bge-zh', 'embeddinggemma'],
              optionLabels: {
                auto: '自动选择',
                none: '不添加格式',
                'bge-zh': 'BGE 中文检索',
                embeddinggemma: 'EmbeddingGemma 检索',
              },
            },
          ],
          generation: [],
          embedding: ['text'],
          embeddingProvider: 'local-models.onnx',
          presets: [
            {
              id: 'local-models.bge-small-zh',
              name: 'BGE Small · Chinese',
              model: 'Xenova/bge-small-zh-v1.5',
              generation: { enabled: false, inputs: ['text'] },
              embedding: { enabled: true, inputs: ['text'], dimensions: 512 },
              options: {
                weightsFile: 'model_quantized.onnx',
                promptStyle: 'bge-zh',
                allowDownload: false,
              },
            },
          ],
        });
        ctx.capabilities.provide(
          'core.inference.adapters@1',
          descriptor.id,
          descriptor.label,
          () => descriptor,
        );
        ctx.capabilities.provide('embeddings.encode@1', descriptor.id, descriptor.label, (v, s) =>
          this.encode(v, s),
        );
        const gguf = adapterSchema.parse({
          id: 'local-models.gguf',
          engine: 'gguf',
          label: 'llama.cpp · GGUF',
          family: 'local-runtime',
          connectionSchema: z.toJSONSchema(
            z
              .object({ command: z.string().min(1), args: z.array(z.string()).default([]) })
              .strict(),
          ),
          modelSchema: z.toJSONSchema(ggufOptions),
          connectionFields: [
            { key: 'command', label: 'llama-server 可执行文件', type: 'path', pathMode: 'file' },
            { key: 'args', label: '运行时附加参数（每行一项）', type: 'string-list' },
          ],
          modelFields: [
            { key: 'projector', label: 'GGUF 多模态投影文件', type: 'path', pathMode: 'file' },
            {
              key: 'device',
              label: '执行设备',
              type: 'select',
              options: ['cpu', 'gpu'],
              optionLabels: { cpu: 'CPU', gpu: 'GPU' },
            },
            { key: 'threads', label: 'CPU 线程数', type: 'number' },
            { key: 'keepLoaded', label: '保留已加载的本地模型', type: 'boolean' },
            {
              key: 'promptStyle',
              label: '检索输入格式',
              type: 'select',
              options: ['none', 'embeddinggemma'],
              optionLabels: { none: '不添加格式', embeddinggemma: 'EmbeddingGemma 检索' },
            },
            { key: 'imageTokens', label: '图片 Token 预算', type: 'number' },
            { key: 'videoFps', label: '视频采样帧率', type: 'number' },
          ],
          generation: [],
          embedding: ['text', 'image', 'audio', 'video'],
          embeddingProvider: 'local-models.gguf',
          prepareModelProvider: 'local-models.gguf-prepare',
          modelIdentityField: 'modelSha256',
          embeddingIdentityFields: ['modelSha256', 'projectorSha256', 'promptStyle', 'imageTokens'],
          presets: [
            {
              id: 'local-models.embeddinggemma2',
              name: 'EmbeddingGemma 2',
              generation: { enabled: false, inputs: ['text'] },
              embedding: {
                enabled: true,
                inputs: ['text', 'image', 'audio', 'video'],
                dimensions: 768,
              },
              options: { promptStyle: 'embeddinggemma', imageTokens: 280, videoFps: 1 },
            },
          ],
        });
        ctx.capabilities.provide('core.inference.adapters@1', gguf.id, gguf.label, () => gguf);
        ctx.capabilities.provide(
          'core.inference.prepare-model@1',
          'local-models.gguf-prepare',
          gguf.label,
          (v, s) => prepareGguf(v, s),
        );
        ctx.capabilities.provide('embeddings.encode@1', gguf.id, gguf.label, (v, s) =>
          this.encodeGguf(v, s),
        );
        ctx.registry.register({
          name: 'local-models.status',
          owner: 'local-models',
          description: '读取已加载的本地模型状态',
          permission: 'local-models.read',
          mcp: false,
          input: z.object({}),
          output: z.object({
            loaded: z.number(),
            models: z.array(
              z.object({ model: z.string(), busy: z.boolean(), lastUsed: z.number() }),
            ),
          }),
          run: () => this.status(),
        });
        ctx.registry.register({
          name: 'local-models.release',
          owner: 'local-models',
          description: '释放空闲的本地模型',
          permission: 'local-models.write',
          mcp: false,
          input: z.object({}),
          output: z.object({ released: z.number() }),
          run: async () => {
            const idle = [...this.sessions].filter(([, s]) => !s.busy);
            await Promise.all(idle.map(([key]) => this.release(key)));
            return { released: idle.length };
          },
        });
        ctx.dispose(() => this.close());
      },
    };
  }
}
