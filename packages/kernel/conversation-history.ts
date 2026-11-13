import type { Message } from '../contracts/index.ts';
import { createHash } from 'node:crypto';
import { transcriptText, type TranscriptMessage } from '../contracts/transcript.ts';

export const nativeMessage = (message: Message) => message.meta.native as TranscriptMessage | undefined;

/** A read-only projection. Never re-execute historical calls. Incomplete calls
 * retain an explicitly unknown outcome rather than an invented successful result.
 * Inputs accepted during execution wait behind the current tool-result batch. */
export function normalizeHistory(messages: Message[]): Message[] {
  const result: Message[] = [];
  let batch: Message[] = [], waiting: Message[] = [];
  const pending = new Map<string, { name: string; source: Message }>();
  const flush = () => {
    for (const [id, { name, source }] of pending) {
      const native: TranscriptMessage = { role: 'toolResult', toolCallId: id, toolName: name,
        isError: true, timestamp: Date.parse(source.createdAt), content: [{ type: 'text',
          text: 'Historical tool outcome is unconfirmed: execution was interrupted before a durable result was recorded. Do not assume success or repeat a possible side effect; inspect its actual state first.' }] };
      batch.push({ ...source, id: source.id + '.unconfirmed.' + createHash('sha256').update(id).digest('hex').slice(0, 16), role: 'tool',
        text: transcriptText(native), meta: { native, contextGroup: batch[0].id } });
    }
    result.push(...batch, ...waiting); batch = []; waiting = []; pending.clear();
  };
  for (const message of messages) {
    const native = nativeMessage(message);
    if (native?.role === 'toolResult') {
      if (!pending.has(native.toolCallId)) {
        const orphan: Message = { ...message, role: 'system', meta: { ...message.meta, orphanedToolResult: true } };
        delete orphan.meta.native;
        (batch.length ? waiting : result).push(orphan);
        continue;
      }
      batch.push({ ...message, meta: { ...message.meta, contextGroup: batch[0].id } });
      pending.delete(native.toolCallId);
      if (!pending.size) flush();
      continue;
    }
    if (native?.role === 'assistant') {
      if (batch.length) flush();
      const calls = native.content.filter(part => part.type === 'toolCall');
      // Failed empty attempts remain in durable storage/usage, not LLM history.
      if (!native.content.length || !calls.length && !native.content.some(part => part.type === 'text' && part.text.trim())) continue;
      if (calls.length) {
        batch = [{ ...message, meta: { ...message.meta, contextGroup: message.id } }];
        for (const call of calls) pending.set(call.id, { name: call.name, source: message });
      } else result.push(message);
      continue;
    }
    (batch.length ? waiting : result).push(message);
  }
  if (batch.length) flush();
  return result;
}

/** Budgeting and compaction operate on complete calls and their results. */
export function historyGroups(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let previous = '';
  for (const message of messages) {
    const key = String(message.meta.contextGroup ?? (nativeMessage(message) ? message.id : message.runId ?? message.id));
    if (key === previous) groups.at(-1)!.push(message);
    else { groups.push([message]); previous = key; }
  }
  return groups;
}
