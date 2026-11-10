import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { invariant } from '../../packages/contracts/index.ts';

export const ggufOptions = z
  .object({
    projector: z.string().default(''),
    device: z.enum(['cpu', 'gpu']).default('cpu'),
    threads: z.number().int().min(1).max(32).default(2),
    keepLoaded: z.boolean().default(false),
    promptStyle: z.enum(['none', 'embeddinggemma']).default('embeddinggemma'),
    imageTokens: z.number().int().min(64).max(2048).default(280),
    videoFps: z.number().min(0.1).max(4).default(1),
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
const digests = new Map<string, { stamp: string; digest: string }>();
async function digestFile(path: string, signal?: AbortSignal) {
  const s = await stat(path),
    stamp = `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  const old = digests.get(path);
  if (old?.stamp === stamp) return old.digest;
  const handle = await open(path, 'r');
  try {
    const b = Buffer.alloc(4);
    await handle.read(b, 0, 4, 0);
    invariant(b.toString() === 'GGUF', 'model_format', '请选择 GGUF 模型文件');
  } finally {
    await handle.close();
  }
  const hash = createHash('sha256');
  for await (const data of createReadStream(path, { signal })) hash.update(data);
  const digest = hash.digest('hex');
  digests.set(path, { stamp, digest });
  return digest;
}
export async function prepareGguf(
  v: { model: string; options: unknown; embedding?: { inputs: string[] } },
  signal?: AbortSignal,
) {
  const options = ggufOptions.parse(v.options),
    model = resolve(v.model);
  invariant(
    !v.embedding?.inputs.some((m) => m !== 'text') || options.projector,
    'projector_missing',
    '媒体向量需要匹配的 GGUF 投影文件',
  );
  options.modelSha256 = await digestFile(model, signal);
  if (options.projector) {
    options.projector = resolve(options.projector);
    options.projectorSha256 = await digestFile(options.projector, signal);
  } else delete options.projectorSha256;
  return { model, options };
}
export class GgufSession {
  private guardian?: ChildProcess;
  private base = '';
  private token = randomUUID();
  constructor(readonly root: string) {}
  async close() {
    const p = this.guardian;
    this.guardian = undefined;
    if (!p || p.exitCode !== null || !p.connected) return;
    await new Promise<void>((done) => {
      p.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      const timer = setTimeout(() => {
        p.disconnect();
        done();
      }, 5000);
      p.send({ type: 'stop' });
    });
  }
  async start(profile: any, images: boolean, signal: AbortSignal, video = false) {
    const prepared = await prepareGguf(
        { model: profile.model, options: profile.modelOptions },
        signal,
      ),
      o = prepared.options;
    invariant(
      o.modelSha256 === profile.modelOptions.modelSha256 &&
        o.projectorSha256 === profile.modelOptions.projectorSha256,
      'model_changed',
      '模型文件已变化，请重新保存模型配置后重建对应向量空间',
    );
    invariant(
      profile.command && existsSync(profile.command),
      'runtime_missing',
      '请选择 llama-server 可执行文件',
    );
    invariant(!images || o.projector, 'projector_missing', '图片向量需要匹配的 GGUF 投影文件');
    const port = await new Promise<number>((ok, no) => {
      const s = createServer();
      s.once('error', no);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as any).port;
        s.close(() => ok(p));
      });
    });
    this.base = `http://127.0.0.1:${port}`;
    const alias = 'echo-' + randomUUID();
    const args = [
      '-m',
      prepared.model,
      '--alias',
      alias,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--api-key',
      this.token,
      '--embedding',
      '--pooling',
      'mean',
      '-c',
      '8192',
      '-b',
      '8192',
      '-ub',
      '8192',
      '-np',
      '1',
      '-t',
      String(o.threads),
      '-tb',
      String(o.threads),
      '--no-webui',
    ];
    if (o.device === 'cpu') args.push('--device', 'none', '--no-kv-offload', '-ngl', '0');
    else args.push('-ngl', '99');
    if (images) {
      args.push(
        '--mmproj',
        o.projector,
        '--image-min-tokens',
        String(o.imageTokens),
        '--image-max-tokens',
        String(o.imageTokens),
      );
      if (o.device === 'cpu') args.push('--no-mmproj-offload');
    }
    if (video) args.push('--video-fps', String(o.videoFps));
    const source = join(this.root, 'packages/kernel/process-guardian.ts');
    const p = fork(existsSync(source) ? source : join(this.root, 'dist/process-guardian.mjs'), [], {
      execArgv: existsSync(source) ? ['--import', 'tsx'] : [],
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP },
    });
    this.guardian = p;
    let failure: string | undefined;
    p.on('error', (e) => {
      failure = e.message;
    });
    p.on('message', (m: any) => {
      if (m.type === 'failure') failure = m.message;
      else if (m.type === 'exited') failure = `本地模型退出 (${m.code}): ${m.tail}`;
    });
    p.send({
      type: 'start',
      command: resolve(profile.command),
      args: [...(profile.args ?? []), ...args],
    });
    try {
      const deadline = Date.now() + Math.min(profile.timeoutMs, 90000);
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (failure || p.exitCode !== null) throw Error(failure ?? '本地模型进程提前退出');
        try {
          const data = await this.json(
            '/v1/models',
            undefined,
            AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          );
          invariant(
            data.data?.some((m: any) => m.id === alias),
            'model_identity',
            '本地端口的模型身份不符',
          );
          return;
        } catch (e) {
          if ((e as any).code === 'model_identity') throw e;
        }
        await delay(100, undefined, { signal });
      }
      throw Error('本地模型启动超时');
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private async json(path: string, body: any, signal: AbortSignal) {
    const r = await fetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (!r.ok) {
      const payload = (await r.json().catch(() => undefined)) as any;
      const detail = String(payload?.error?.message ?? payload?.message ?? '')
        .replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, '[media]')
        .slice(0, 400);
      throw Error(`本地模型 HTTP ${r.status}${detail ? ': ' + detail : ''}`);
    }
    return r.json() as Promise<any>;
  }
  async encode(v: any, signal: AbortSignal) {
    const o = ggufOptions.parse(v.profile.modelOptions),
      inputs: any[] = [],
      owners: number[] = [],
      weights: number[] = [];
    for (let n = 0; n < v.inputs.length; n++) {
      const item = v.inputs[n];
      if (item.content.some((p: any) => p.type !== 'text')) {
        invariant(
          item.content.every(
            (p: any) =>
              (p.type === 'text' && Buffer.byteLength(p.text) < 7000) ||
              (p.type === 'image' && ['image/png', 'image/jpeg'].includes(p.mimeType)) ||
              (p.type === 'audio' &&
                [
                  'audio/wav',
                  'audio/x-wav',
                  'audio/wave',
                  'audio/mpeg',
                  'audio/mp3',
                  'audio/flac',
                ].includes(p.mimeType)) ||
              (p.type === 'video' &&
                ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'].includes(
                  p.mimeType,
                )),
          ),
          'modality_unsupported',
          '不支持此媒体格式；混合输入中的文字需少于 7000 字节',
        );
        inputs.push({
          content: item.content.map((p: any) =>
            p.type === 'text'
              ? { type: 'text', text: p.text }
              : p.type === 'image'
                ? { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } }
                : p.type === 'audio'
                  ? { type: 'input_audio', input_audio: { data: p.data } }
                  : { type: 'input_video', input_video: { data: p.data } },
          ),
        });
        owners.push(n);
        weights.push(1);
        continue;
      }
      const text = item.content.map((p: any) => p.text).join('\n');
      let parts = [{ text, weight: 1 }];
      if (v.purpose === 'document' && Buffer.byteLength(text) > 7000) {
        const tokenized = await this.json(
          '/tokenize',
          { content: text, add_special: false },
          signal,
        );
        invariant(Array.isArray(tokenized.tokens), 'tokenize_output', '本地分词结果无效');
        if (tokenized.tokens.length > 7800) {
          parts = [];
          for (let j = 0; j < tokenized.tokens.length; j += 7800) {
            const tokens = tokenized.tokens.slice(j, j + 7800),
              decoded = await this.json('/detokenize', { tokens }, signal);
            invariant(typeof decoded.content === 'string', 'tokenize_output', '本地分词结果无效');
            parts.push({ text: decoded.content, weight: tokens.length });
          }
        }
      }
      for (const part of parts) {
        inputs.push(
          o.promptStyle === 'embeddinggemma'
            ? (v.purpose === 'query' ? 'task: search result | query: ' : 'title: none | text: ') +
                part.text
            : part.text,
        );
        owners.push(n);
        weights.push(part.weight);
      }
    }
    const vectors: number[][] = v.inputs.map(() => []);
    // A single slot avoids CPU/VRAM bursts; never silently truncate long documents.
    for (let i = 0; i < inputs.length; i++) {
      const data = await this.json(
          '/v1/embeddings',
          { input: [inputs[i]], encoding_format: 'float' },
          signal,
        ),
        vector = data.data?.[0]?.embedding;
      invariant(
        data.data?.length === 1 &&
          Array.isArray(vector) &&
          vector.length > 0 &&
          vector.every((x: any) => typeof x === 'number' && Number.isFinite(x)) &&
          vector.some(Boolean),
        'embedding_output',
        '本地模型向量无效',
      );
      const dest = vectors[owners[i]];
      invariant(
        !dest.length || dest.length === vector.length,
        'embedding_output',
        '本地模型向量维度变化',
      );
      for (let j = 0; j < vector.length; j++) dest[j] = (dest[j] ?? 0) + weights[i] * vector[j];
    }
    for (const vector of vectors) {
      const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
      invariant(norm > 0, 'embedding_output', '本地模型向量无效');
      for (let j = 0; j < vector.length; j++) vector[j] /= norm;
    }
    return { vectors };
  }
}
