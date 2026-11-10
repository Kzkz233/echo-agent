import type { Application } from './application.ts';
import { inferenceTasks } from '../../packages/contracts/inference.ts';

/** Register the offline model without replacing a user's shared embedding space. */
export async function ensureStarterModels(app: Application, languageModel: string) {
  const catalog = app.router.inference;
  await catalog.refresh();
  let model = catalog
    .models()
    .find(
      (m) =>
        m.model === 'Xenova/bge-small-zh-v1.5' &&
        m.embedding.enabled &&
        catalog
          .connections()
          .some((c) => c.id === m.connectionId && c.adapterId === 'local-models.onnx'),
    );
  if (!model) {
    const connectionId = 'echo-bundled-onnx',
      id = 'echo-bge-small-zh';
    if (!catalog.connections().some((c) => c.id === connectionId))
      await catalog.saveConnection({
        id: connectionId,
        name: 'Local ONNX',
        adapterId: 'local-models.onnx',
        deployment: 'local',
        config: {},
      });
    if (catalog.models().some((m) => m.id === id))
      throw Error('Bundled model identifier is already in use.');
    model = await catalog.saveModel({
      id,
      name: 'BGE Small · 中文',
      connectionId,
      model: 'Xenova/bge-small-zh-v1.5',
      generation: { enabled: false, inputs: ['text'] },
      embedding: { enabled: true, inputs: ['text'], dimensions: 512 },
      options: { weightsFile: 'model_quantized.onnx', promptStyle: 'bge-zh', allowDownload: false },
    });
  }
  const routes = app.store.get<Record<string, string>>('routes', {});
  const next = { ...routes };
  next[inferenceTasks.embedding] ??= model.id;
  next[inferenceTasks.semanticQuery] ??= languageModel;
  next[inferenceTasks.rerankLanguage] ??= languageModel;
  if (JSON.stringify(next) !== JSON.stringify(routes)) app.store.set('routes', next);
  return model.id;
}
