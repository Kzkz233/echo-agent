import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '../../../packages/contracts/index.ts';
import { replyPartGaps } from '../../../packages/contracts/reply-pacing.ts';

type Reveal = { id: string; at: number[] };
const noSchedule: Reveal[] = [];

export function dialogueParts(message: Message): string[] {
  const parts = message.meta.replyParts;
  return Array.isArray(parts) && parts.length && parts.every((part) => typeof part === 'string')
    ? parts
    : [message.text];
}

export function useDialoguePacing(
  conversationId: string | undefined,
  ready: boolean,
  messages: Message[],
) {
  const cursor = useRef<{ id?: string; seq: number } | undefined>(undefined);
  const [schedule, setSchedule] = useState<{ id?: string; reveals: Reveal[] }>({
    reveals: noSchedule,
  });
  const reveals = schedule.id === conversationId ? schedule.reveals : noSchedule;
  const revealAll = useCallback(
    () =>
      setSchedule((current) =>
        current.reveals.length ? { id: current.id, reveals: noSchedule } : current,
      ),
    [],
  );
  const reset = useCallback(() => {
    cursor.current = undefined;
    revealAll();
  }, [revealAll]);

  useLayoutEffect(() => {
    if (!ready || !conversationId) {
      cursor.current = undefined;
      revealAll();
      return;
    }
    const previous = cursor.current;
    const seq = messages.at(-1)?.seq ?? 0;
    if (previous?.id !== conversationId) {
      cursor.current = { id: conversationId, seq };
      return; // The initial snapshot is history, including when reopening the conversation.
    }
    if (seq <= previous.seq) return;
    cursor.current = { id: conversationId, seq };
    const fresh = messages.filter((message) => message.seq > previous.seq);
    const lastInput = fresh.findLastIndex((message) => message.role === 'user');
    if (document.hidden) {
      revealAll();
      return;
    }
    const now = performance.now();
    setSchedule((current) => {
      const pending =
        current.id === conversationId && lastInput < 0
          ? current.reveals.filter(({ at }) => at.at(-1)! > now)
          : [];
      let at = pending.at(-1)?.at.at(-1) ?? now;
      for (const message of fresh.slice(lastInput + 1)) {
        if (message.role !== 'assistant') continue;
        const gaps =
          message.source === 'chat' || message.source === 'care'
            ? replyPartGaps(dialogueParts(message), 'chat')
            : [];
        const start = at;
        const times = [start, ...gaps.map((gap) => (at += gap))];
        if (at > now) pending.push({ id: message.id, at: times });
      }
      return { id: conversationId, reveals: pending.length ? pending : noSchedule };
    });
  }, [conversationId, ready, messages, revealAll]);

  useEffect(() => {
    if (!reveals.length) return;
    const now = performance.now();
    const next = Math.min(...reveals.map(({ at }) => at.find((time) => time > now) ?? Infinity));
    const timer = setTimeout(
      () =>
        setSchedule((current) => ({
          ...current,
          reveals: current.reveals.filter(({ at }) => at.at(-1)! > performance.now()),
        })),
      Number.isFinite(next) ? Math.max(1, Math.ceil(next - now)) : 0,
    );
    const visibility = () => {
      if (document.hidden) revealAll();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [reveals, revealAll]);

  const now = performance.now();
  const partLimits = new Map(
    reveals.map(({ id, at }) => [id, at.filter((time) => time <= now).length]),
  );
  return { partLimits, reveals, revealAll, reset };
}
