import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../apps/server/application.ts';

// Explicit local codec acceptance: no model loading, credentials or network calls.
const ffmpeg = process.env.ECHO_TEST_FFMPEG;
if (!ffmpeg) throw Error('Set ECHO_TEST_FFMPEG to an explicitly configured FFmpeg executable.');
const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const fixture = await mkdtemp(join(base, 'ingestion-media-'));
const app = await Application.create({
  runtime: join(fixture, 'data'),
  project: resolve(import.meta.dirname, '..'),
  plugins: ['asr'],
});
try {
  app.store.set('asr.config', { ffmpeg });
  const source = join(fixture, 'sample.mp4');
  await promisify(execFile)(
    ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=640x360:r=10:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-shortest',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-c:a',
      'aac',
      '-y',
      source,
    ],
    { windowsHide: true },
  );
  const vault = await app.files.register({
    id: 'fixture',
    name: 'Fixture',
    path: join(fixture, 'Library'),
  });
  const original = await app.files.import(vault.id, source);
  const parser = (await app.files.parsers.list()).find((p) => p.id.startsWith('asr.'))!;
  assert(parser);
  const doc = await app.knowledge.save(vault.id, 'Codec fixture', '# Clip\n\nA synthetic tone.', {
    sourceFileId: original.id,
    sourceHash: original.hash,
    parsed: {
      jobId: 'synthetic-transcript',
      plan: { format: 'echo-parse-plan-v1', parser, options: {}, provenance: {} },
      segments: [{ start: 0, end: 2, text: 'A synthetic tone.' }],
    },
  });
  const graph = await app.knowledge.pipeline.graph(vault.id, doc.id);
  const text = graph.nodes.find((n: any) => n.kind === 'text')!;
  for (const modality of ['audio', 'video'] as const) {
    const node = graph.nodes.find((n: any) => n.kind === modality)!;
    assert.equal(node.parentId, text.parentId);
    const plan = await app.files.parsers.freezeMedia(modality);
    const part = await app.files.parsers.encodeMedia(
      { vaultId: vault.id, sourceHash: original.hash, modality, start: node.start, end: node.end },
      new AbortController().signal,
      plan,
    );
    assert.equal(part.type, modality);
    const bytes = Buffer.from((part as any).data, 'base64');
    assert(bytes.length > 100 && bytes.length < 12_000_000);
    if (modality === 'audio') assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    else assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
  }
  assert.equal((await app.knowledge.pipeline.graph(vault.id, doc.id)).reused, true);
  console.log(
    'Real FFmpeg audio/video preparation, shared evidence parents and graph reuse passed. No inference was used.',
  );
} finally {
  await app.close();
  if (!resolve(fixture).startsWith(resolve(base) + sep)) throw Error('Unsafe fixture cleanup');
  await rm(fixture, { recursive: true, force: true });
}
