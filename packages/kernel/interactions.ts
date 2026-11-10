import { randomUUID } from 'node:crypto';
import {
  hostInteractionSchema,
  type HostAnswer,
  type HostInteraction,
  type PendingInteraction,
} from '../contracts/interaction.ts';
import { invariant } from '../contracts/index.ts';
import type { Events } from './events.ts';

/** Ephemeral host requests can only be answered while the originating run is alive. */
export class Interactions {
  private reviewer?: (item: PendingInteraction, signal: AbortSignal) => Promise<HostAnswer | undefined>;
  private readonly pending = new Map<
    string,
    { item: PendingInteraction; finish: (answer: HostAnswer) => void }
  >();
  constructor(readonly events: Events) {}

  reviewWith(reviewer: NonNullable<Interactions['reviewer']>) {
    this.reviewer = reviewer;
    return () => { if (this.reviewer === reviewer) this.reviewer = undefined; };
  }

  list(conversationId: string) {
    return [...this.pending.values()]
      .map(({ item }) => item)
      .filter((item) => item.conversationId === conversationId);
  }

  async ask(
    conversationId: string,
    runId: string,
    input: HostInteraction,
    signal: AbortSignal,
  ): Promise<HostAnswer> {
    const content = hostInteractionSchema.parse(input);
    if (signal.aborted || this.list(conversationId).length >= 8)
      return Promise.resolve({ decision: 'cancel' });
    const item = { ...content, id: randomUUID(), conversationId, runId };
    if (item.kind === 'approval' && item.canAllow && item.workspaceWrite && this.reviewer) {
      const reviewer = this.reviewer;
      const answer = await reviewer(item, signal).catch(() => undefined);
      if (signal.aborted) return { decision: 'cancel' };
      if (reviewer === this.reviewer && (answer?.decision === 'allow' || answer?.decision === 'deny')) return answer;
    }
    return new Promise((resolve) => {
      const cancel = () => finish({ decision: 'cancel' });
      const finish = (answer: HostAnswer) => {
        if (!this.pending.delete(item.id)) return;
        signal.removeEventListener('abort', cancel);
        this.events.emit('interaction.changed', { conversationId });
        resolve(answer);
      };
      this.pending.set(item.id, { item, finish });
      signal.addEventListener('abort', cancel, { once: true });
      this.events.emit('interaction.changed', { conversationId });
    });
  }

  answer(conversationId: string, id: string, answer: HostAnswer) {
    const request = this.pending.get(id);
    invariant(
      request?.item.conversationId === conversationId,
      'interaction_stale',
      '此请求已结束或不属于当前会话。',
    );
    const item = request.item;
    if (answer.decision !== 'cancel') {
      if (item.kind === 'approval') {
        invariant(
          answer.decision === 'deny' || (answer.decision === 'allow' && item.canAllow),
          'interaction_answer',
          '此操作没有提供该选项。',
        );
      } else {
        invariant(
          answer.decision === 'answer' && answer.answers.length === item.questions.length,
          'interaction_answer',
          '请逐项回答问题。',
        );
        for (const question of item.questions) {
          const rows = answer.answers.filter((row) => row.id === question.id);
          const response = rows[0];
          invariant(
            rows.length === 1 &&
              (response.selected.length > 0 || response.custom) &&
              (question.multiple || response.selected.length + Number(!!response.custom) === 1) &&
              (!response.custom || question.custom) &&
              new Set(response.selected).size === response.selected.length &&
              response.selected.every((label) =>
                question.options.some((option) => option.label === label),
              ),
            'interaction_answer',
            '选择或输入的答案不符合宿主提供的选项。',
          );
        }
      }
    }
    request.finish(answer);
    return { accepted: true };
  }
}
