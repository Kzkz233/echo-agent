import type { AdapterDescriptor, Connection, ModelProfile } from './inference.ts';
export type ModelPurpose = 'generation' | 'embedding' | 'reranking' | 'transcription';
/** Adapter type owns execution classification; deployment only locates API services. */
export function connectionDeployment(connection: Connection, adapter?: Pick<AdapterDescriptor, 'family'>): Connection['deployment'] {
  if (adapter?.family === 'harness') return 'harness';
  if (adapter?.family === 'local-runtime') return 'local';
  if (adapter?.family === 'api' && connection.deployment === 'harness') {
    try {
      if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(String(connection.config.endpoint)).hostname)) return 'local';
    } catch {}
    return 'cloud';
  }
  return connection.deployment;
}
export function modelDisplayName(model: { name?: string; model?: string }) {
  if (model.name && !['New model', '新的模型'].includes(model.name)) return model.name;
  return model.model?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || model.name || '';
}
/** Connection identity can be shared, while each model page remains purpose-scoped. */
export function connectionForPurpose(
  connection: Connection,
  adapter: AdapterDescriptor,
  models: ModelProfile[],
  purpose: ModelPurpose,
) {
  if (purpose !== 'generation' && connection.config.protocol === 'anthropic-messages') return false;
  const owned = models.filter((model) => model.connectionId === connection.id);
  if (owned.some((model) => model[purpose]?.enabled)) return true;
  if (connection.purposes) return connection.purposes.includes(purpose);
  if (owned.length) return false;
  const legacyDefault = adapter.generation.length
    ? 'generation'
    : adapter.embedding.length
      ? 'embedding'
      : adapter.transcription?.length
        ? 'transcription'
        : 'reranking';
  return purpose === legacyDefault;
}
