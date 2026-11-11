import { z } from 'zod';
import {
  messageOriginSchema,
  messageContextSchema,
  type MessageOrigin,
  type MessageContext,
} from '../contracts/message-context.ts';
import type { Message } from '../contracts/index.ts';
import type { Capabilities, ExtensionPoint } from './capabilities.ts';
import type { PluginContext } from './registry.ts';

const descriptionSchema = messageOriginSchema.pick({ sender: true, channel: true, task: true });
export const messageSourcePoint: ExtensionPoint = {
  id: 'core.message.sources@1',
  description: 'Optional source descriptions for the common message header; never grants authority',
  input: z.object({}),
  output: descriptionSchema,
  providePermission: 'context.contribute',
  consumePermission: 'context.read',
  cardinality: 'many',
};
export function contributeMessageSource(
  ctx: Pick<PluginContext, 'capabilities'>,
  id: string,
  label: string,
  description: Pick<MessageOrigin, 'sender' | 'channel' | 'task'>,
) {
  const parsed = descriptionSchema.parse(description);
  return ctx.capabilities.provide(messageSourcePoint.id, id, label, () => parsed);
}

export async function captureMessageContext(
  capabilities: Capabilities,
  input: {
    role: Message['role'];
    source: Message['source'];
    time: string;
    timezone: string;
    origin?: MessageOrigin;
    preparedAt?: string;
  },
  signal: AbortSignal,
): Promise<MessageContext> {
  const { sourceId, ...origin } = messageOriginSchema.parse(input.origin ?? {});
  const descriptor = sourceId
    ? descriptionSchema.parse(
        await capabilities.invoke(
          { id: 'core', permissions: new Set(['context.read']), signal },
          messageSourcePoint.id,
          sourceId,
          {},
          signal,
        ),
      )
    : {};
  return messageContextSchema.parse({
    time: input.time,
    sender:
      input.role === 'assistant'
        ? 'assistant'
        : input.role === 'user' && input.source === 'human'
          ? 'user'
          : input.role === 'tool'
            ? 'tool'
            : 'system',
    ...Object.fromEntries(Object.entries(descriptor).filter(([, value]) => value !== undefined)),
    ...Object.fromEntries(Object.entries(origin).filter(([, value]) => value !== undefined)),
    timezone: input.timezone,
    ...(input.preparedAt ? { preparedAt: input.preparedAt } : {}),
  });
}

/** Legacy records get a conservative header; don't invent platform send times or rewrite the DB. */
export function storedMessageContext(
  message: Message,
  timezone: string,
): MessageContext | undefined {
  const saved = messageContextSchema.safeParse(message.meta.messageContext);
  if (saved.success) return saved.data;
  const time = z.iso.datetime({ offset: true }).safeParse(message.createdAt);
  if (!time.success) return undefined;
  return {
    time: time.data,
    timezone,
    sender:
      message.role === 'assistant'
        ? 'assistant'
        : message.role === 'user' && message.source === 'human'
          ? 'user'
          : message.role === 'tool'
            ? 'tool'
            : 'system',
    ...(message.source === 'human' && !message.meta.origin
      ? { channel: message.meta.workSession ? 'Role workbench' : 'App chat' }
      : {}),
    ...(typeof message.meta.triggerKind === 'string' ? { task: message.meta.triggerKind } : {}),
  };
}
