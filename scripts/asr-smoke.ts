import { Application } from '../apps/server/application.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { asrTask } from '../plugins/asr/index.ts';

// Explicit local paths only. Uses an isolated library and never contacts a model API.
const [command, model, projector, ffmpeg, audio, output] = process.argv.slice(2);
if (![command, model, projector, ffmpeg, audio, output].every(Boolean))
  throw Error('Expected runtime, model, encoder, ffmpeg, audio and result path');
await mkdir(dirname(resolve(output)), { recursive: true });
const runtime = await mkdtemp(join(dirname(resolve(output)), 'asr-smoke-'));
const app = await Application.create({
  project: resolve(import.meta.dirname, '..'),
  runtime,
  plugins: ['asr'],
});
const started = performance.now();
try {
  await app.router.inference.saveConnection({
    id: 'speech',
    name: 'Local ASR',
    adapterId: 'asr.llama',
    deployment: 'local',
    purposes: ['transcription'],
    config: { command: resolve(command) },
  });
  await app.router.inference.saveModel({
    id: 'speech',
    name: 'Qwen3-ASR 1.7B Q8',
    model: resolve(model),
    connectionId: 'speech',
    generation: { enabled: false, inputs: ['text'] },
    transcription: { enabled: true, inputs: ['audio'] },
    options: { projector: resolve(projector), device: 'gpu', threads: 4 },
    timeoutMs: 300000,
  });
  app.store.set('routes', { [asrTask]: 'speech' });
  app.store.set('asr.config', { ffmpeg: resolve(ffmpeg), chunkSeconds: 30 });
  const job = await app.knowledge.queueImport(
    'local',
    resolve(audio),
    'real-asr-smoke',
    undefined,
    'Audio',
  );
  const deadline = Date.now() + 360000;
  let result: any;
  do {
    result = app.store.document<any>('knowledge-jobs', job.id);
    if (['completed', 'failed', 'paused'].includes(result?.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  if (result?.state !== 'completed') throw Error(result?.error ?? 'ASR did not finish');
  const doc = await app.knowledge.read(job.documentId, 0, 16000, 'local');
  const text = doc.content;
  if (!text || text.includes('<asr_text>') || text.includes('language Chinese'))
    throw Error('ASR protocol markers leaked');
  const transcript = app.store.document<any>('asr-jobs', job.id);
  const status = await app.registry.call(
    'asr.status',
    {},
    { kind: 'ui', permissions: new Set(['*']) },
  );
  const report = {
    state: result.state,
    elapsedSeconds: (performance.now() - started) / 1000,
    completed: transcript.completed,
    total: transcript.total,
    loadedAfterCompletion: status.loaded,
    text,
    sourceAttached: Boolean(doc.sourceFileId),
    folder: doc.logicalPath,
    paidCalls: 0,
  };
  await writeFile(resolve(output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await rm(runtime, { recursive: true, force: true });
}
