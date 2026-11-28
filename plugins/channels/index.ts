import { contributeMaintenance } from '../../packages/kernel/maintenance.ts';
import { channelTextMode, deliveryPoint, replySubmission } from '../../packages/contracts/delivery.ts';
import manifest from './echo-plugin.json' with { type: 'json' };
import { providerSnapshot } from '../../packages/kernel/provider-snapshot.ts';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { characterActive } from '../../packages/kernel/characters.ts';
import { id, invariant, type Message, type Run } from '../../packages/contracts/index.ts';
import { readReplyImage, replyImageBase64 } from '../../packages/kernel/reply-images.ts';
import { defineManifest, type Plugin, type PluginContext } from '../../packages/kernel/registry.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Router } from '../../packages/kernel/router.ts';
import { Events } from '../../packages/kernel/events.ts';
import type { Deliveries } from '../../packages/kernel/delivery.ts';
import { operations } from '../shared.ts';
import { hasScopedSignalKey } from '../../packages/contracts/legacy-signals.ts';
import { type TriggerActions } from '../../packages/kernel/trigger-actions.ts';
const bindingSchema = z.object({
  id: id.optional(),
  adapter: z.string().min(1),
  peer: z.string().min(1).max(300),
  conversationId: id,
  enabled: z.boolean().default(true),
  alsoBubble: z.boolean().default(false),
  textMode: channelTextMode.optional(),
  automaticSources: z.array(z.enum(['care', 'review', 'notification', 'trigger'])).default([]),
  automaticTriggerKinds: z.array(id).max(100).default([]),
});
type Binding = z.infer<typeof bindingSchema> & { id: string; recipientKey?: string };
const destinationId = (binding: Binding) => 'channels.binding.' + (binding.recipientKey ?? binding.id);
// Keep the existing revision for all previously enabled bindings. Enabled is a
// permission checked at send time; disabling a binding does not change its peer.
const outputRevision = (binding: Binding) =>
  createHash('sha256').update(JSON.stringify([binding.conversationId, binding.adapter, binding.peer, true])).digest('hex');
