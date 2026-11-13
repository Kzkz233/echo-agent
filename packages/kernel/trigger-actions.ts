import { outputTargets, outputTask, deliveryPlan } from '../contracts/delivery.ts';
import type { Deliveries } from './delivery.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, invariant, reasoning } from '../contracts/index.ts';
import type { Capabilities } from './capabilities.ts';
import type { PluginContext } from './registry.ts';
import type { Router } from './router.ts';
import type { Automation } from './automation.ts';

const point = 'core.automation.signals@1';
const descriptor = z.object({
  action: z.enum(['conversation', 'notice', 'either']),
});
const nextPoint = 'core.automation.signals@2';
const nextDescriptor = z.object({ action: z.enum(['conversation', 'notice', 'either', 'task']) });
export const triggerAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('task'),
    kind: id,
    requestId: id,
    type: id,
    taskId: id,
    expiresAt: z.number().optional(),
  }),
  z.object({
    action: z.literal('conversation'),
    delivery: deliveryPlan.optional(),
    recordOnly: z.boolean().default(false),
    reportPrompt: z.string().max(10000).optional(),
    resultContext: z.object({ workSessionId: id.optional(), evidenceIds: z.array(z.string().max(512)).max(100).optional(), reviewable: z.boolean().optional() }).optional(),
    messageSource: z.enum(['observation', 'care', 'review', 'trigger', 'handoff']).optional(),
    kind: id,
    requestId: id,
    conversationId: id,
    text: z.string().min(1),
    bubble: z.boolean().default(false),
    outputTargets: outputTargets.optional(),
    task: outputTask.optional(),
    localOnly: z.boolean().optional(),
    reasoning: reasoning.optional(),
    expiresAt: z.number().optional(),
  }),
  z.object({
    action: z.literal('notice'),
    delivery: deliveryPlan.optional(),
    kind: id,
    requestId: id,
    conversationId: id.optional(),
    text: z.string().min(1),
    title: z.string().max(160),
    bubble: z.boolean().default(false),
    outputTargets: outputTargets.optional(),
    task: outputTask.optional(),
    expiresAt: z.number().optional(),
  }),
]);
type TriggerAction = z.input<typeof triggerAction>;
type Scope = ReturnType<Capabilities['forOwner']>;
const builtInSignals = new Set([
  'observation.interesting',
  'care.opportunity',
  'mail-triggers.arrived',
]);
export function isAdditionalSignal(kind: unknown): kind is string {
  return typeof kind === 'string' && !builtInSignals.has(kind);
}

export function contributeSignal(
  ctx: PluginContext,
  kind: string,
  label: string,
  action: z.infer<typeof nextDescriptor>['action'],
) {
  ctx.capabilities.provide(nextPoint, kind, label, () => ({ action }));
}

export class TriggerActions {
  constructor(
    readonly scope: Scope,
    readonly router: Router,
    readonly automation?: Automation,
    readonly deliveries?: Deliveries,
  ) {
    scope.define({
      id: point,
      description: '自动化任务可以提交的信号来源',
      input: z.object({}),
      output: descriptor,
      providePermission: 'automation.contribute',
      consumePermission: 'automation.invoke',
      cardinality: 'many',
    });
    scope.define({
      id: nextPoint,
      description: '统一的会话、通知与任务触发来源',
      input: z.object({}),
      output: nextDescriptor,
      providePermission: 'automation.contribute',
      consumePermission: 'automation.invoke',
      cardinality: 'many',
    });
  }
  sources() {
    return [...this.scope.list(nextPoint), ...this.scope.list(point)].filter(
      (source, index, all) =>
        source.state === 'active' &&
        all.findIndex((s) => s.id === source.id && s.state === 'active') === index,
    );
  }
  blocked(conversationId: string) {
    return (
      this.router.isBusy(conversationId) ||
      this.router.store.unresolved(conversationId).length > 0 ||
      !!this.router.store.queuedInput(conversationId)
    );
  }
  async dispatch(raw: TriggerAction, owner: string, signal: AbortSignal) {
    const input = triggerAction.parse(raw);
    const source = this.sources().find((item) => item.id === input.kind && item.owner === owner);
    invariant(source, 'trigger_source', '触发来源未注册或已停用。');
    const type = nextDescriptor.parse(await this.scope.invoke(source.point, source.id, {}, signal));
    invariant(
      type.action === 'either' || type.action === input.action,
      'trigger_action',
      '此来源没有注册该动作。',
    );
    signal.throwIfAborted();
    if (input.expiresAt !== undefined && input.expiresAt <= Date.now())
      return { state: 'expired' as const };
    if (input.action === 'task') {
      invariant(this.automation, 'automation_unavailable', '任务执行入口不可用。');
      const target = this.scope
        .list('core.automation.types@1')
        .find((t) => t.id === input.type && t.state === 'active');
      invariant(
        target?.owner === owner,
        'trigger_task_owner',
        '触发器只能执行本插件登记的任务类型。跨插件任务需通过明确授权的委派接口。',
      );
      await this.automation.mutate(
        input.type,
        { action: 'run', id: input.taskId, requestId: input.requestId },
        signal,
      );
      return { state: 'accepted' as const };
    }
    const requestId = isAdditionalSignal(source.id)
      ? 'trigger-' +
        createHash('sha256')
          .update(JSON.stringify([owner, input.kind, input.requestId]))
          .digest('hex')
      : input.requestId;
    if (input.action === 'notice') {
      if (input.conversationId) await this.router.taskResults.submit({
        id: requestId + '.record', conversationId: input.conversationId, text: input.title + '\n' + input.text,
        source: owner === 'review' ? 'review' : 'trigger', task: source.label.slice(0, 160), report: false,
      }, signal);
      if (this.deliveries && input.conversationId) {
        const conversation=this.router.store.conversation(input.conversationId);
        invariant(conversation,'missing_conversation','通知会话不存在。');
        const plan=input.delivery ?? await this.deliveries.plan(input.conversationId,owner==='review'?'review':'notification',input.outputTargets,{bubble:input.bubble,task:input.task,legacySources:[owner==='review'?'review':isAdditionalSignal(input.kind)?'signal:'+input.kind:'notification','notice']},signal);
        await this.deliveries.publish({id:requestId,personaId:conversation.personaId,conversationId:conversation.id,title:input.title,text:input.text,plan},signal);
      } else await this.scope.invoke('notifications.publish@1','notifications.inbox',{
        id:requestId,title:input.title,text:input.text,conversationId:input.conversationId,bubble:input.bubble,triggerKind:input.kind,
      },signal);
      return { state: 'published' as const };
    }
    const previous = this.router.store.run(requestId);
    const messageSource =
      input.messageSource ?? (owner === 'observation' ? 'observation' : owner === 'care' ? 'care' : 'trigger');
    const plan=previous?.meta.delivery ?? input.delivery ?? await this.deliveries?.plan(input.conversationId,messageSource,input.outputTargets,{bubble:input.bubble,localOnly:input.localOnly,task:input.task,legacySources:[isAdditionalSignal(input.kind)?'signal:'+input.kind:messageSource]},signal);
    return this.router.taskResults.submit({ id: requestId, conversationId: input.conversationId,
      text: input.text, source: messageSource, task: source.label.slice(0, 160),
      report: !input.recordOnly, reportPrompt: input.reportPrompt, delivery: plan as any,
      context: input.resultContext,
      reasoning: input.reasoning, expiresAt: input.expiresAt,
      bubble: input.bubble, localOnly: input.localOnly, triggerKind: input.kind }, signal);
  }
}
