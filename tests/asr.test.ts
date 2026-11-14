import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { setup, temporary, until } from './helpers.ts';
import { SpeechRecognition, asrTask } from '../plugins/asr/index.ts';
import { parseAsrOutput } from '../plugins/asr/runtime.ts';
import { adapterSchema, modelProfileSchema } from '../packages/contracts/inference.ts';
import { defineManifest } from '../packages/kernel/registry.ts';
import { connectionForPurpose } from '../packages/contracts/model-services.ts';
import { pcm16, wave } from '../plugins/asr/audio.ts';
import { assessTranscription } from '../plugins/asr/quality.ts';
import { speechRanges } from '../plugins/asr/speech-detection.ts';
const ui = { kind: 'ui' as const, permissions: new Set(['*']) };

async function fixture(
  t: Parameters<typeof setup>[0],
  respond: (value: any, signal: AbortSignal) => Promise<any>,
  detect?: (duration: number) => any,
) {
  const app = await setup(t),
    root = await temporary(t);
  const commands: string[][] = [];
  const speech = new SpeechRecognition(
    app.project,
    app.store,
    app.files,
    app.router.inference,
    app.events,
    async (_root, _command, args, signal) => {
      signal.throwIfAborted();
      commands.push(args);
      if (args.includes('-show_format'))
        await writeFile(
          args[args.indexOf('-o') + 1],
          JSON.stringify({ format: { duration: '65' }, streams: [{ codec_type: 'audio' }] }),
        );
      else await writeFile(args.at(-1)!, wave(Buffer.alloc(Math.round(Number(args[args.indexOf('-t') + 1]) * 32000))));
    },
    undefined,
    { loaded: false, async release() {}, async close() {}, async detect(_id, value) {
      const duration = pcm16(Buffer.from(value.audio, 'base64')).length / 32000;
      return detect?.(duration) ?? { duration, speechSeconds: duration, maxProbability: 1, meanProbability: 1, ranges: [{ start: 0, end: duration }] };
    } },
  );
  app.plugins.plugins.set('asr', speech.plugin());
  app.plugins.add({
    manifest: defineManifest({
      id: 'asr-fixture',
      name: 'ASR fixture',
      description: 'Synthetic fixture',
      version: '1.0.0',
      dependencies: [],
      permissions: ['inference.contribute'],
    }),
    activate(ctx) {
      const descriptor = adapterSchema.parse({
        id: 'asr-fixture.local',
        engine: 'asr-fixture',
        label: 'ASR fixture',
        family: 'local-runtime',
        connectionSchema: z.toJSONSchema(z.object({})),
        modelSchema: z.toJSONSchema(z.object({})),
        connectionFields: [],
        modelFields: [],
        generation: [],
        embedding: [],
        transcription: ['audio'],
        transcriptionProvider: 'asr-fixture.transcribe',
      });
      ctx.capabilities.provide(
        'core.inference.adapters@1',
        descriptor.id,
        descriptor.label,
        () => descriptor,
      );
      ctx.capabilities.provide(
        'core.inference.transcribe@1',
        'asr-fixture.transcribe',
        'Synthetic transcription',
        respond,
      );
    },
  });
  await app.plugins.enable('asr');
  await app.plugins.enable('asr-fixture');
  await app.router.inference.saveConnection({
    id: 'speech',
    name: 'Synthetic',
    adapterId: 'asr-fixture.local',
    deployment: 'local',
    purposes: ['transcription'],
  });
  const profile = await app.router.inference.saveModel({
    id: 'speech',
    name: 'Synthetic ASR',
    model: 'synthetic',
    connectionId: 'speech',
    generation: { enabled: false, inputs: ['text'] },
    transcription: { enabled: true, inputs: ['audio'] },
  });
  await app.registry.call('routes.save', { [asrTask]: profile.id }, ui);
  return { app, root, commands, speech, profile };
}

