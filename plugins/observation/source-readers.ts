import { z } from 'zod';
import type { PluginContext } from '../../packages/kernel/registry.ts';
import { browserAllowRuleSchema } from '../../packages/contracts/index.ts';

export const sourceReaderPoint = 'observation.source-readers@1';
export const sourceReaderSchema = z.object({
  label: z.string().min(1).max(100),
  kind: z.enum(['browser', 'application']),
  // Declarative readers execute locally before and after capture. Registration
  // does not grant permission to observe any process, domain or document.
  strategy: z.enum(['uia-document', 'process-window']),
  presets: z.array(browserAllowRuleSchema.omit({ readerId: true })).max(32).default([]),
});
export function defineSourceReaders(ctx: PluginContext) {
  ctx.capabilities.define({ id: sourceReaderPoint, description: 'Local source readers and editable process presets',
    input: z.object({}), output: sourceReaderSchema, providePermission: 'observation.source.provide',
    consumePermission: 'observation.source.read', cardinality: 'many' });
}
export function contributeSourceReader(ctx: PluginContext, id: string,
  descriptor: z.input<typeof sourceReaderSchema>) {
  const parsed = sourceReaderSchema.parse(descriptor);
  return ctx.capabilities.provide(sourceReaderPoint, id, parsed.label, () => parsed);
}
