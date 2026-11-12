import { invariant, type Message, type Run } from '../contracts/index.ts';
import type { DeliveryPlan } from '../contracts/delivery.ts';
import type { Router } from './router.ts';
import { captureMessageContext } from './message-context.ts';
import { configuredTimezone } from './time.ts';

export type TaskResultInput = {
  id: string; conversationId: string; text: string; source: Message['source'];
  task: string; report: boolean; delivery?: DeliveryPlan; reportPrompt?: string;
  reasoning?: import('../contracts/index.ts').Reasoning; expiresAt?: number;
  bubble?: boolean; localOnly?: boolean; triggerKind?: string;
};
/** One durable, model-visible result; waking the role is a separate decision. */
export class TaskResults {
  constructor(readonly router: Router) {}
  async submit(input: TaskResultInput, signal = new AbortController().signal): Promise<
    { state: 'recorded' | 'queued' } | { state: 'executed'; run: Run }
  > {
    signal.throwIfAborted();
    const { store } = this.router;
    const conversation = store.conversation(input.conversationId);
    invariant(conversation, 'missing_conversation', '结果所属会话不存在。');
    const key = 'task-result.' + input.id;
    const messageContext = await captureMessageContext(this.router.capabilities, {
      role: 'system', source: input.source, time: new Date().toISOString(),
      timezone: configuredTimezone(store), origin: { sender: 'system', task: input.task },
    }, signal);
    // Capture may await a plugin. Claim the result only after it completes, so concurrent retries share one row.
    const old = store.receipt(key);
    invariant(!old || old.text === input.text && old.conversationId === input.conversationId &&
      old.report === input.report, 'result_conflict', '同一任务结果的内容或处理方式已改变。');
    const text = (old?.composedText as string | undefined) ?? [
      input.report ? input.reportPrompt : '这是任务结果记录，无需主动回复或继续执行；后续对话涉及此事时可参考。',
      input.text,
    ].filter(Boolean).join('\n\n');
    let messageId = old?.messageId as string | undefined;
    if (!messageId) store.transaction(() => {
      messageId = store.append(input.conversationId, 'system', input.source, text, undefined, {
        taskResultId: input.id, report: input.report,
        messageContext,
      }).id;
      store.saveReceipt(key, { text: input.text, conversationId: input.conversationId,
        report: input.report, messageId, composedText: text,
        request: { delivery: input.delivery, reasoning: input.reasoning, expiresAt: input.expiresAt,
          bubble: input.bubble, localOnly: input.localOnly, triggerKind: input.triggerKind,
          messageOrigin: { sender: 'system', task: input.task } } });
    });
    this.router.events.emit('message.posted', { conversationId: input.conversationId });
    if (!input.report) return { state: 'recorded' };
    const request = { conversationId: input.conversationId, requestId: input.id, text,
      source: input.source, delivery: input.delivery, reasoning: input.reasoning,
      recordedInputId: messageId, expiresAt: input.expiresAt,
      bubble: input.bubble, localOnly: input.localOnly, triggerKind: input.triggerKind,
      messageOrigin: { sender: 'system', task: input.task },
      ...(old?.request as object ?? {}) };
    const previous = store.run(input.id);
    if (previous) return { state: 'executed', run: previous };
    if (this.router.isBusy(input.conversationId) || store.unresolved(input.conversationId).length ||
        store.queuedInput(input.conversationId)) {
      this.router.enqueue(request);
      return { state: 'queued' };
    }
    return { state: 'executed', run: await this.router.send(request, signal) };
  }
}
