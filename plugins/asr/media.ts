import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { invariant } from '../../packages/contracts/index.ts';
import type { PluginContext } from '../../packages/kernel/registry.ts';
import type { SpeechRecognition } from './index.ts';

/** Native fragments use FFmpeg only. They never load ASR or re-transcribe text. */
export function registerMedia(ctx: PluginContext, speech: SpeechRecognition) {
  const prepare = async (v: any, signal: AbortSignal, inspect: boolean) => {
    const object = await speech.files.mediaObject(v.vaultId, v.sourceHash);
    invariant(/^(audio|video)\//.test(object.mediaType), 'media_unsupported', '原件不是音视频');
    const config = speech.store.get<any>('asr.config', {});
    const ffmpeg = String(v.options?.ffmpeg || config.ffmpeg || 'ffmpeg');
    const scratch = await mkdtemp(join(tmpdir(), 'echo-media-'));
    try {
      if (inspect) {
        const probe = isAbsolute(ffmpeg)
          ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
          : 'ffprobe';
        const output = join(scratch, 'probe.json');
        await speech.runProcess(
          speech.root,
          probe,
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
            output,
            object.path,
          ],
          AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        );
        const info = JSON.parse(await readFile(output, 'utf8')),
          duration = Number(info.format?.duration);
        invariant(
          Number.isFinite(duration) && duration > 0 && duration <= 86400,
          'media_duration',
          '媒体时长无效或超过24小时',
        );
        return {
          duration,
          hasAudio: (info.streams ?? []).some((s: any) => s.codec_type === 'audio'),
        };
      }
      const audio = v.modality === 'audio';
      const output = join(scratch, audio ? 'part.wav' : 'part.mp4');
      const args = [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '2',
        '-protocol_whitelist',
        'file,pipe',
        '-ss',
        String(v.start),
        '-i',
        object.path,
        '-t',
        String(v.end - v.start),
        ...(audio
          ? ['-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']
          : [
              '-map',
              '0:v:0',
              '-an',
              '-vf',
              'fps=1,scale=320:320:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2',
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-crf',
              '28',
            ]),
        '-threads',
        '2',
        '-y',
        output,
      ];
      await speech.runProcess(speech.root, ffmpeg, args, signal);
      invariant((await stat(output)).size <= 12000000, 'media_size', '媒体片段超过模型输入上限');
      return {
        type: v.modality,
        mimeType: audio ? 'audio/wav' : 'video/mp4',
        data: (await readFile(output, { signal })).toString('base64'),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  ctx.capabilities.provide('files.media-inspect@1', 'asr.media', '音视频时长', (v, s) =>
    prepare(v, s, true),
  );
  ctx.capabilities.provide('files.media-processors@1', 'asr.media', 'FFmpeg 音视频片段', () => ({
    id: 'asr.media',
    label: 'FFmpeg 音视频片段',
    version: '1',
    modalities: ['audio', 'video'],
  }));
  ctx.capabilities.provide('files.prepare-media@1', 'asr.media', 'FFmpeg', () => ({
    ffmpeg: speech.store.get<any>('asr.config', {}).ffmpeg || 'ffmpeg',
  }));
  ctx.capabilities.provide('files.media-encode@1', 'asr.media', '音视频片段', (v, s) =>
    prepare(v, s, false),
  );
}