test('speech model selection is purpose-scoped and not eligible for chat or embeddings', async (t) => {
  const { app, profile } = await fixture(t, async () => ({ text: 'Synthetic' }));
  const catalog = app.router.inference;
  assert(catalog.supports(profile, { operation: 'transcribe', inputs: ['audio'] }));
  assert(!catalog.eligibility(profile).conversation);
  assert(!catalog.supports(profile, { operation: 'embed', inputs: ['text'] }));
  const connection = catalog.connections().find((c) => c.id === 'speech')!,
    adapter = catalog.adapter(connection.adapterId);
  assert(connectionForPurpose(connection, adapter, [profile], 'transcription'));
  assert(!connectionForPurpose(connection, adapter, [profile], 'generation'));
  await assert.rejects(
    () =>
      catalog.saveModel({
        ...profile,
        transcription: undefined,
        embedding: { enabled: true, inputs: ['text'] },
      }),
    /输入模态/,
  );
  await app.plugins.disable('asr');
  assert(!(await catalog.kinds()).some((kind) => kind.capability === 'transcription'));
  assert.equal(
    app.capabilities.list('files.extract@2').filter((p) => p.state === 'active').length,
    0,
  );
  await app.knowledge.save('local', 'Still usable', 'Knowledge works without ASR.');
  await app.plugins.enable('asr');
  assert((await catalog.kinds()).some((kind) => kind.capability === 'transcription'));
});

test('large originals use scoped file references; failed transcription resumes only unfinished chunks', async (t) => {
  let count = 0,
    fail = true;
  const { app, root, commands } = await fixture(t, async (value) => {
    assert.equal(value.profile.id, 'speech');
    assert.equal(value.language, '');
    if (++count === 2 && fail) throw Error('Synthetic interruption');
    return { text: `Searchable transcription ${count}` };
  });
  const source = join(root, 'Lecture.mp4');
  await writeFile(source, Buffer.alloc(17_000_000, 1));
  const job = await app.knowledge.queueImport(
    'local',
    source,
    'speech-import',
    undefined,
    'Lectures',
  );
  assert.equal(job.parserProvider, 'asr.media');
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'failed');
  assert.equal(app.store.document<any>('asr-jobs', job.id).completed, 1);
  assert.equal((await app.knowledge.list('local')).length, 0);
  const progress = (await app.registry.call('knowledge.jobs', {}, ui)).find(
    (j: any) => j.id === job.id,
  ).progress;
  assert.deepEqual(progress, { completed: 1, total: 3, unit: 'segments' });
  fail = false;
  await app.registry.call('knowledge.resume', { id: job.id }, ui);
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'completed');
  assert.equal(count, 4);
  const doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  assert.match(doc.content, /Searchable transcription 1/);
  assert.match(doc.content, /00:01:00–00:01:05/);
  assert.match(doc.content, /echo-asset:[a-f0-9]{64}#t=30/);
  assert.equal((doc.original as any)?.hash, job.original.hash);
  assert.equal(doc.logicalPath, `Lectures/${job.documentId}.md`);
  assert.equal(
    (
      await app.knowledge.search('Searchable', new AbortController().signal, 10, {
        vaultId: 'local',
      })
    )[0].documentId,
    job.documentId,
  );
  assert(
    commands.every((args) => args.includes('-protocol_whitelist') && args.includes('file,pipe')),
  );
  const chunkStarts = commands
    .filter((args) => args.includes('-ss'))
    .map((args) => args[args.indexOf('-ss') + 1]);
  assert.deepEqual(chunkStarts, ['0', '30', '30', '60']);
});

test('pause cancels inference; plugin reload retains the checkpoint without publishing partial text', async (t) => {
  let count = 0,
    block = true;
  const { app, root } = await fixture(t, async (_value, signal) => {
    if (++count === 2 && block)
      await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    return { text: `Chunk ${count}` };
  });
  const source = join(root, 'Audio.wav');
  await writeFile(source, 'synthetic source');
  const job = await app.knowledge.queueImport('local', source, 'speech-pause');
  await until(() => count === 2);
  await app.registry.call('knowledge.pause', { id: job.id }, ui);
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'paused');
  assert.equal(app.store.document<any>('asr-jobs', job.id).completed, 1);
  assert.equal((await app.knowledge.list('local')).length, 0);
  await app.plugins.disable('asr');
  await app.plugins.enable('asr');
  block = false;
  await app.registry.call('knowledge.resume', { id: job.id }, ui);
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'completed');
  assert.equal(count, 4);
});

