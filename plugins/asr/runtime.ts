import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { open, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { invariant } from '../../packages/contracts/index.ts';
import { LocalServer } from '../../packages/kernel/local-server.ts';
import { LocalModelPool } from '../../packages/kernel/local-model-pool.ts';

export const asrModelOptions = z
  .object({
    projector: z.string().min(1),
    device: z.enum(['cpu', 'gpu']).default('gpu'),
    threads: z.number().int().min(1).max(32).default(4),
    modelSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    projectorSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const cache = new Map<string, { stamp: string; hash: string }>();
async function checksum(path: string, signal?: AbortSignal) {
  const info = await stat(path),
    stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const old = cache.get(path);
  if (old?.stamp === stamp) return old.hash;
  const file = await open(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    await file.read(magic, 0, 4, 0);
    invariant(magic.toString() === 'GGUF', 'model_format', '请选择 GGUF 模型文件');
  } finally {
    await file.close();
  }
  const hash = createHash('sha256');
  for await (const block of createReadStream(path, { signal, highWaterMark: 8 * 1024 * 1024 })) hash.update(block);
  const value = hash.digest('hex');
  cache.set(path, { stamp, hash: value });
  return value;
}
export async function prepareAsr(model: string, raw: unknown, signal?: AbortSignal) {
  const options = asrModelOptions.parse(raw),
    path = await realpath(model);
  options.projector = await realpath(options.projector);
  options.modelSha256 = await checksum(path, signal);
  options.projectorSha256 = await checksum(options.projector, signal);
  return { model: path, options };
}
export function parseAsrOutput(content: unknown) {
  invariant(typeof content === 'string', 'asr_output', '语音模型未返回文本');
  const match = content.match(/^language\s+([^<\n]+)<asr_text>([\s\S]*)$/i);
  const text = (match ? match[2] : content).replace(/<\|(?:im_end|endoftext)\|>/g, '').trim();
  return { text, ...(match ? { language: match[1].trim() } : {}) };
}
export class LlamaAsr {
  private server?: LocalServer;
  private key = '';
  private tail: Promise<unknown> = Promise.resolve();
  private life = new AbortController();
  private resourceKey = '';
  constructor(
    readonly root: string,
    readonly resources = new LocalModelPool(),
  ) {}
  private async unload() {
    await this.server?.close();
    this.server = undefined;
    this.key = '';
  }
  async release() {
    await this.tail.catch(() => {});
    await this.resources.release(this.resourceKey);
  }
  async close() {
    this.life.abort();
    await this.tail.catch(() => {});
    this.resources.forget(this.resourceKey);
    await this.unload();
  }
  status() {
    return { loaded: Boolean(this.server) };
  }
  transcribe(value: any, signal: AbortSignal) {
    const work = async () => {
      const combined = AbortSignal.any([
        signal,
        this.life.signal,
        AbortSignal.timeout(value.profile.timeoutMs),
      ]);
      combined.throwIfAborted();
      const prepared = await prepareAsr(value.profile.model, value.profile.modelOptions, combined);
      const options = prepared.options;
      invariant(
        options.modelSha256 === value.profile.modelOptions.modelSha256 &&
          options.projectorSha256 === value.profile.modelOptions.projectorSha256,
        'model_changed',
        '语音模型文件已变化，请重新保存模型配置',
      );
      const key = JSON.stringify([value.profile.command, prepared.model, options]);
      const resourceKey = 'asr:' + key;
      if (this.resourceKey && this.resourceKey !== resourceKey)
        await this.resources.release(this.resourceKey);
      return this.resources.run(
        resourceKey,
        prepared.model,
        () => this.unload(),
        combined,
        async () => {
          this.resourceKey = resourceKey;
          if (!this.server || this.key !== key) {
            await this.unload();
            this.server = new LocalServer();
            const args = [
              '-m',
              prepared.model,
              '--mmproj',
              options.projector,
              '-c',
              '8192',
              '-np',
              '1',
              '-t',
              String(options.threads),
              '-tb',
              String(options.threads),
              '-ngl',
              options.device === 'cpu' ? '0' : '99',
            ];
            if (options.device === 'cpu')
              args.push('--device', 'none', '--no-mmproj-offload', '--no-kv-offload');
            await this.server.start(
              this.root,
              value.profile.command,
              args,
              combined,
              Math.min(value.profile.timeoutMs, 180000),
            );
            this.key = key;
          }
          const prompt = [value.context, value.language ? `Transcribe in ${value.language}.` : '']
            .filter(Boolean)
            .join('\n');
          const result = await this.server.json(
            '/v1/chat/completions',
            {
              messages: [
                ...(prompt ? [{ role: 'system', content: prompt }] : []),
                {
                  role: 'user',
                  content: [
                    { type: 'input_audio', input_audio: { data: value.audio, format: 'wav' } },
                  ],
                },
              ],
              temperature: 0,
              max_tokens: 4096,
              stream: false,
            },
            combined,
          );
          invariant(
            result.choices?.[0]?.finish_reason !== 'length',
            'asr_truncated',
            '转录输出被截断，请缩短音频分段后重新处理',
          );
          return parseAsrOutput(result.choices?.[0]?.message?.content);
        },
      );
    };
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => {});
    return result;
  }
}
