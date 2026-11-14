import { z } from 'zod';
import type { Capabilities } from './capabilities.ts';
import type { Registry } from './registry.ts';
import { invariant } from '../contracts/index.ts';
const point = 'core.cli.commands@1';
const descriptor = z.object({
  id: z.string(),
  label: z.string(),
  operation: z.string(),
  permission: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export class CliCatalog {
  constructor(
    readonly core: ReturnType<Capabilities['forOwner']>,
    readonly registry: Registry,
  ) {
    core.define({
      id: point,
      description: 'Plugin-owned CLI commands backed by registered operations',
      input: z.object({}),
      output: z.array(descriptor),
      providePermission: 'automation.contribute',
      consumePermission: 'system.read',
    });
  }
  async list() {
    const groups = await Promise.all(
      this.core
        .list(point)
        .filter((p) => p.state === 'active')
        .map(async (p) => {
          const commands = (await this.core.invoke(point, p.id, {})) as z.infer<
            typeof descriptor
          >[];
          for (const c of commands)
            invariant(
              c.id.startsWith(p.owner + '.') && c.operation.startsWith(p.owner + '.'),
              'cli_namespace',
              'CLI 命令必须属于提供插件',
            );
          return commands;
        }),
    );
    const result = groups.flat();
    invariant(
      new Set(result.map((c) => c.id)).size === result.length,
      'cli_duplicate',
      'CLI 命令重复',
    );
    return result;
  }
  async call(id: string, input: unknown) {
    const command = (await this.list()).find((c) => c.id === id);
    invariant(command, 'cli_command', '插件命令不可用');
    return this.registry.call(
      command.operation,
      z.fromJSONSchema(command.inputSchema as any).parse(input),
      { kind: 'cli', permissions: new Set([command.permission]) },
    );
  }
}