const deliveryInput = z.object({
  conversationId: id,
  peer: z.string(),
  text: z.string().max(100000),
  messageId: id,
  replyTo: z.string().optional(),
  idempotencyKey: z.string(),
  image: replyImageBase64.optional(),
  textMode: channelTextMode.optional(),
  parts: replySubmission.shape.messages.optional(),
});
const deliveryResult = z.object({
  state: z.enum(['delivered', 'queued', 'failed', 'unknown', 'skipped']),
  receipt: z.unknown().optional(),
});
export class Channels {
  private ctx?: PluginContext;
  private paused = false;
  private work = new Set<Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly router: Router,
    readonly events: Events,
    readonly triggerActions: TriggerActions,
    readonly deliveries: Deliveries,
  ) {}
  get sending() {
    return !!this.store.db.prepare("SELECT 1 FROM documents WHERE namespace='channel-outbound' AND json_extract(data,'$.state')='sending' LIMIT 1").get();
  }
  private track(work: Promise<unknown>) {
    this.work.add(work);
    void work.catch(() => {}).finally(() => this.work.delete(work));
  }
  bindings() {
    return this.store.documents<Binding>('channel-bindings');
  }
  async receive(
    input: { adapter: string; peer: string; remoteMessageId: string; text: string; sentAt?: string; sender?: string },
    owner?: string,
  ) {
    invariant(this.ctx, 'plugin_disabled', 'Channels disabled');
    const provider = this.ctx.capabilities
      .list('channels.send@1')
      .find((p) => p.id === input.adapter && p.state === 'active');
    invariant(
      provider && provider.owner === owner,
      'channel_owner',
      'Adapter cannot impersonate another channel',
    );
    const requestId =
        'channel-' +
        createHash('sha256')
          .update(JSON.stringify([input.adapter, input.peer, input.remoteMessageId]))
          .digest('hex'),
      old = this.store.document<any>('channel-inbound', requestId);
    if (old) return { accepted: old.state === 'accepted', requestId };
    const matches = this.bindings().filter(
      (b) => b.enabled && b.adapter === input.adapter && b.peer === input.peer,
    );
    invariant(matches.length <= 1, 'channel_ambiguous', 'External peer has multiple active routes');
    this.store.put(
      'channel-peers',
      input.adapter + '.' + createHash('sha256').update(input.peer).digest('hex'),
      { adapter: input.adapter, peer: input.peer, lastSeen: new Date().toISOString() },
    );
    if (!matches.length) {
      this.store.put('channel-inbound', requestId, {
        id: requestId,
        state: 'unbound',
        adapter: input.adapter,
        peer: input.peer,
      });
      this.events.emit('channels.updated', {});
      return { accepted: false, reason: 'unbound' };
    }
    const binding = matches[0];
    const personaId = this.store.conversation(binding.conversationId)?.personaId;
    if (personaId && !characterActive(this.store, personaId)) {
      this.store.put('channel-inbound', requestId, { id: requestId, bindingId: binding.id, state: 'ignored', reason: 'character_disabled' });
      return { accepted: false, reason: 'character_disabled', requestId };
    }
    const delivery = await this.deliveries.plan(binding.conversationId, 'human', [
      destinationId(binding),
      ...(binding.alsoBubble ? ['avatar.bubble'] : []),
    ], { replyTo: input.remoteMessageId }, this.ctx.signal);
    const received = this.store.document<any>('channel-inbound', requestId);
    if (received) return { accepted: received.state === 'accepted', requestId };
    const current = this.store.document<Binding>('channel-bindings', binding.id);
    if (!current?.enabled || current.peer !== binding.peer || current.adapter !== binding.adapter || current.conversationId !== binding.conversationId)
      return { accepted: false, reason: 'binding_changed', requestId };
    const result = this.router.enqueue({
        conversationId: binding.conversationId,
        text: input.text,
        requestId,
        source: 'human',
        bubble: binding.alsoBubble,
        origin: { bindingId: binding.id, remoteMessageId: input.remoteMessageId },
        messageOrigin: { channel: provider.label.slice(0, 160), ...(input.sentAt ? { time: input.sentAt } : {}), ...(input.sender ? { sender: input.sender } : {}) },
        delivery,
      });
    this.store.put('channel-inbound', requestId, {
      id: requestId,
      state: 'accepted',
      bindingId: binding.id,
      remoteMessageId: input.remoteMessageId,
    });
    return result;
  }
  private async deliverPending(key: string) {
    const ctx = this.ctx;
    const row = this.store.document<any>('channel-outbound', key);
    if (!ctx || this.paused || this.deliveries.dispatchPaused || row?.state !== 'pending') return row;
    const binding = this.store.document<Binding>('channel-bindings', row.bindingId);
    const message = this.store.message(row.messageId);
    const run = message?.runId ? this.store.run(message.runId) : undefined;
    if (
      !binding ||
      !message ||
      binding.adapter !== row.adapter ||
      binding.peer !== row.payload.peer ||
      !this.permits(binding, message, run)
    ) {
      const skipped = { ...row, state: 'skipped' };
      this.store.put('channel-outbound', key, skipped);
      this.events.emit('channels.updated', { id: key });
      return skipped;
    }
    if (
      !ctx.capabilities
        .list('channels.send@1')
        .some((p) => p.id === row.adapter && p.state === 'active')
    )
      return row;
    this.store.put('channel-outbound', key, { ...row, state: 'sending' });
    const personaId = this.store.conversation(message.conversationId)!.personaId;
    const signal = AbortSignal.any([ctx.signal, this.router.characterSignal(personaId)]);
    try {
      const canSendImage = ctx.capabilities
        .list('channels.image-adapters@1')
        .some((adapter) => adapter.id === row.adapter && adapter.state === 'active');
      const image = canSendImage
        ? await readReplyImage(ctx.capabilities, message.meta.image, signal)
        : undefined;
      const result = deliveryResult.parse(
        await ctx.capabilities.invoke(
          'channels.send@1',
          row.adapter,
          { ...row.payload, image },
          signal,
        ),
      );
      this.store.put('channel-outbound', key, { ...row, ...result });
    } catch {
      this.store.put('channel-outbound', key, { ...row, state: 'unknown' });
    }
    this.events.emit('channels.updated', { id: key });
    return this.store.document('channel-outbound', key);
  }
  private permits(binding: Binding, message: Message, run?: Run) {
    if (run?.meta.delivery || message.meta.delivery) return false;
    const personaId = this.store.conversation(message.conversationId)?.personaId;
    if (personaId && !characterActive(this.store, personaId)) return false;
    // Local acceptance checks use the native bubble receipt, never channel fan-out.
    if (run?.meta.localOnly) return false;
    if (!binding.enabled || binding.conversationId !== message.conversationId) return false;
    if (!run) {
      if (message.source !== 'notification') return false;
      const kind = message.meta.triggerKind;
      return hasScopedSignalKey(kind)
        ? (binding.automaticTriggerKinds ?? []).includes(kind)
        : binding.automaticSources.includes('notification');
    }
    const origin = run.meta.origin as { bindingId: string } | undefined;
    if (origin) return binding.id === origin.bindingId;
    if (run.source === 'trigger' && hasScopedSignalKey(run.meta.triggerKind))
      return (binding.automaticTriggerKinds ?? []).includes(run.meta.triggerKind);
    return binding.automaticSources.includes(run.source as any);
  }
  private flush() {
    if (!this.ctx) return;
    for (const row of this.store.db
      .prepare(
        "SELECT id FROM documents WHERE namespace='channel-outbound' AND json_extract(data,'$.state')='pending'",
      )
      .all())
      this.track(this.deliverPending(String(row.id)));
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      references: (id) =>
        this.bindings()
          .filter((binding) => binding.conversationId === id)
          .map((binding) => ({
            label: binding.adapter,
            page: 'channels',
            role: 'channel',
            enabled:
              binding.enabled &&
              !!this.ctx?.capabilities
                .list('channels.send@1')
                .some((provider) => provider.id === binding.adapter && provider.state === 'active'),
          })),
      activate: (ctx) => {
        this.ctx = ctx;
        this.paused = false;
        contributeMaintenance(ctx.capabilities,'channels.outbound','通道发送',{
          prepare:() => { this.paused = true; }, blockers:() => this.sending ? ['消息仍在投递'] : [],
          resume:() => { this.paused = false; this.flush(); },
        });
        ctx.dispose(this.events.subscribe(event => {
          if (event.type !== 'character.activity.changed' || event.data.enabled) return;
          for (const row of this.store.documents<any>('channel-outbound')) {
            const conversation = this.store.conversation(row.payload?.conversationId);
            if (row.state === 'pending' && conversation?.personaId === event.data.personaId)
              this.store.put('channel-outbound', row.id, { ...row, state: 'skipped', reason: 'character_disabled' });
          }
          this.events.emit('channels.updated', {});
        }));
        // Drain only records written before unified output delivery was introduced.
        for (const row of this.store.documents<any>('channel-outbound'))
          if (row.state === 'sending')
            this.store.put('channel-outbound', row.id, { ...row, state: 'unknown' });
        ctx.dispose(async () => {
          this.ctx = undefined;
          await Promise.allSettled(this.work);
        });
        ctx.capabilities.define({
          id: 'channels.image-adapters@1',
          description: '支持回复图片的通道',
          input: z.object({}),
          output: z.object({}),
          providePermission: 'channels.adapter',
          consumePermission: 'channels.deliver',
          cardinality: 'many',
        });
        for (const point of ['send', 'inspect'])
          ctx.capabilities.define({
            id: `channels.${point}@1`,
            description:
              point === 'send'
                ? 'Present one canonical message through a selected adapter'
                : 'Inspect delivery without repeating it',
            input: deliveryInput,
            output: deliveryResult,
            providePermission: 'channels.adapter',
            consumePermission: 'channels.deliver',
            cardinality: 'one',
          });
        const availability = 'channels.availability@1';
        const status = z.object({ ready:z.boolean(), issue:z.string().max(500).optional() });
        ctx.capabilities.define({
          id: availability, description:'检查此绑定在当前伙伴和回复方式下能否发送',
          input:z.object({personaId:id, conversationId:id, peer:z.string(), isReply:z.boolean()}),
          output:status, providePermission:'channels.adapter', consumePermission:'channels.deliver',
          cardinality:'one',
        });
        ctx.capabilities.provide(deliveryPoint,'channels.outputs','会话通道',async (input,outputSignal)=>{
          if (input.action === 'list') {
            const senders = ctx.capabilities.list('channels.send@1');
            const checks = ctx.capabilities.list(availability);
            const images = ctx.capabilities.list('channels.image-adapters@1');
            const targets = await Promise.all(this.bindings().filter(b => b.conversationId === input.conversationId).map(async binding => {
              const sender = senders.find(p => p.id === binding.adapter);
              const check = checks.find(p => p.id === binding.adapter);
              let eligibility: z.infer<typeof status> = binding.enabled
                ? { ready: sender?.state === 'active' }
                : { ready: false, issue: '通道绑定已停用。' };
              if (eligibility.ready && check) {
                try {
                  eligibility = await providerSnapshot(signal => ctx.capabilities.invoke(availability, binding.adapter, {
                    conversationId:input.conversationId, personaId:input.personaId, peer:binding.peer, isReply:!!input.isReply,
                  }, signal), outputSignal) as z.infer<typeof status>;
                } catch {
                  eligibility = { ready:false, issue:'暂时无法确认渠道发送权限。' };
                }
              }
              return {
                ...eligibility, id:destinationId(binding),
                label:(sender?.label ?? binding.adapter) + ' · ' + binding.peer,
                presentation:'external', style:binding.adapter === 'qq.bot' ? 'external' : binding.adapter,
                supportsImages:images.some(p => p.id === binding.adapter && p.state === 'active'),
                revision:outputRevision(binding),
                legacySources:!binding.enabled ? [] : [...binding.automaticSources, ...(binding.automaticTriggerKinds ?? []).map(kind => 'signal:' + kind),
                  ...(binding.automaticSources.includes('notification') ? ['review'] : [])],
              };
            }));
            return { targets };
          }
          const binding=this.bindings().find(b=>destinationId(b)===input.targetId), envelope=input.envelope;
          if(!binding||!binding.enabled||binding.conversationId!==envelope.conversationId||outputRevision(binding)!==input.revision)return{result:{state:input.action==='inspect'?'unknown':'skipped',reason:'通道绑定已改变。'}};
          const point=input.action==='inspect'?'channels.inspect@1':'channels.send@1';
          if(!ctx.capabilities.list(point).some(p=>p.id===binding.adapter&&p.state==='active'))return{result:{state:input.action==='inspect'?'unknown':'skipped',reason:'通道插件当前不可用。'}};
          const message=envelope.messageId?this.store.message(envelope.messageId):undefined;
          const signal=AbortSignal.any([outputSignal,ctx.signal,this.router.characterSignal(envelope.personaId)]);
          const image=message&&ctx.capabilities.list('channels.image-adapters@1').some(p=>p.id===binding.adapter&&p.state==='active')
            ? await readReplyImage(ctx.capabilities,message.meta.image,signal):undefined;
          const parts = envelope.title && envelope.parts
            ? [envelope.title + '\n' + envelope.parts[0], ...envelope.parts.slice(1)] : envelope.parts;
          const current = this.store.document<Binding>('channel-bindings', binding.id);
          if (!current?.enabled || destinationId(current) !== input.targetId || outputRevision(current) !== input.revision ||
              this.store.conversation(envelope.conversationId)?.personaId !== envelope.personaId ||
              !characterActive(this.store,envelope.personaId))
            return {result:{state:'skipped',reason:'通道绑定或伙伴权限已改变。'}};
          const result=await ctx.capabilities.invoke(point,binding.adapter,{conversationId:envelope.conversationId,peer:binding.peer,
            text:[envelope.title,envelope.text].filter(Boolean).join('\n'),messageId:envelope.messageId??envelope.id,
            replyTo:envelope.plan.replyTo,idempotencyKey:input.idempotencyKey,image,
            textMode:parts ? binding.textMode : 'combined',parts},signal);
          return{result};
        });
        const op = operations(ctx, 'channels');
        op(
          'list',
          'Bindings, discovered peers and delivery receipts',
          z.object({ before: id.optional(), limit: z.number().int().min(1).max(200).default(200) }),
          'channels.read',
          (v) => ({
            bindings: this.bindings(),
            peers: this.store.documents('channel-peers'),
            deliveries: this.store
              .documentHistory<any>('channel-outbound', 'createdAt', v.limit, v.before, true)
              .map(({ payload, receipt, ...row }) => ({
                ...row,
                receiptAvailable: receipt !== undefined,
              })),
            adapters: ctx.capabilities.list('channels.send@1'),
            triggerSources: this.triggerActions
              .sources()
              .filter((source) => hasScopedSignalKey(source.id)),
          }),
        );
        op(
          'bind',
          'Bind exactly one external peer to one conversation',
          bindingSchema,
          'channels.write',
          (v) => {
            invariant(
              v.automaticTriggerKinds.every(hasScopedSignalKey),
              'channel_source',
              '内建来源的投递范围由专用选项管理。',
            );
            invariant(
              this.store.conversation(v.conversationId),
              'missing_conversation',
              'Conversation not found',
            );
            invariant(
              !this.bindings().some(
                (b) =>
                  b.id !== v.id &&
                  b.enabled &&
                  v.enabled &&
                  b.adapter === v.adapter &&
                  b.peer === v.peer,
              ),
              'channel_ambiguous',
              'This external peer already has an active binding',
            );
            const previous = v.id ? this.store.document<Binding>('channel-bindings', v.id) : undefined;
            const textMode = v.textMode ?? (previous && previous.adapter === v.adapter ? previous.textMode : undefined);
            const changedRecipient = previous && (previous.adapter !== v.adapter || previous.peer !== v.peer ||
              previous.conversationId !== v.conversationId);
            const recipientKey = changedRecipient ? randomUUID() : previous?.recipientKey;
            const row = { ...v, textMode, id: v.id ?? randomUUID(), ...(recipientKey && { recipientKey }) };
            this.store.put('channel-bindings', row.id, row);
            this.events.emit('channels.updated', {});
            return row;
          },
          false,
        );
        op(
          'unbind',
          '解除通道对接，保留历史投递回执',
          z.object({ id, confirmed: z.literal(true) }),
          'channels.write',
          (v) => {
            const pending = this.store
              .documents<any>('channel-outbound')
              .some(
                (row) =>
                  row.bindingId === v.id && ['sending', 'queued', 'unknown'].includes(row.state),
              );
            invariant(
              !pending,
              'delivery_unresolved',
              '请先核对仍在投递或结果未知的回执，再解除绑定。',
            );
            this.store.remove('channel-bindings', v.id);
            this.events.emit('channels.updated', {});
            return { removed: true };
          },
          false,
        );
        ctx.registry.register({
          name: 'channels.receive',
          owner: 'channels',
          description: 'Receive attributed input from its adapter',
          permission: 'channels.receive',
          mcp: false,
          input: z.object({
            adapter: z.string(),
            peer: z.string(),
            remoteMessageId: z.string().min(1).max(300),
            text: z.string().trim().min(1).max(100000),
            sentAt: z.iso.datetime({ offset: true }).optional(),
            sender: z.string().trim().min(1).max(160).optional(),
          }),
          output: z.unknown(),
          run: (v, c) => this.receive(v, c.pluginId),
        });
        op(
          'inspect',
          'Inspect a channel receipt',
          z.object({ id }),
          'channels.read',
          async (v, s) => {
            const row = this.store.document<any>('channel-outbound', v.id);
            invariant(row, 'delivery_missing', 'Delivery not found');
            const result = deliveryResult.parse(
              await ctx.capabilities.invoke('channels.inspect@1', row.adapter, row.payload, s),
            );
            this.store.put('channel-outbound', row.id, { ...row, ...result });
            return { ...row, ...result };
          },
          false,
        );
        op(
          'retry',
          'Retry only an explicitly failed delivery, never an unknown one',
          z.object({ id, confirmed: z.literal(true) }),
          'channels.write',
          (v) => {
            const row = this.store.document<any>('channel-outbound', v.id),
              binding = this.bindings().find((b) => b.id === row?.bindingId),
              message = this.store.message(row?.messageId ?? '');
            invariant(
              row?.state === 'failed' && binding && message,
              'delivery_state',
              'Only a definite failure can be retried',
            );
            this.store.put('channel-outbound', row.id, { ...row, state: 'pending' });
            return this.deliverPending(row.id);
          },
          false,
        );
        ctx.dispose(
          this.events.subscribe((e) => {
            if (e.type === 'run.completed' || e.type === 'message.posted' ||
                (e.type === 'system.maintenance' && e.data.paused === false)) this.flush();
          }),
        );
        ctx.capabilities.subscribe(() => this.flush());
        queueMicrotask(() => this.flush());
      },
    };
  }
}
