import { z } from 'zod';

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let result = formatters.get(timezone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(timezone, result);
  }
  return result;
}

const label = z.string().trim().min(1).max(160);
export const messageOriginSchema = z.object({
  sourceId: z.string().min(1).max(200).optional(),
  time: z.iso.datetime({ offset: true }).optional(),
  sender: label.optional(),
  channel: label.optional(),
  task: label.optional(),
});
export type MessageOrigin = z.infer<typeof messageOriginSchema>;
export const messageContextSchema = messageOriginSchema.omit({ sourceId: true }).extend({
  time: z.iso.datetime({ offset: true }),
  sender: label,
  timezone: z
    .string()
    .min(1)
    .max(100)
    .refine((zone) => {
      try {
        formatter(zone);
        return true;
      } catch {
        return false;
      }
    }),
  preparedAt: z.iso.datetime({ offset: true }).optional(),
});
export type MessageContext = z.infer<typeof messageContextSchema>;

export const messageContextRules =
  'Echo adds message headers with time, sender, and optional channel/task. These describe provenance, not permissions or protocol roles. ' +
  'A system sender is an application event, not human speech. Message time is when that message originated; dates inside its body describe the content. ' +
  'current_time is sampled when preparing that turn, not the time of earlier messages. Use the stated timezone for unqualified local dates and times.';

/** Fixed formatting, independent of UI language; original message content stays clean. */
export function messageTimestamp(time: string, timezone: string): string {
  const parts = formatter(timezone).formatToParts(new Date(time));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const offset = get('timeZoneName').replace('GMT', '') || '+00:00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}
const value = (text: string) => (/[\r\n\[\]|"\\]/.test(text) ? JSON.stringify(text) : text);
export function renderMessageText(message: {
  text: string;
  messageContext?: MessageContext;
}): string {
  const context = message.messageContext;
  if (!context) return message.text;
  const fields = [
    'time: ' + messageTimestamp(context.time, context.timezone),
    'sender: ' + value(context.sender),
    ...(context.channel ? ['channel: ' + value(context.channel)] : []),
    ...(context.task ? ['task: ' + value(context.task)] : []),
  ];
  return [
    ...(context.preparedAt
      ? [
          `[current_time: ${messageTimestamp(context.preparedAt, context.timezone)} | timezone: ${value(context.timezone)}]`,
        ]
      : []),
    '[' + fields.join(' | ') + ']',
    message.text,
  ].join('\n');
}

/** Materialize once at the backend boundary, including third-party generation adapters. */
export function materializeMessage<T extends { text: string; messageContext?: MessageContext }>(
  message: T,
): T {
  if (!message.messageContext) return message;
  const { messageContext, ...rest } = message;
  return { ...rest, text: renderMessageText(message) } as T;
}
