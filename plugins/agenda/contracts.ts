import { z } from 'zod';
import { id } from '../../packages/contracts/index.ts';
export const agendaItemSchema = z.object({
  id: id.optional(),
  personaId: id.default('companion'),
  title: z.string().trim().min(1).max(160),
  notes: z.string().max(20000).default(''),
  date: z.iso.date().optional(),
  dateEnd: z.iso.date().optional(),
  parentId: id.optional(),
  start: z.iso.datetime().optional(),
  end: z.iso.datetime().optional(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  state: z.enum(['open', 'done', 'cancelled']).default('open'),
  reminder: z
    .object({
      enabled: z.boolean().default(false),
      minutesBefore: z.number().int().min(0).max(43200).default(0),
    })
    .default({ enabled: false, minutesBefore: 0 }),
  conversationId: id.optional(),
  extensions: z.record(z.string(), z.unknown()).default({}),
  revision: z.number().int().min(0).default(0),
});
export type AgendaItem = z.infer<typeof agendaItemSchema> & { id: string; updatedAt: string };
export const agendaField = z.object({
  key: id,
  label: z.string().max(160),
  kind: z.literal('select'),
  options: z.array(z.object({ value: z.string(), label: z.string() })).max(1000),
});
export const rescheduleInput = z.object({
  id,
  revision: z.number().int().positive(),
  date: z.iso.date(),
  requestId: id,
  moveChildren: z.boolean().default(true),
  extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
export const parsedItems = z.object({
  items: z.array(agendaItemSchema).max(100),
  warnings: z.array(z.string().max(500)).max(30).default([]),
});
export const projectionInput = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  personaId: id.optional(),
});
export const projectionOutput = z.object({
  title: z.string().max(160),
  columns: z.array(z.object({ id: z.string(), label: z.string() })).max(20),
  groups: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        cells: z.record(z.string(), z.array(id).max(1000)),
      }),
    )
    .max(200),
});
