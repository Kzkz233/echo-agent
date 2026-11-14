import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import model from '../../resources/models/silero-vad/manifest.json' with { type: 'json' };
import { speechDetectionInput, speechRanges } from './speech-detection.ts';
import { pcm16 } from './audio.ts';

let session: any, ort: any;
parentPort!.on('message', async (input) => {
  try {
    const value = speechDetectionInput.parse(input);
    const wav = Buffer.from(value.audio, 'base64');
    const pcm = pcm16(wav);
    if (!session) {
      const file = [
        join(workerData.root, 'models/silero-vad', model.file),
        join(workerData.root, 'dist/vendor/models/silero-vad', model.file),
      ].find(existsSync);
      if (!file) throw Error('Bundled Silero speech detector is missing; repair the installation');
      const bytes = await readFile(file);
      if (
        bytes.length !== model.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== model.sha256
      )
        throw Error('Speech detector checksum mismatch');
      const packageName = 'onnxruntime-node';
      ort = await import(packageName);
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['cpu'],
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        enableCpuMemArena: false,
      });
    }
    let state = new Float32Array(2 * 128),
      context = new Float32Array(64);
    const probabilities: number[] = [],
      samples = pcm.length / 2;
    for (let at = 0; at < samples; at += 512) {
      const frame = new Float32Array(576);
      frame.set(context);
      for (let n = 0; n < 512 && at + n < samples; n++)
        frame[64 + n] = pcm.readInt16LE((at + n) * 2) / 32768;
      const result = await session.run({
        input: new ort.Tensor('float32', frame, [1, 576]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
      });
      probabilities.push(Number(result.output.data[0]));
      state = new Float32Array(result.stateN.data);
      context = frame.slice(-64);
    }
    parentPort!.postMessage({ value: speechRanges(probabilities, samples / 16000, value.options) });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
});
