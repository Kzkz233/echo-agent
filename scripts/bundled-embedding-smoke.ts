import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../apps/server/application.ts';
import { cosine } from '../packages/kernel/retrieval.ts';

const base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'bundled-embedding-'));
const project = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'));
const app = await Application.create({ runtime, project, plugins: ['local-models'] });
try {
  await app.router.inference.saveConnection({
    id: 'fixture',
    name: 'Offline fixture',
    adapterId: 'local-models.onnx',
    deployment: 'local',
    config: {},
  });
  await app.router.inference.saveModel({
    id: 'fixture',
    connectionId: 'fixture',
    name: 'Offline fixture',
    model: 'Xenova/bge-small-zh-v1.5',
    generation: { enabled: false, inputs: ['text'] },
    embedding: { enabled: true, inputs: ['text'], dimensions: 512 },
    options: { weightsFile: 'model_quantized.onnx', allowDownload: false, promptStyle: 'bge-zh' },
  });
  const signal = new AbortController().signal;
  const encode = (texts: string[], purpose: 'query' | 'document') =>
    app.embeddings.encode(
      'fixture',
      texts.map((text) => ({ content: [{ type: 'text' as const, text }] })),
      purpose,
      signal,
    );
  const started = performance.now();
  const docs = await encode(
    ['使用者不吃香菜，喜欢清淡口味。', '使用者喜欢弹钢琴和听音乐。'],
    'document',
  );
  const queries = await encode(['准备晚饭要避开什么食材？', '有什么适合安静听的曲子？'], 'query');
  assert(docs.every((v) => v.length === 512 && v.every(Number.isFinite)));
  assert(cosine(queries[0], docs[0]) > cosine(queries[0], docs[1]));
  assert(cosine(queries[1], docs[1]) > cosine(queries[1], docs[0]));
  assert.equal(
    (await readdir(join(runtime, 'models')).catch(() => [])).length,
    0,
    'Bundled weights must work without populating or downloading into the data cache',
  );
  console.log(
    JSON.stringify({
      offline: true,
      dimensions: 512,
      semanticPairs: 2,
      correct: 2,
      privateCacheUsed: false,
      paidCalls: 0,
      durationMs: Math.round(performance.now() - started),
    }),
  );
} finally {
  await app.close();
  assert(resolve(runtime).startsWith(resolve(base) + sep));
  await rm(runtime, { recursive: true, force: true });
}