test('ASR protocol markers are parsed without treating transcription text as instructions', () => {
  assert.deepEqual(parseAsrOutput('language Chinese<asr_text>你好。<|im_end|>'), {
    language: 'Chinese',
    text: '你好。',
  });
  assert.deepEqual(parseAsrOutput('Plain transcript.'), { text: 'Plain transcript.' });
  assert.throws(() => parseAsrOutput({ text: 'invalid' }));
  assert.equal(
    modelProfileSchema.parse({ id: 'legacy', name: 'Legacy', connectionId: 'legacy' })
      .transcription,
    undefined,
  );
});

test('continuation freezes ASR settings; explicit reparse creates a new generation with new defaults', async (t) => {
  let calls = 0;
  const { app, root } = await fixture(t, async (value) => {
    if (++calls === 2) throw Error('Synthetic failure');
    return { text: value.language ? 'New configuration only.' : 'Old configuration only.' };
  });
  const source = join(root, 'Changed.wav');
  await writeFile(source, 'synthetic source');
  const job = await app.knowledge.queueImport('local', source, 'changed-asr-settings');
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'failed');
  assert.equal(app.store.document<any>('asr-jobs', job.id).completed, 1);
  app.store.set('asr.config', { language: 'English' });
  await app.registry.call('knowledge.resume', { id: job.id }, ui);
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'completed');
  assert.equal(calls, 4);
  let doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  assert.match(doc.content, /Old configuration only/);
  assert.doesNotMatch(doc.content, /New configuration only/);
  const next = await app.knowledge.reparse({
    vaultId: 'local',
    id: doc.id,
    revision: doc.revision,
    requestId: 'explicit-new-config',
  });
  await until(() => app.store.document<any>('knowledge-jobs', next.id)?.state === 'completed');
  doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  assert.equal(calls, 7);
  assert.match(doc.content, /New configuration only/);
  assert.doesNotMatch(doc.content, /Old configuration only/);
  assert.equal(doc.segments.length, 3);
});

test('a changed archived original is rejected before resuming inference or publishing knowledge', async (t) => {
  let calls = 0;
  const { app, root } = await fixture(t, async () => {
    if (++calls === 2) throw Error('Synthetic failure');
    return { text: 'Original audio.' };
  });
  const source = join(root, 'Original.wav');
  await writeFile(source, 'synthetic source');
  const job = await app.knowledge.queueImport('local', source, 'changed-asr-source');
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'failed');
  await writeFile(await app.files.path('local', job.original.relativePath), 'tampered original');
  await app.registry.call('knowledge.resume', { id: job.id }, ui);
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'failed');
  assert.match(app.store.document<any>('knowledge-jobs', job.id).error, /原件已变化/);
  assert.equal(calls, 2);
  assert.equal((await app.knowledge.list('local')).length, 0);
});


test('plugin forms show effective ASR defaults without migrating or overwriting saved settings',async t=>{
  const app=await setup(t,['asr']);
  app.store.set('asr.config',{ffmpeg:'synthetic-ffmpeg'});
  const before=app.store.get('asr.config',{});
  const bootstrap=await app.registry.call('system.bootstrap',{},ui);
  assert.equal(bootstrap.pluginSettings.asr.chunkSeconds,30);
  assert.equal(bootstrap.pluginSettings.asr.ffmpeg,'synthetic-ffmpeg');
  assert.deepEqual(app.store.get('asr.config',{}),before);
});

