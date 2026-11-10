import { z } from 'zod';
import { Capabilities, type CapabilityOwner } from './capabilities.ts';
export type Material = {
  id: string;
  personaId: string;
  text: string;
  timestamp: string;
  conversationId?: string;
  seq?: number;
  sourceId?: string;
  streamId?: string;
};
export function materialWatermarkKey(
  sourceId: string,
  personaId: string,
  streamId?: string,
  taskId?: string,
) {
  if (taskId)
    return 'review.taskWatermark.' + JSON.stringify([taskId, sourceId, personaId, streamId ?? '']);
  return streamId
    ? 'review.streamWatermark.' + JSON.stringify([sourceId, personaId, streamId])
    : `review.sourceWatermark.${sourceId}.${personaId}`;
}
type Stream = { id: string; personaId: string; label: string };
export type MaterialSource = {
  id: string;
  label?: string;
  read: (personaId: string, streams?: string[]) => Promise<Material[]>;
  streams?: () => Stream[];
  archive?: (beforeDay: string, personaId?: string) => Promise<unknown>;
};
const materialSchema = z.object({
  id: z.string().min(1).max(512),
  personaId: z.string().min(1).max(160),
  text: z.string().max(16000000),
  timestamp: z.iso.datetime(),
  conversationId: z.string().optional(),
  seq: z.number().optional(),
  sourceId: z.string().optional(),
  streamId: z.string().min(1).max(160).optional(),
});
type Scope = ReturnType<Capabilities['forOwner']>;
export class MaterialSources {
  constructor(readonly capabilities = new Capabilities()) {}
  define(scope: Scope) {
    scope.define({
      id: 'review.materials@1',
      description: 'Review 可选材料来源',
      input: z.object({ personaId: z.string(), streams: z.array(z.string()).max(100).optional() }),
      output: z.array(materialSchema),
      providePermission: 'review.contribute',
      consumePermission: 'review.read',
      cardinality: 'many',
    });
    scope.define({
      id: 'review.archives@1',
      description: '原文归档提供方',
      input: z.object({ beforeDay: z.iso.date(), personaId: z.string().optional() }),
      output: z.unknown(),
      providePermission: 'review.contribute',
      consumePermission: 'review.write',
      cardinality: 'many',
    });
    scope.define({
      id: 'review.material-streams@1',
      description: '材料提供方可选的角色内子来源',
      input: z.object({}),
      output: z.array(z.object({ id: z.string(), personaId: z.string(), label: z.string() })),
      providePermission: 'review.contribute',
      consumePermission: 'review.read',
      cardinality: 'many',
    });
  }
  register(source: MaterialSource, scope?: Scope) {
    const owner: CapabilityOwner = {
      id: source.id.split('.')[0],
      permissions: new Set(['*']),
      signal: new AbortController().signal,
    };
    const id = source.id + '.source',
      off: (() => void)[] = [];
    const provide = (point: string, handler: (input: any) => Promise<unknown>) =>
      scope
        ? scope.provide(point, id, source.label ?? source.id, handler)
        : this.capabilities.provide(owner, point, id, source.label ?? source.id, handler);
    off.push(provide('review.materials@1', (v) => source.read(v.personaId, v.streams)));
    if (source.archive)
      off.push(provide('review.archives@1', (v) => source.archive!(v.beforeDay, v.personaId)));
    if (source.streams)
      off.push(provide('review.material-streams@1', async () => source.streams!()));
    return () => {
      for (const fn of off.reverse()) fn();
    };
  }
  get entries() {
    const caller = {
      id: 'review',
      permissions: new Set(['review.read', 'review.write']),
      signal: new AbortController().signal,
    };
    const active = this.capabilities.list('review.materials@1').filter((p) => p.state === 'active');
    const streams = new Set(
      this.capabilities
        .list('review.material-streams@1')
        .filter((p) => p.state === 'active')
        .map((p) => p.id),
    );
    return new Map(
      active.map((p) => {
        const id = p.id;
        const archived = this.capabilities
          .list('review.archives@1')
          .some((a) => a.id === p.id && a.state === 'active');
        return [
          id,
          {
            id,
            owner: p.owner,
            label: p.label,
            read: (personaId: string, streams?: string[]) =>
              this.capabilities.invoke(caller, 'review.materials@1', p.id, {
                personaId,
                streams,
              }) as Promise<Material[]>,
            ...(streams.has(id)
              ? {
                  streams: () =>
                    this.capabilities.invoke(
                      caller,
                      'review.material-streams@1',
                      id,
                      {},
                    ) as Promise<Stream[]>,
                }
              : {}),
            ...(archived
              ? {
                  archive: (beforeDay: string, personaId?: string) =>
                    this.capabilities.invoke(caller, 'review.archives@1', p.id, {
                      beforeDay,
                      personaId,
                    }),
                }
              : {}),
          },
        ];
      }),
    );
  }
}
