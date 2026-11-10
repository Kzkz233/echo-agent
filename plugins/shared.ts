import { z } from 'zod';
import type { PluginContext, Caller } from '../packages/kernel/registry.ts';
export function operations(ctx: PluginContext, owner: string) {
  return (
    name: string,
    description: string,
    input: z.ZodType,
    permission: string,
    run: (v: any, signal: AbortSignal, caller: Caller) => unknown | Promise<unknown>,
    mcp = true,
  ) =>
    ctx.registry.register({
      name: owner + '.' + name,
      owner,
      description,
      input,
      output: z.unknown(),
      permission,
      mcp,
      run: (v, c, s) => run(v, s, c),
    });
}
