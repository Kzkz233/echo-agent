import manifest from './echo-plugin.json' with { type: 'json' };
import { z } from 'zod';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname, basename, extname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { defineManifest, type Plugin, type PluginContext } from '../../packages/kernel/registry.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Files } from '../files/index.ts';
import { Events } from '../../packages/kernel/events.ts';
import { InferenceCatalog, contributeInferenceTask } from '../../packages/kernel/inference.ts';
import { ownedProcess } from '../../packages/kernel/owned-process.ts';
import { adapterSchema } from '../../packages/contracts/inference.ts';
import { invariant } from '../../packages/contracts/index.ts';
import { mediaExtensions, transcriptionOutput } from '../../packages/contracts/speech.ts';
import { asrModelOptions, LlamaAsr, prepareAsr } from './runtime.ts';
import { operations } from '../shared.ts';
import { LocalModelPool } from '../../packages/kernel/local-model-pool.ts';
import { checkLocalCommand } from '../../packages/kernel/local-command.ts';

export const asrConfig = z.object({
  ffmpeg: z.string().default('ffmpeg'),
  language: z.string().max(80).default(''),
  context: z.string().max(4000).default(''),
  chunkSeconds: z.number().int().min(10).max(60).default(30),
});
export const asrTask = 'asr.transcribe';
const clock = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 19);
export class SpeechRecognition {
  runtime: LlamaAsr;
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly files: Files,
    readonly inference: InferenceCatalog,
    readonly events: Events,
    readonly runProcess = ownedProcess,
    readonly resources = new LocalModelPool(),
  ) {
    this.runtime = new LlamaAsr(root, resources);
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      config: { schema: asrConfig },
      activate: (ctx) => {
        const runtime = new LlamaAsr(this.root, this.resources);
        this.runtime = runtime;
        ctx.dispose(() => runtime.close());
        for (const job of this.store.documents<any>('asr-jobs'))
          if (job.state === 'running')
            this.store.put('asr-jobs', job.id, { ...job, state: 'paused' });
        const descriptor = adapterSchema.parse({
          id: 'asr.llama',
          engine: 'asr-llama',
          label: 'llama.cpp · Qwen3-ASR',
          family: 'local-runtime',
          connectionSchema: z.toJSONSchema(z.object({ command: z.string().min(1) }).strict()),
          modelSchema: z.toJSONSchema(asrModelOptions),
          connectionFields: [
            { key: 'command', label: 'llama-server 可执行文件', type: 'path', pathMode: 'file' },
          ],
          modelFields: [
            { key: 'projector', label: '语音编码器文件', type: 'path', pathMode: 'file' },
            {
              key: 'device',
              label: '执行设备',
              type: 'select',
              options: ['gpu', 'cpu'],
              optionLabels: { gpu: 'GPU', cpu: 'CPU' },
            },
            { key: 'threads', label: 'CPU 线程数', type: 'number' },
          ],
          generation: [],
          embedding: [],
          transcription: ['audio'],
          transcriptionProvider: 'asr.llama',
          prepareModelProvider: 'asr.prepare',
        });
        ctx.capabilities.provide(
          'core.inference.adapters@1',
          descriptor.id,
          descriptor.label,
          () => descriptor,
        );
        ctx.capabilities.provide(
          'core.inference.check-connection@1',
          'asr.llama',
          '检查语音运行时',
          ({ connection }) => checkLocalCommand(String(connection.config.command ?? '')),
        );
        ctx.capabilities.provide(
          'core.inference.prepare-model@1',
          'asr.prepare',
          'Qwen3-ASR model validation',
          (v, signal) => prepareAsr(v.model, v.options, signal),
        );
        ctx.capabilities.provide(
          'core.inference.transcribe@1',
          'asr.llama',
          'Qwen3-ASR',
          (v, signal) => this.runtime.transcribe(v, signal),
        );
        ctx.capabilities.provide('core.inference.kinds@1', 'asr.models', '语音识别模型', () => ({
          id: 'asr.models',
          label: '语音识别模型',
          operation: 'transcribe',
          capability: 'transcription',
          order: 30,
        }));
        contributeInferenceTask(ctx, {
          id: asrTask,
          label: '知识库音视频转录',
          operation: 'transcribe',
          scope: 'shared',
          inputs: ['audio'],
        });
        ctx.capabilities.provide('files.parsers@1', 'asr.media', '本地音视频转录', () => ({
          id: 'asr.media',
          label: '本地音视频转录',
          version: '2',
          contract: 'files.extract@3',
          extensions: mediaExtensions,
          maxBytes: 8 * 1024 ** 3,
          prepare: 'asr.plan',
        }));
        ctx.capabilities.provide('files.prepare-parse@1', 'asr.plan', '固定转录配置', () =>
          this.plan(),
        );
        ctx.capabilities.provide('files.extract@3', 'asr.media', '本地音视频转录', (v, signal) =>
          this.parse(ctx, v, signal, v.plan.options),
        );
        ctx.capabilities.provide('files.extract@2', 'asr.media', '本地音视频转录', (v, signal) =>
          this.parse(ctx, v, signal),
        );
        ctx.capabilities.provide(
          'files.extraction-progress@1',
          'asr.progress',
          'Audio transcription progress',
          ({ requestId }) => {
            const job = this.store.document<any>('asr-jobs', requestId);
            return job ? { completed: job.completed, total: job.total, unit: 'segments' } : null;
          },
        );
        const op = operations(ctx, 'asr');
        op(
          'status',
          '读取语音转录进度和模型加载状态',
          z.object({}),
          'asr.read',
          () => ({
            ...this.runtime.status(),
            jobs: this.store
              .documents<any>('asr-jobs')
              .map(({ id, state, completed, total, name, error }) => ({
                id,
                state,
                completed,
                total,
                name,
                error,
              })),
          }),
          false,
        );
      },
    };
  }
  private plan() {
    const config = asrConfig.parse(this.store.get('asr.config', {}));
    const profileId = this.store.get<Record<string, string>>('routes', {})[asrTask];
    invariant(profileId, 'asr_model_missing', '请在语音转录插件中选择语音识别模型');
    const model = this.inference.models().find((m) => m.id === profileId);
    invariant(
      model && this.inference.supports(model, { operation: 'transcribe', inputs: ['audio'] }),
      'asr_model_unavailable',
      '当前语音识别模型不可用',
    );
    const profile = this.inference.resolve(profileId),
      adapter = this.inference.adapter(profile.adapterId!);
    invariant(adapter.transcriptionProvider, 'asr_provider_missing', '此接入器未提供语音转录');
    return {
      options: { config, profile, provider: adapter.transcriptionProvider },
      provenance: {
        model: model.name,
        modelId: profile.id,
        modelSha256: (profile.modelOptions as any).modelSha256,
        projectorSha256: (profile.modelOptions as any).projectorSha256,
        language: config.language,
        context: config.context,
        chunkSeconds: config.chunkSeconds,
      },
    };
  }
  private async parse(
    ctx: PluginContext,
    value: { vaultId: string; fileId: string; sourceHash: string; name: string; requestId: string },
    signal: AbortSignal,
    frozen?: Record<string, any>,
  ) {
    if (!mediaExtensions.includes(extname(value.name).toLowerCase())) return null;
    const snapshot = frozen ?? this.plan().options;
    const config = asrConfig.parse(snapshot.config),
      profile = snapshot.profile,
      profileId = profile.id;
    // CPU threads, device and executable locations are execution bindings. The
    // model artifacts and transcription settings remain fixed for continuation.
    const current = this.inference.models().find((m) => m.id === profileId);
    if (current) {
      const latest = this.inference.resolve(profileId);
      const keys = ['modelSha256', 'projectorSha256'];
      if (
        latest.adapterId === profile.adapterId &&
        keys.every((k) => latest.modelOptions?.[k] === profile.modelOptions?.[k])
      ) {
        profile.command = latest.command;
        profile.model = latest.model;
        profile.modelOptions = {
          ...profile.modelOptions,
          projector: latest.modelOptions?.projector,
          device: latest.modelOptions?.device,
          threads: latest.modelOptions?.threads,
        };
      }
    }
    config.ffmpeg = asrConfig.parse(this.store.get('asr.config', {})).ffmpeg;
    const adapter = this.inference.adapter(profile.adapterId!);
    invariant(
      adapter.transcriptionProvider === snapshot.provider,
      'asr_provider_changed',
      '转录接入器已变化，请重新解析',
    );
    const file = await this.files.original(value.vaultId, value.fileId, value.sourceHash);
    const source = await this.files.path(value.vaultId, file.relativePath);
    const digest = createHash('sha256');
    for await (const data of createReadStream(source, { signal })) digest.update(data);
    invariant(digest.digest('hex') === file.hash, 'source_changed', '保存的原件已变化');
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          file.hash,
          profileId,
          profile.modelOptions?.modelSha256 ?? profile.model,
          profile.modelOptions?.projectorSha256,
          config.language,
          config.context,
          config.chunkSeconds,
        ]),
      )
      .digest('hex');
    const previous = this.store.document<any>('asr-jobs', value.requestId);
    if (previous && previous.identity !== identity) {
      const legacy = createHash('sha256')
        .update(JSON.stringify([file.hash, profileId, profile.model, profile.modelOptions, config]))
        .digest('hex');
      invariant(
        previous.identity === legacy,
        'asr_checkpoint',
        '旧任务配置无法确认，请创建重解析任务；已有转录分段保持不变',
      );
      previous.identity = identity;
    }
    let job: any =
      previous?.identity === identity
        ? previous
        : {
            id: value.requestId,
            identity,
            name: value.name,
            vaultId: value.vaultId,
            fileId: value.fileId,
            sourceHash: file.hash,
            modelId: profileId,
            model: profile.name,
            segments: [],
            completed: 0,
            total: 0,
            createdAt: new Date().toISOString(),
          };
    const save = () => {
      this.store.put('asr-jobs', job.id, job);
      this.events.emit('knowledge.updated', { vaultId: value.vaultId });
    };
    const scratchRoot = join(dirname(this.store.path), 'cache/asr');
    await mkdir(scratchRoot, { recursive: true });
    const scratch = await mkdtemp(join(scratchRoot, 'job-'));
    const ffprobe = isAbsolute(config.ffmpeg)
      ? join(dirname(config.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      : 'ffprobe';
    try {
      job = { ...job, state: 'running', error: undefined };
      save();
      const probe = join(scratch, 'probe.json');
      await this.runProcess(
        this.root,
        ffprobe,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file,pipe',
          '-show_format',
          '-show_streams',
          '-of',
          'json',
          '-o',
          probe,
          source,
        ],
        AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      );
      const details = JSON.parse(await readFile(probe, 'utf8')),
        duration = Number(details.format?.duration);
      invariant(
        details.streams?.some((stream: any) => stream.codec_type === 'audio'),
        'asr_no_audio',
        '文件没有音轨',
      );
      invariant(
        Number.isFinite(duration) && duration > 0 && duration <= 86400,
        'asr_duration',
        '音视频时长需在24小时以内',
      );
      job.total = Math.ceil(duration / config.chunkSeconds);
      save();
      for (let index = job.completed; index < job.total; index++) {
        signal.throwIfAborted();
        const wav = join(scratch, 'chunk.wav'),
          start = index * config.chunkSeconds;
        await this.runProcess(
          this.root,
          config.ffmpeg,
          [
            '-nostdin',
            '-v',
            'error',
            '-y',
            '-protocol_whitelist',
            'file,pipe',
            '-ss',
            String(start),
            '-i',
            source,
            '-t',
            String(Math.min(config.chunkSeconds, duration - start)),
            '-map',
            '0:a:0',
            '-vn',
            '-ar',
            '16000',
            '-ac',
            '1',
            '-c:a',
            'pcm_s16le',
            '-threads',
            '1',
            wav,
          ],
          AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        );
        invariant((await stat(wav)).size <= 2200000, 'asr_chunk_size', '音频分段超过上限');
        const audio = await readFile(wav);
        const result = transcriptionOutput.parse(
          await ctx.capabilities.invoke(
            'core.inference.transcribe@1',
            snapshot.provider,
            {
              profile,
              audio: audio.toString('base64'),
              language: config.language,
              context: config.context,
            },
            signal,
          ),
        );
        signal.throwIfAborted();
        job.segments.push({
          start,
          end: Math.min(duration, start + config.chunkSeconds),
          text: result.text,
          language: result.language,
        });
        job.completed = index + 1;
        save();
      }
      job.state = 'completed';
      job.completedAt = new Date().toISOString();
      save();
      const text =
        `# ${basename(value.name, extname(value.name))}\n\n> 音视频转录；时间为分段范围，不是逐字对齐。\n\n` +
        job.segments
          .map(
            (segment: any) =>
              `## [${clock(segment.start)}–${clock(segment.end)}](echo-asset:${file.hash}#t=${segment.start})\n\n${segment.text || '（此段未识别到文字）'}\n`,
          )
          .join('\n');
      invariant(text.length <= 16000000, 'asr_text_size', '转录文本超过知识条目上限');
      return { text, segments: job.segments };
    } catch (error: any) {
      job.state = signal.aborted ? 'paused' : 'failed';
      job.error = error.message;
      save();
      throw error;
    } finally {
      await this.runtime.release();
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