test('no-speech completes normally without decoding words and keeps the original', async t => {
  let calls = 0;
  const { app, root, speech } = await fixture(t, async () => { calls++; return { text: 'Must not be generated' }; }, duration => ({ duration, speechSeconds: 0, maxProbability: 0.02, meanProbability: 0.001, ranges: [] }));
  const source = join(root, 'Music.mp4'); await writeFile(source, 'synthetic music original');
  const job = await app.knowledge.queueImport('local', source, 'music-only');
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'completed');
  const doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  assert.equal(calls, 0); assert.equal(doc.content, ''); assert.equal(doc.assessment.state, 'empty');
  assert.equal(doc.assessment.reason, 'no_speech'); assert(doc.segments.every((s: any) => s.text === ''));
  assert.equal(doc.original?.hash, job.original.hash); assert.equal(speech.detector.loaded, false);
  const graph = await app.knowledge.pipeline.graph('local', doc.id);
  assert(!graph.nodes.some((n: any) => n.kind === 'text'));
});

test('suspect transcripts stay in the job receipt, not in published text, parents or search', async t => {
  const candidate = 'Unreliable secret phrase';
  const { app, root } = await fixture(t, async () => ({ text: candidate, language: 'None' }));
  const source = join(root, 'Uncertain.mp4'); await writeFile(source, 'synthetic uncertain original');
  const job = await app.knowledge.queueImport('local', source, 'uncertain-asr');
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'completed');
  const doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  assert.equal(doc.assessment.state, 'needs_review'); assert.equal(doc.content, '');
  assert(!JSON.stringify(doc.segments).includes(candidate));
  assert(app.store.document<any>('asr-jobs', job.id).segments.every((s: any) => s.candidateText === candidate));
  assert.equal((await app.knowledge.search(candidate, new AbortController().signal, 10, { vaultId: 'local' })).length, 0);
  const graph = await app.knowledge.pipeline.graph('local', doc.id);
  assert(!JSON.stringify(graph.nodes).includes(candidate));
});

test('speech intervals preserve original timestamps and do not index silent gaps', async t => {
  const { app, root } = await fixture(t, async () => ({ text: 'Confirmed speech', language: 'English' }), duration => ({ duration, speechSeconds: 1, maxProbability: 0.99, meanProbability: 0.4, ranges: [{ start: 2, end: 3 }] }));
  const source = join(root, 'Sparse.mp4'); await writeFile(source, 'synthetic speech');
  const job = await app.knowledge.queueImport('local', source, 'sparse-speech');
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'completed');
  const doc = await app.knowledge.read(job.documentId, 0, 12000, 'local');
  assert.deepEqual(doc.segments.map((s: any) => [s.start,s.end]), [[2,3],[32,33],[62,63]]);
  assert.equal(doc.assessment.state, 'accepted');
});

test('speech detection uses hysteresis and padding without treating energy or language as proof', () => {
  assert.deepEqual(speechRanges(Array(100).fill(0.02), 3.2).ranges, []);
  const found = speechRanges([...Array(10).fill(0), ...Array(30).fill(0.95), ...Array(40).fill(0)], 2.56);
  assert.equal(found.ranges.length, 1); assert(found.ranges[0].start < 0.32); assert(found.ranges[0].end < 2.56);
  assert.equal(assessTranscription({ text: 'Valid Spanish speech.', language: 'Spanish' }, 3).state, 'accepted');
  assert.equal(assessTranscription({ text: 'abc'.repeat(40) }, 10).state, 'needs_review');
  assert.equal(assessTranscription({ text: '' }, 3).state, 'needs_review');
});

test('failed speech detection cannot silently bypass filtering or replace an existing entry', async t => {
  let calls = 0;
  const { app, root } = await fixture(t, async () => { calls++; return { text: 'Unexpected transcription' }; }, () => { throw Error('Synthetic detector unavailable'); });
  const source = join(root, 'Existing.mp4'); await writeFile(source, 'synthetic original');
  const original = await app.files.import('local', source);
  const before = await app.knowledge.save('local', 'Existing', 'Previously trusted text', { sourceFileId: original.id, sourceHash: original.hash });
  const job = await app.knowledge.reparse({ vaultId: 'local', id: before.id, revision: before.revision, requestId: 'detector-failure' });
  await until(() => app.store.document<any>('knowledge-jobs', job.id)?.state === 'failed');
  const after = await app.knowledge.read(before.id, 0, 12000, 'local');
  assert.equal(after.content, 'Previously trusted text'); assert.equal(after.version, before.version); assert.equal(calls, 0);
});
