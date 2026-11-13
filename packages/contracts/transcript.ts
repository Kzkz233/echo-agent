import { z } from 'zod';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';

/** Model-facing conversation records, independent of the bounded execution/UI log. */
export type TranscriptMessage = AssistantMessage | ToolResultMessage;
const content = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough(),
  z.object({ type: z.literal('toolCall'), id: z.string().min(1), name: z.string().min(1),
    arguments: z.record(z.string(), z.json()) }).passthrough(),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }).passthrough(),
]);
export const transcriptMessage = z.discriminatedUnion('role', [
  z.object({ role: z.literal('assistant'), content: z.array(content), api: z.string(),
    provider: z.string(), model: z.string(), timestamp: z.number(), stopReason: z.string(),
    usage: z.record(z.string(), z.json()) }).passthrough(),
  z.object({ role: z.literal('toolResult'), content: z.array(content), toolCallId: z.string(),
    toolName: z.string(), isError: z.boolean(), timestamp: z.number() }).passthrough(),
]);

export function persistentTranscript(value: TranscriptMessage): TranscriptMessage {
  // Detached JSON retains provider replay fields, including signed reasoning. Tool
  // media is deliberately transient: never start archiving screenshots as a side
  // effect of enabling conversation persistence. Keep its omission explicit.
  const parsed = transcriptMessage.parse(JSON.parse(JSON.stringify(value)));
  parsed.content = parsed.content.map(part => ['image', 'audio', 'video'].includes(part.type)
    ? { type: 'text', text: `[Historical ${part.type} content was transient and is not stored. Read the original again if needed.]` }
    : part);
  if (parsed.role === 'toolResult') delete parsed.details; // tool-private/UI data, not model context
  return parsed as unknown as TranscriptMessage;
}

/** Readable projection for summaries and hosts that cannot import native calls. */
export function transcriptText(message: TranscriptMessage): string {
  return message.role === 'toolResult'
    ? `Historical tool result (${message.toolName}, call ${message.toolCallId}, ${message.isError ? 'error' : 'completed'}):\n` +
      message.content.map(part => part.type === 'text' ? part.text : '[transient media]').join('\n')
    : message.content.map(part => part.type === 'toolCall'
      ? `Historical tool call (${part.name}, call ${part.id}): ${JSON.stringify(part.arguments)}`
      : part.type === 'text' ? part.text : part.type === 'thinking' ? part.thinking : '').filter(Boolean).join('\n');
}
