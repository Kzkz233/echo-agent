import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EchoError, invariant, type Message } from '../contracts/index.ts';
import {
  deliveryPoint,
  deliveryRequest,
  deliveryResult,
  deliveryPlan,
  outputEnvelope,
  outputTarget,
  type DeliveryPlan,
  type OutputEnvelope,
  type DeliveryResult,
} from '../contracts/delivery.ts';
import type { Capabilities } from './capabilities.ts';
import type { Router } from './router.ts';
import type { Store } from './store.ts';
import type { Events } from './events.ts';
import { characterActive } from './characters.ts';

type Scope = ReturnType<Capabilities['forOwner']>;
type Receipt = {
  id: string;
  outputId: string;
  targetId: string;
  provider: string;
  state: 'pending' | 'sending' | DeliveryResult['state'];
  reason?: string;
  createdAt: string;
  updatedAt?: string;
  retryAt?: string;
  receipt?: unknown;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Durable fan-out, separate from inference and canonical conversation ownership. */
export class Deliveries {
  private life = new AbortController();
  private running = new Map<string, Promise<unknown>>();
  private destinationQueue = new Map<string, Promise<unknown>>();
  private dispose: (() => void)[] = [];
  constructor(
    readonly store: Store,
    readonly router: Router,
    readonly events: Events,
    readonly scope: Scope,
  ) {
    store.db
      .exec(`CREATE INDEX IF NOT EXISTS core_output_state ON documents(json_extract(data,'$.state')) WHERE namespace='output-deliveries';
      CREATE INDEX IF NOT EXISTS core_output_id ON documents(json_extract(data,'$.outputId')) WHERE namespace='output-deliveries';
      CREATE INDEX IF NOT EXISTS core_output_task ON documents(json_extract(data,'$.personaId'),json_extract(data,'$.plan.task.type'),json_extract(data,'$.plan.task.id')) WHERE namespace='outputs';`);
    scope.define({
      id: deliveryPoint,
      description: 'Task output destinations, lifecycle and idempotent delivery',
      input: deliveryRequest,
      output: z.object({
        targets: z.array(outputTarget).optional(),
        result: deliveryResult.optional(),
      }),
      providePermission: 'outputs.provide',
      consumePermission: 'outputs.deliver',
      cardinality: 'many',
    });
    scope.provide(deliveryPoint, 'core.chat', '聊天', (input) => {
      if (input.action === 'list')
        return {
          targets: [
            {
              id: 'core.chat',
              label: '聊天',
              revision: '1',
              portable: true,
              supportsImages: true,
              style: 'chat',
              legacySources: ['*'],
            },
          ],
        };
      const e = input.envelope;
      if (input.action === 'inspect')
        return {
          result: {
            state: (
              e.messageId
                ? this.store.message(e.messageId)
                : this.store.receipt('output-chat.' + e.id)
            )
              ? 'delivered'
              : 'unknown',
          },
        };
      // A generated reply already has its canonical record. Standalone reports
      // create a presentation-only row, excluded from inference and Review inputs.
      if (!e.messageId)
        this.store.transaction(() => {
          if (this.store.receipt('output-chat.' + e.id)) return;
          const message = this.store.append(
            e.conversationId,
            'system',
            'notification',
            [e.title, e.text].filter(Boolean).join('\n'),
            undefined,
            {
              presentationOnly: true,
              outputId: e.id,
              outputSource: e.plan.source,
              delivery: e.plan,
            },
          );
          this.store.saveReceipt('output-chat.' + e.id, {
            state: 'delivered',
            messageId: message.id,
          });
        });
      this.events.emit('message.posted', { conversationId: e.conversationId });
      return { result: { state: 'delivered' } };
    });
    router.planLocalReply = (conversationId, bubble, signal) =>
      this.plan(conversationId, 'human', [bubble ? 'avatar.bubble' : 'core.chat'], {}, signal);
    this.dispose.push(
      router.registerDeliveryStage((message) => this.stageMessage(message)),
    );
    // A crash while sending has an ambiguous result. Never replay it on startup.
    for (const row of this.states(['sending']))
      this.save({ ...row, state: 'unknown', reason: '发送时应用中断，请核对结果。' });
    this.dispose.push(
      events.subscribe((event) => {
        if (event.type === 'character.activity.changed' && !event.data.enabled) {
          for (const row of this.states(['pending'])) {
            const envelope = this.store.document<OutputEnvelope>('outputs', row.outputId);
            if (envelope?.personaId === event.data.personaId && row.state === 'pending')
              this.save({ ...row, state: 'skipped', reason: '角色已停用。' });
          }
        }
        if (['run.completed', 'message.posted', 'output.staged'].includes(event.type)) this.flush();
        if (event.type === 'avatar.shown') void this.refreshQueued('avatar');
      }),
    );
  }
  async catalog(conversationId: string, signal = this.life.signal, draftPersonaId?: string) {
    const conversation = this.store.conversation(conversationId);
    invariant(conversation || draftPersonaId, 'missing_conversation', '会话不存在。');
    const result = await Promise.allSettled(
      this.scope
        .list(deliveryPoint)
        .filter((p) => p.state === 'active')
        .map(async (provider) => {
          const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
          const value = (await abortable(
            this.scope.invoke(
              deliveryPoint,
              provider.id,
              {
                action: 'list',
                conversationId,
                personaId: conversation?.personaId ?? draftPersonaId!,
              },
              bounded,
            ),
            bounded,
          )) as any;
          return (value.targets ?? [])
            .filter((target: any) => target.id.startsWith(provider.owner + '.'))
            .map((target: any) => ({
              ...outputTarget.parse(target),
              provider: provider.id,
              owner: provider.owner,
            }));
        }),
    );
    signal.throwIfAborted();
    return result.flatMap((item) => (item.status === 'fulfilled' ? item.value : []));
  }
  async plan(
    conversationId: string,
    source: string,
    selected?: string[],
    options: {
      bubble?: boolean;
      localOnly?: boolean;
      legacySources?: string[];
      task?: { type: string; id: string };
    } = {},
    signal = this.life.signal,
  ): Promise<DeliveryPlan> {
    const available = await this.catalog(conversationId, signal);
    const ids =
      selected ??
      available
        .filter(
          (t) =>
            t.id === 'core.chat' ||
            (options.bubble && t.id === 'avatar.bubble') ||
            (options.legacySources ?? [source]).some((source) =>
              t.legacySources.includes(source),
            ) ||
            t.legacySources.includes('*'),
        )
        .map((t) => t.id);
    return deliveryPlan.parse({
      source,
      task: options.task,
      targets: ids
        .filter((id) => !options.localOnly || ['core.chat', 'avatar.bubble'].includes(id))
        .map(
          (id) =>
            available.find((t) => t.id === id) ?? {
              id,
              label: id,
              provider: 'core.unavailable',
              owner: id.split('.')[0],
              revision: 'unavailable',
              ready: false,
              issue: '输出插件或目标当前不可用。',
            },
        ),
    });
  }
  private save(row: Receipt) {
    this.store.put('output-deliveries', row.id, { ...row, updatedAt: new Date().toISOString() });
    this.events.emit('output.changed', { outputId: row.outputId });
  }
  private stageMessage(message: Message) {
    if (!message.meta.delivery) return;
    const plan = deliveryPlan.parse(message.meta.delivery);
    if (plan.targets.length && message.meta.replyPhase !== 'progress' && message.meta.replyPhase !== 'final') return;
    const personaId = this.store.conversation(message.conversationId)!.personaId;
    this.stage(
      {
        id: 'message.' + message.id,
        personaId,
        conversationId: message.conversationId,
        messageId: message.id,
        text: message.text,
        title: message.meta.replyTitle as OutputEnvelope['title'],
        parts: message.meta.replyParts as OutputEnvelope['parts'],
        plan,
      },
      true,
    );
  }
  stage(raw: OutputEnvelope, withinTransaction = false) {
    const envelope = outputEnvelope.parse(raw),
      old = this.store.document<OutputEnvelope>('outputs', envelope.id);
    invariant(
      !old || hash(old) === hash(envelope),
      'output_conflict',
      '同一输出编号的内容或目标已改变。',
    );
    if (old) return old;
    const commit = () => {
      this.store.put('outputs', envelope.id, envelope);
      for (const target of envelope.plan.targets) {
        const id = 'output-' + hash([envelope.id, target.id]);
        this.save({
          id,
          outputId: envelope.id,
          targetId: target.id,
          provider: target.provider,
          state: characterActive(this.store, envelope.personaId) && target.ready ? 'pending' : 'skipped',
          ...(target.ready ? {} : { reason: target.issue ?? '输出目标当前不可用。' }),
          createdAt: new Date().toISOString(),
        });
      }
    };
    if (withinTransaction) commit();
    else this.store.transaction(commit);
    return envelope;
  }
  async publish(envelope: OutputEnvelope, signal = this.life.signal) {
    signal.throwIfAborted();
    const old = this.store.document<OutputEnvelope>('outputs', envelope.id);
    const identity = (e: OutputEnvelope) => [
      e.id,
      e.personaId,
      e.conversationId,
      e.messageId,
      e.text,
      e.title,
      e.parts,
      e.plan.source,
      e.plan.task,
      e.plan.replyTo,
      e.plan.targets.map((t) => t.id).sort(),
    ];
    invariant(
      !old || hash(identity(old)) === hash(identity(envelope)),
      'output_conflict',
      '同一输出编号的内容或目标已改变。',
    );
    this.stage(old ?? envelope);
    this.events.emit('output.staged', { outputId: envelope.id });
    await Promise.all(
      this.rows(envelope.id)
        .filter((row) => row.state === 'pending')
        .map((row) => this.deliver(row.id, signal)),
    );
    return this.rows(envelope.id);
  }
  rows(outputId?: string): Receipt[] {
    return outputId
      ? (
          this.store.db
            .prepare(
              "SELECT data FROM documents WHERE namespace='output-deliveries' AND json_extract(data,'$.outputId')=?",
            )
            .all(outputId) as { data: string }[]
        ).map((row) => JSON.parse(row.data))
      : this.store.documents<Receipt>('output-deliveries');
  }
  private states(states: string[], owner?: string): Receipt[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM documents WHERE namespace='output-deliveries' AND json_extract(data,'$.state') IN (" +
            states.map(() => '?').join(',') +
            ')' +
            (owner ? " AND json_extract(data,'$.provider') LIKE ?" : '') + ' ORDER BY rowid',
        )
        .all(...states, ...(owner ? [owner + '.%'] : [])) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  recent(filter: { personaId?: string; taskType?: string; taskId?: string }) {
    const conditions = [
      ['personaId', filter.personaId],
      ['plan.task.type', filter.taskType],
      ['plan.task.id', filter.taskId],
    ].filter(([, value]) => value);
    return (
      this.store.db
        .prepare(
          "SELECT data FROM documents WHERE namespace='outputs'" +
            conditions.map(([field]) => " AND json_extract(data,'$." + field + "')=?").join('') +
            ' ORDER BY rowid DESC LIMIT 100',
        )
        .all(...conditions.map(([, value]) => value!)) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as OutputEnvelope);
  }
  private flush() {
    if (this.life.signal.aborted) return;
    for (const row of this.states(['pending'])
      .filter((row) => !this.running.has(row.id))
      .slice(0, Math.max(0, 16 - this.running.size)))
      void this.deliver(row.id).catch(() => {});
  }
  private deliver(id: string, outer = this.life.signal): Promise<unknown> {
    const active = this.running.get(id);
    if (active) return active;
    const row = this.store.document<Receipt>('output-deliveries', id);
    const output = row && this.store.document<OutputEnvelope>('outputs', row.outputId);
    if (row?.state !== 'pending' || !output) return Promise.resolve(row);
    const destination = JSON.stringify([output.conversationId, row.targetId]);
    const work = (this.destinationQueue.get(destination) ?? Promise.resolve())
      .then(async () => {
        const row = this.store.document<Receipt>('output-deliveries', id);
        if (row?.state !== 'pending') return row;
        const envelope = this.store.document<OutputEnvelope>('outputs', row.outputId)!;
        if (
          this.router.isDeleting(envelope.conversationId) ||
          this.store.conversation(envelope.conversationId)?.personaId !== envelope.personaId
        ) {
          this.save({ ...row, state: 'skipped', reason: '会话已删除或归属已改变。' });
          return;
        }
        if (Date.now() - Date.parse(row.retryAt ?? row.createdAt) > 10 * 60_000) {
          this.save({ ...row, state: 'skipped', reason: '投递已过期，结果仍保留在任务历史。' });
          return;
        }
        const signal = AbortSignal.any([
          this.life.signal,
          outer,
          this.router.characterSignal(envelope.personaId),
          AbortSignal.timeout(30000),
        ]);
        if (signal.aborted) {
          this.save({ ...row, state: 'skipped', reason: '角色或应用已停止。' });
          return;
        }
        const target = envelope.plan.targets.find((t) => t.id === row.targetId)!;
        const current = (await this.catalog(envelope.conversationId, signal)).find(
          (t) => t.id === target.id && t.provider === target.provider,
        );
        if (this.router.isDeleting(envelope.conversationId) || !this.store.conversation(envelope.conversationId)) {
          this.save({ ...row, state: 'skipped', reason: '会话已删除或正在删除。' });
          return;
        }
        if (!current || current.revision !== target.revision || !current.ready) {
          this.save({
            ...row,
            state: 'skipped',
            reason: current?.issue ?? '输出目标已变更或不可用。',
          });
          return;
        }
        signal.throwIfAborted();
        this.save({ ...row, state: 'sending' });
        try {
          const response = (await abortable(
            this.scope.invoke(
              deliveryPoint,
              target.provider,
              {
                action: 'deliver',
                targetId: target.id,
                revision: target.revision,
                envelope,
                idempotencyKey: id,
              },
              signal,
            ),
            signal,
          )) as any;
          this.save({
            ...row,
            reason: undefined,
            receipt: undefined,
            ...deliveryResult.parse(response.result),
          });
        } catch (error) {
          this.save({
            ...row,
            state:
              error instanceof EchoError && !error.uncertain && !signal.aborted
                ? 'failed'
                : 'unknown',
            reason: String(error).slice(0, 1000),
          });
        }
      })
      .catch((error) => {
        const row = this.store.document<Receipt>('output-deliveries', id);
        if (row?.state === 'pending')
          this.save({ ...row, state: 'skipped', reason: String(error).slice(0, 1000) });
      })
      .finally(() => {
        this.running.delete(id);
        if (this.destinationQueue.get(destination) === work) this.destinationQueue.delete(destination);
        queueMicrotask(() => this.flush());
      });
    this.running.set(id, work);
    this.destinationQueue.set(destination, work);
    return work;
  }
  async refreshQueued(owner?: string) {
    for (const row of this.states(['queued', 'unknown'], owner)) {
      const envelope = this.store.document<OutputEnvelope>('outputs', row.outputId)!;
      const target = envelope.plan.targets.find((target) => target.id === row.targetId)!;
      if (owner && target.owner !== owner) continue;
      if (
        !this.scope
          .list(deliveryPoint)
          .some((p) => p.id === target.provider && p.state === 'active')
      )
        continue;
      const bounded = AbortSignal.any([this.life.signal, AbortSignal.timeout(5000)]);
      try {
        const response = (await abortable(
          this.scope.invoke(
            deliveryPoint,
            target.provider,
            {
              action: 'inspect',
              targetId: target.id,
              revision: target.revision,
              envelope,
              idempotencyKey: row.id,
            },
            bounded,
          ),
          bounded,
        )) as any;
        if (
          response.result &&
          this.store.document<Receipt>('output-deliveries', row.id)?.state !== 'closed'
        ) {
          const result = deliveryResult.parse(response.result);
          if (
            hash([row.state, row.reason, row.receipt]) !==
            hash([result.state, result.reason, result.receipt])
          )
            this.save({ ...row, reason: undefined, receipt: undefined, ...result });
        }
      } catch {
        /* Inspection never authorizes retry. */
      }
    }
  }
  async retry(id: string, signal: AbortSignal) {
    const row = this.store.document<Receipt>('output-deliveries', id);
    invariant(
      row?.state === 'failed',
      'output_retry',
      '只能重试已确认失败的投递，未知结果须先核对。',
    );
    this.save({ ...row, state: 'pending', retryAt: new Date().toISOString() });
    return this.deliver(id, signal);
  }
  resolve(id: string) {
    const row = this.store.document<Receipt>('output-deliveries', id);
    invariant(
      row && ['queued', 'unknown'].includes(row.state),
      'output_resolve',
      '仅排队或未知投递需要核对。',
    );
    this.save({
      ...row,
      state: 'closed',
      reason: '使用者已结束跟进；未重新投递，也不撤回上游已受理的消息。',
    });
  }
  references(conversationId: string) {
    return this.states(['sending', 'queued', 'unknown']).flatMap((row) => {
      const envelope = this.store.document<OutputEnvelope>('outputs', row.outputId);
      return envelope?.conversationId === conversationId
        ? [
            {
              label: '待核对的任务投递',
              role: 'report' as const,
              page: 'automation',
              enabled: true,
              blocksDeletion: true,
              type: envelope.plan.task?.type,
              taskId: envelope.plan.task?.id,
            },
          ]
        : [];
    });
  }
  async close() {
    this.life.abort();
    for (const dispose of this.dispose) dispose();
    await Promise.allSettled(this.running.values());
  }
}
