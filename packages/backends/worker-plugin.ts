import type { Backend } from '../contracts/index.ts';
import { defineManifest, type Plugin } from '../kernel/registry.ts';
import type { Router } from '../kernel/router.ts';
import { registerInferenceAdapters } from './catalog.ts';

/** Owns the host process, adapter registration and all in-flight host calls. */
export function workerPlugin(manifest: unknown, router: Router, create: () => Backend): Plugin {
  return { manifest: defineManifest(manifest), activate(ctx) {
    const backend = create();
    const generate = backend.generate.bind(backend);
    backend.generate = (request) => generate({ ...request,
      signal: AbortSignal.any([request.signal, ctx.signal]) });
    router.backends.set(backend.kind, backend);
    ctx.dispose(async () => {
      if (router.backends.get(backend.kind) === backend) router.backends.delete(backend.kind);
      await backend.close?.();
    });
    registerInferenceAdapters(ctx.capabilities, router.backends, [backend.kind], manifestId());
  } };
  function manifestId() { return defineManifest(manifest).id; }
}
