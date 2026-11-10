import { createHash } from 'node:crypto';
import {
  executionUpdate,
  type ExecutionItem,
  type ExecutionUpdate,
} from '../contracts/execution.ts';
import type { Store } from './store.ts';
import type { Events } from './events.ts';

// Coalesce native deltas rather than making one database write or UI event per token.
export class ExecutionLedger {
  private pending = new Map<string, ExecutionItem>();
  private timer?: ReturnType<typeof setTimeout>;
  private runs = new Map<string, { conversationId: string; items: Map<string, ExecutionItem> }>();
  constructor(
    readonly store: Store,
    readonly events: Events,
  ) {}
  open(runId: string, conversationId: string) {
    this.runs.set(runId, { conversationId, items: new Map() });
  }
  update(runId: string, input: ExecutionUpdate) {
    const active = this.runs.get(runId);
    if (!active) return;
    const parsed = executionUpdate.safeParse(input);
    if (!parsed.success) return;
    const v = parsed.data,
      old = active.items.get(v.id);
    if (!old && active.items.size >= 256) return;
    const combined = v.text ?? (old?.text ?? '') + (v.delta ?? '');
    const item: ExecutionItem = {
      ...old,
      ...v,
      runId,
      conversationId: active.conversationId,
      sequence: old?.sequence ?? active.items.size + 1,
      updatedAt: new Date().toISOString(),
      text: combined.slice(-65536),
      detail: (v.detail ?? old?.detail)?.slice(0, 32768),
      truncated: old?.truncated || combined.length > 65536 || (v.detail?.length ?? 0) > 32768,
    };
    delete (item as any).delta;
    active.items.set(v.id, item);
    this.pending.set(runId + ':' + v.id, item);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 120);
      this.timer.unref();
    }
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const changed = new Map<string, string>();
    this.store.transaction(() => {
      for (const item of this.pending.values()) {
        this.store.put(
          'execution.' + item.runId,
          createHash('sha256').update(item.id).digest('hex'),
          item,
        );
        changed.set(item.runId, item.conversationId);
      }
    });
    this.pending.clear();
    for (const [runId, conversationId] of changed)
      this.events.emit('run.items.changed', { runId, conversationId });
  }
  finish(runId: string, state: 'succeeded' | 'failed' | 'cancelled' | 'unknown') {
    const active = this.runs.get(runId);
    for (const item of active?.items.values() ?? [])
      if (item.state === 'running')
        this.update(runId, { ...item, state: state === 'succeeded' ? 'completed' : state });
    this.flush();
    this.runs.delete(runId);
  }
  list(runId: string) {
    const state = this.store.run(runId)?.state;
    return [
      ...(this.runs.get(runId)?.items.values() ??
        this.store.documents<ExecutionItem>('execution.' + runId)),
    ]
      .map((item) =>
        item.state === 'running' && state && state !== 'running'
          ? { ...item, state: state === 'succeeded' ? ('completed' as const) : state }
          : item,
      )
      .sort((a, b) => a.sequence - b.sequence);
  }
  close() {
    this.flush();
    this.runs.clear();
  }
}
