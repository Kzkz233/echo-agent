/** Synthetic test setup; production configuration uses connections.save / profiles.save. */
import { z } from 'zod';
import type { Application } from '../apps/server/application.ts';
import { profileSchema, type Profile } from '../packages/contracts/index.ts';
import {
  connectionSchema,
  modelProfileSchema,
  inferenceTasks,
} from '../packages/contracts/inference.ts';
export function seedProfile(app: Application, raw: Profile) {
  const p = profileSchema.parse(raw),
    adapterId = p.kind === 'onnx' ? 'local-models.onnx' :
      ['codex', 'dsh'].includes(p.kind) ? `worker-${p.kind}.provider` : 'core.' + p.kind,
    adapter = app.router.inference.adapter(adapterId);
  const connection = connectionSchema.parse({
    id: p.connectionId ?? p.id,
    name: p.name,
    adapterId,
    deployment: p.kind === 'onnx' ? 'local' : p.kind === 'api' ? 'local' : 'harness',
    config: z.fromJSONSchema(adapter.connectionSchema as any).parse(
      Object.fromEntries(
        Object.entries({
          endpoint: p.endpoint,
          apiKeyRef: p.apiKeyRef,
          ...(['api', 'onnx'].includes(p.kind) ? {} : { provider: p.provider }),
          ...(p.kind === 'dsh' ? { api: p.api } : {}),
          ...(['api', 'pi'].includes(p.kind) ? { protocol: p.protocol } : {}),
          ...(['codex', 'dsh'].includes(p.kind)
            ? { command: p.command, args: p.args, cwd: p.cwd }
            : {}),
        }).filter(([key]) => key in ((adapter.connectionSchema as any).properties ?? {})),
      ),
    ),
  });
  const model = modelProfileSchema.parse({
    id: p.id,
    name: p.name,
    model: p.model,
    connectionId: connection.id,
    generation: { enabled: p.kind !== 'onnx', inputs: p.vision ? ['text', 'image'] : ['text'] },
    embedding: { enabled: ['api', 'onnx'].includes(p.kind), inputs: ['text'] },
    reasoning: p.reasoning,
    reasoningStyle: p.reasoningStyle,
    maxOutputTokens: p.maxOutputTokens,
    contextChars: p.contextChars,
    timeoutMs: p.timeoutMs,
    options: z.fromJSONSchema(adapter.modelSchema as any).parse(p.modelOptions),
  });
  app.store.put('connections', connection.id, connection);
  app.store.put('profiles', model.id, model);
  return model;
}
export function seedRoutes(app: Application, routes: Record<string, string>) {
  app.store.set(
    'routes',
    Object.fromEntries(
      Object.entries(routes).flatMap(([task, id]) =>
        task === 'query'
          ? [
              [inferenceTasks.query, id],
              [inferenceTasks.semanticQuery, id],
            ]
          : [[inferenceTasks[task as keyof typeof inferenceTasks] ?? task, id]],
      ),
    ),
  );
}
