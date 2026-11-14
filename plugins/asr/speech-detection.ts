import { z } from 'zod';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import model from '../../resources/models/silero-vad/manifest.json' with { type: 'json' };

export const detectionOptions = z.object({
  threshold: z.number().min(0.1).max(0.95).default(0.5),
  minSpeechMs: z.number().int().min(50).max(2000).default(250),
  minSilenceMs: z.number().int().min(50).max(2000).default(1000),
  paddingMs: z.number().int().min(0).max(1000).default(150),
});
export const speechDetectionInput = z.object({
  requestId: z.string().min(1).max(200),
  audio: z.string().min(1).max(4000000),
  options: detectionOptions.default(() => detectionOptions.parse({})),
});
export const speechDetectionOutput = z.object({
  duration: z.number().positive().max(61),
  speechSeconds: z.number().nonnegative(),
  maxProbability: z.number().min(0).max(1),
  meanProbability: z.number().min(0).max(1),
  ranges: z
    .array(z.object({ start: z.number().nonnegative(), end: z.number().positive() }))
    .max(2000),
});
export type SpeechDetection = z.infer<typeof speechDetectionOutput>;
export const sileroIdentity = { id: 'asr.silero', version: model.version, sha256: model.sha256 };

/** A job leases its own CPU worker; finishing, pausing and plugin disposal all release it. */
export class SpeechDetector {
  private workers = new Map<string, Worker>();
  constructor(readonly root: string) {}
  get loaded() {
    return this.workers.size > 0;
  }
  async detect(jobId: string, value: z.infer<typeof speechDetectionInput>, signal: AbortSignal) {
    signal.throwIfAborted();
    let worker = this.workers.get(jobId);
    if (!worker) {
      const source = join(this.root, 'plugins/asr/vad-worker.ts');
      worker = new Worker(
        pathToFileURL(existsSync(source) ? source : join(this.root, 'dist/vad-worker.mjs')),
        {
          execArgv: existsSync(source) ? ['--import', 'tsx'] : [],
          workerData: { root: this.root },
        },
      );
      this.workers.set(jobId, worker);
      const created = worker;
      worker.on('error', () => {});
      worker.once('exit', () => {
        if (this.workers.get(jobId) === created) this.workers.delete(jobId);
      });
    }
    const owned = worker;
    try {
      return speechDetectionOutput.parse(
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            owned.off('message', done);
            owned.off('error', fail);
            owned.off('exit', exited);
            signal.removeEventListener('abort', abort);
          };
          const done = (result: any) => {
            cleanup();
            result.error ? reject(Error(result.error)) : resolve(result.value);
          };
          const fail = (error: Error) => {
            cleanup();
            reject(error);
          };
          const exited = () => fail(Error('Speech detector stopped before returning a result'));
          const abort = () => {
            fail(signal.reason);
            void this.release(jobId);
          };
          owned.once('message', done);
          owned.once('error', fail);
          owned.once('exit', exited);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else owned.postMessage(value);
        }),
      );
    } catch (error) {
      await this.release(jobId);
      throw error;
    }
  }
  async release(jobId: string) {
    const worker = this.workers.get(jobId);
    this.workers.delete(jobId);
    await worker?.terminate();
  }
  async close() {
    await Promise.all([...this.workers.keys()].map((id) => this.release(id)));
  }
}

/** Original-relative ranges; no concatenation or rewriting of the media timeline. */
export function speechRanges(
  probabilities: number[],
  duration: number,
  options = detectionOptions.parse({}),
) {
  const step = 512 / 16000,
    negative = Math.max(0.01, options.threshold - 0.15);
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined, quiet: number | undefined;
  for (let i = 0; i < probabilities.length; i++) {
    const time = i * step,
      p = probabilities[i];
    if (start === undefined) {
      if (p >= options.threshold) start = time;
      continue;
    }
    if (p >= negative) quiet = undefined;
    else {
      quiet ??= time;
      if (time + step - quiet >= options.minSilenceMs / 1000) {
        if (quiet - start >= options.minSpeechMs / 1000) ranges.push({ start, end: quiet });
        start = undefined;
        quiet = undefined;
      }
    }
  }
  if (start !== undefined && duration - start >= options.minSpeechMs / 1000)
    ranges.push({ start, end: duration });
  const padded: typeof ranges = [];
  for (const r of ranges) {
    const next = {
      start: Math.max(0, r.start - options.paddingMs / 1000),
      end: Math.min(duration, r.end + options.paddingMs / 1000),
    };
    const previous = padded.at(-1);
    if (previous && next.start <= previous.end) previous.end = next.end;
    else padded.push(next);
  }
  return {
    duration,
    speechSeconds: ranges.reduce((n, r) => n + r.end - r.start, 0),
    maxProbability: Math.max(0, ...probabilities),
    meanProbability: probabilities.reduce((n, p) => n + p, 0) / Math.max(1, probabilities.length),
    ranges: padded,
  };
}
