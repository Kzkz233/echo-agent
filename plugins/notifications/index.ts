import { deliveryPoint } from '../../packages/contracts/delivery.ts';
import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Events } from '../../packages/kernel/events.ts';
import type { Plugin, PluginContext } from '../../packages/kernel/registry.ts';
import { operations } from '../shared.ts';
import { Router } from '../../packages/kernel/router.ts';
const notification = z.object({
  id,
  title: z.string().max(160),
  text: z.string().max(30000),
  conversationId: z.string().optional(),
  bubble: z.boolean().default(false),
  triggerKind: id.optional(),
});
type Notice = z.infer<typeof notification> & { createdAt: string; state: 'pending' | 'read' };
export class Notifications {
  private ctx?: PluginContext;
  constructor(
    readonly store: Store,
    readonly events: Events,
    readonly router: Router,
  ) {}
  publish(value: unknown) {
    const v = notification.parse(value),
      old = this.store.document<Notice>('notifications', v.id);
    if (old) {
      invariant(
        old.title === v.title &&
          old.text === v.text &&
          old.conversationId === v.conversationId &&
          old.bubble === v.bubble &&
          (!old.triggerKind || old.triggerKind === v.triggerKind),
        'notification_conflict',
        '同编号通知内容不一致',
      );
      return old;
    }
    const row: Notice = { ...v, createdAt: new Date().toISOString(), state: 'pending' };
    if (v.conversationId)
      this.router.notice({
        conversationId: v.conversationId,
        requestId: 'notification.' + v.id,
        title: v.title,
        text: v.text,
        bubble: v.bubble,
        triggerKind: v.triggerKind,
      });
    this.store.put('notifications', v.id, row);
    this.events.emit('notification.created', { id: v.id });
    return row;
  }
  async deliver(id: string, provider: string, signal: AbortSignal) {
    invariant(this.ctx, 'plugin_disabled', '通知插件未启用');
    const row = this.store.document<Notice>('notifications', id);
    invariant(row, 'notification_missing', '通知不存在');
    const key = 'notification.' + id + '.' + provider,
      old = this.store.receipt(key);
    if (old) return old;
    const receipt = {
      id: key,
      kind: 'notification',
      noticeId: id,
      provider,
      state: 'sending',
      createdAt: new Date().toISOString(),
    };
    this.store.saveReceipt(key, receipt);
    try {
      const result = (await this.ctx.capabilities.invoke(
        'notifications.channels@1',
        provider,
        { notice: row, idempotencyKey: key },
        signal,
      )) as any;
      this.store.saveReceipt(key, { ...receipt, ...result });
    } catch {
      this.store.saveReceipt(key, { ...receipt, state: 'unknown' });
    }
    return this.store.receipt(key);
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(packageManifest),
      activate: (ctx) => {
        this.ctx = ctx;
        ctx.capabilities.provide(deliveryPoint,'notifications.outputs','通知收件箱',input=>{
          if(input.action==='list')return{targets:[{id:'notifications.inbox',label:'通知收件箱',revision:'1',portable:true,legacySources:['review','notification','notice']}]};
          const e=input.envelope;
          if(input.action==='deliver')this.publish({id:'output.'+e.id,title:e.title??'任务结果',text:e.text});
          return{result:{state:this.store.document('notifications','output.'+e.id)?'delivered':'unknown'}};
        });
        ctx.capabilities.define({
          id: 'notifications.publish@1',
          description: 'Idempotent inbox and optional conversation notice publication',
          input: notification,
          output: z.object({ accepted: z.boolean() }),
          providePermission: 'notifications.channel',
          consumePermission: 'notifications.write',
          cardinality: 'one',
        });
        ctx.capabilities.provide(
          'notifications.publish@1',
          'notifications.inbox',
          'Notification inbox',
          (input) => {
            this.publish(input);
            return { accepted: true };
          },
        );
        ctx.capabilities.provide(
          'review.reports@1',
          'notifications.review',
          'Review report inbox and conversation',
          (input) => {
            this.publish({ ...input, bubble: true });
            return { accepted: true };
          },
        );
        ctx.capabilities.provide(
          'agenda.reminders@1',
          'notifications.agenda',
          'Notification inbox and optional conversation',
          (notice) => {
            this.publish({
              id: 'agenda.' + notice.id,
              title: notice.title,
              text: notice.text,
              conversationId: notice.conversationId || undefined,
              bubble: !!notice.conversationId,
            });
            return { accepted: true };
          },
        );
        ctx.dispose(() => {
          this.ctx = undefined;
        });
        ctx.capabilities.define({
          id: 'notifications.channels@1',
          description: '可选通知投递渠道',
          input: z.object({
            notice: notification.extend({ createdAt: z.string(), state: z.string() }),
            idempotencyKey: z.string(),
          }),
          output: z.object({
            state: z.enum(['queued', 'delivered', 'unknown', 'skipped']),
            receipt: z.string().optional(),
          }),
          providePermission: 'notifications.channel',
          consumePermission: 'notifications.deliver',
          cardinality: 'many',
        });
        const op = operations(ctx, 'notifications');
        op('list', '通知收件箱与渠道', z.object({}), 'notifications.read', () => ({
          items: this.store.documents('notifications'),
          channels: ctx.capabilities.list('notifications.channels@1'),
        }));
        op('publish', '按编号发布程序化通知', notification, 'notifications.write', (v) =>
          this.publish(v),
        );
        op('read', '标记已读', z.object({ id }), 'notifications.write', (v) => {
          const old = this.store.document<Notice>('notifications', v.id);
          invariant(old, 'notification_missing', '通知不存在');
          this.store.put('notifications', v.id, { ...old, state: 'read' });
          return { read: true };
        });
        op(
          'deliver',
          '明确投递到所选渠道',
          z.object({ id, provider: z.string() }),
          'notifications.deliver',
          (v, s) => this.deliver(v.id, v.provider, s),
          false,
        );
      },
    };
  }
}
