import { inferenceTasks } from '../packages/contracts/inference.ts';
import { Application } from '../apps/server/application.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const runtime =
  process.env.ECHO_EMBED_TEST_DIR ??
  join(process.env.LOCALAPPDATA ?? '.', 'EchoDev', 'embedding-verification');
const project = resolve(import.meta.dirname, '..');
await mkdir(runtime, { recursive: true });
const app = await Application.create({
  runtime,
  project: process.env.ECHO_EMBED_PROJECT ?? project,
  plugins: ['knowledge', 'persona', 'memory', 'semantic', 'local-models'],
});
app.store.set('memory.config', { planner: false });
await app.router.inference.saveConnection({
  id: 'local-embedding',
  name: 'Local embedding fixture',
  adapterId: 'local-models.onnx',
  deployment: 'local',
  config: {},
});
await app.router.inference.saveModel({
  id: 'embedding-fixture',
  connectionId: 'local-embedding',
  name: 'Embedding fixture',
  model: process.env.ECHO_EMBED_MODEL ?? 'Xenova/bge-small-zh-v1.5',
  generation: { enabled: false, inputs: ['text'] },
  embedding: { enabled: true, inputs: ['text'] },
  options: {
    weightsFile: 'model_quantized.onnx',
    allowDownload: process.env.ECHO_ALLOW_MODEL_DOWNLOAD === '1',
    downloadBaseUrl: process.env.ECHO_MODEL_DOWNLOAD_BASE ?? 'https://huggingface.co/',
  },
});
app.store.set('routes', { [inferenceTasks.embedding]: 'embedding-fixture' });
app.store.set('semantic.config', { threshold: 0.45 });
const examples = [
  ['pet', '宠物', '使用者有一只叫云朵的白色小猫，喜欢晒太阳。'],
  ['food', '饮食', '使用者不吃香菜，喜欢清淡口味。'],
  ['game', '游戏', '使用者喜欢探索型开放世界游戏，周末常与朋友联机。'],
  ['work', '工作', '使用者是一位研究人员，正在整理显微成像数据。'],
  ['sleep', '作息', '使用者希望晚上十一点后减少打扰。'],
  ['music', '音乐', '使用者喜欢钢琴与轻音乐。'],
  ['trip', '出行', '使用者计划下个月去海边旅行。'],
  ['book', '阅读', '使用者喜欢阅读科幻小说。'],
];
for (const [id, title, text] of examples)
  await app.memories.save({
    id,
    personaId: 'companion',
    title,
    text,
    core: false,
    tags: [],
    sources: [],
  });
const cases = [
  ['那只猫叫什么名字', 'pet'],
  ['晚餐要避开什么调料', 'food'],
  ['周末想和朋友一起玩什么', 'game'],
  ['实验图像数据该继续整理了', 'work'],
  ['现在深夜要不要主动打扰', 'sleep'],
  ['放点什么曲子适合安静听', 'music'],
  ['下个月旅行打算去哪', 'trip'],
  ['推荐读哪类小说', 'book'],
  ['火星大气压强的精确测量数值是多少', ''],
  ['如何计算不锈钢的剪切应力', ''],
];
const started = Date.now();
let top1 = 0,
  top3 = 0;
const results = [];
try {
  for (const [query, expected] of cases) {
    const matches = await app.memories.recall('companion', query, [], new AbortController().signal);
    if (expected && matches[0]?.memory.id === expected) top1++;
    if (expected && matches.some((m) => m.memory.id === expected)) top3++;
    results.push({
      query,
      expected,
      matches: matches.map((m) => ({ id: m.memory.id, score: m.score, method: m.method })),
    });
  }
  if (
    Boolean(app.store.get('memory.lastRetrievalIssue', null)) ||
    results.every((r) => !r.matches.length)
  )
    throw Error(JSON.stringify(app.store.get('semantic.lastIssue', {})));
  const report = {
    model: app.router.route(inferenceTasks.embedding).model,
    offline: !app.router.route(inferenceTasks.embedding).modelOptions.allowDownload,
    positiveCases: cases.filter((c) => c[1]).length,
    negativeCases: cases.filter((c) => !c[1]).length,
    negativeEmpty: results.filter((r) => !r.expected && !r.matches.length).length,
    top1,
    top3,
    durationMs: Date.now() - started,
    paidCalls: 0,
    results,
  };
  await writeFile(
    join(project, 'test-results', 'embedding-quality.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
