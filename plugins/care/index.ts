import { characterFeature, characterEnabled } from '../../packages/kernel/characters.ts';
import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ownPersona } from '../../packages/kernel/resource-access.ts';
import { id, invariant, observationSilence } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Router } from '../../packages/kernel/router.ts';
import { Events } from '../../packages/kernel/events.ts';
import { contributeAutomation } from '../../packages/kernel/automation.ts';
import { Clock } from '../../packages/kernel/clock.ts';
import type { Plugin, PluginContext } from '../../packages/kernel/registry.ts';
import { operations } from '../shared.ts';
import { config, calendar, decide, opportunity, type Rule, type Decision } from './policy.ts';
import { localTime, localDay, configuredTimezone } from '../../packages/kernel/time.ts';
import { contributeSignal, type TriggerActions } from '../../packages/kernel/trigger-actions.ts';
export class Care {
  private ctx?: PluginContext;
  private running = new Map<string, { id: string; controller: AbortController }>();
  constructor(
    readonly store: Store,
    readonly router: Router,
    readonly events: Events,
    readonly clock: Clock,
    readonly triggerActions: TriggerActions,
    readonly random: () => number = Math.random,
  ) {}
  rules() {
    const saved = this.store.get<Rule[] | null>('care.rules', null);
    if (saved) return saved.map((rule) => config.parse(rule));
    const legacy = config.parse(this.store.get('care.config', {}));
    return legacy.conversationId ? [legacy] : [];
  }
  private setRules(rules: Rule[]) {
    this.store.set('care.rules', rules);
    this.schedule();
    this.events.emit('automation.changed', { owner: 'care' });
  }
  saveRule(ruleId: string, settings: Record<string, unknown>) {
    const rule = config.parse({ ...settings, id: ruleId });
    invariant(rule.hourStart < rule.hourEnd, 'care_hours', '结束时段须晚于开始时段。');
    new Intl.DateTimeFormat('en', { timeZone: rule.timezone });
    invariant(
      this.store.conversation(rule.conversationId),
      'conversation_missing',
      '请选择有效会话。',
    );
    const rules = this.rules();
    invariant(
      rules.length < 50 || rules.some((old) => old.id === ruleId),
      'care_limit',
      '主动交流规则已达上限。',
    );
    this.abortRule(ruleId);
    this.setRules([...rules.filter((old) => old.id !== ruleId), rule]);
  }
  private abortRule(ruleId: string) {
    for (const running of this.running.values())
      if (running.id === ruleId) running.controller.abort();
  }
  private schedule() {
    this.clock.cancel('care.check');
    if (this.ctx && this.rules().some((rule) => rule.enabled && characterEnabled(this.store, this.store.conversation(rule.conversationId)?.personaId ?? '', 'care')))
      this.clock.at('care.check', Date.now() + 60000, async () => {
        try {
          await this.tick();
        } finally {
          this.schedule();
        }
      });
  }
  async tick(now = Date.now()) {
    const rules = this.rules().filter((rule) => rule.enabled && calendar(rule, now).allowed);
    const byConversation = new Map<string, Rule[]>();
    for (const rule of rules) {
      const group = byConversation.get(rule.conversationId) ?? [];
      group.push(rule);
      byConversation.set(rule.conversationId, group);
    }
    let result: any = { skipped: 'disabled' };
    // Process admissions sequentially so global quiet/busy checks cannot race each other.
    for (const group of byConversation.values()) {
      const ordered = group
        .map((rule) => ({
          rule,
          last: this.store.get<Decision | null>('care.decision.' + rule.id, null)?.at ?? '',
        }))
        .sort((a, b) => a.last.localeCompare(b.last) || a.rule.id.localeCompare(b.rule.id));
      for (const { rule } of ordered) {
        result = await this.tickRule(rule, now, Math.max(...group.map((r) => r.minMinutes)));
        if (result?.id || result?.failed) break;
      }
    }
    return result;
  }
  async checkOnce(ruleId: string, requestId: string, now = Date.now()) {
    const rule = this.rules().find((rule) => rule.id === ruleId);
    invariant(rule, 'care_missing', '主动交流任务不存在。');
    const key =
      'care-' +
      rule.id +
      '-manual-' +
      createHash('sha256').update(requestId).digest('hex').slice(0, 24);
    const previous = this.store.run(key);
    if (previous) {
      invariant(
        previous.source === 'care' &&
          previous.conversationId === rule.conversationId &&
          previous.meta.localOnly,
        'idempotency_conflict',
        '检查编号已用于其他任务。',
      );
      return previous;
    }
    if (!rule.enabled) return { skipped: 'disabled' };
    if (!calendar(rule, now).allowed) return { skipped: 'outside_hours' };
    const cooldown = Math.max(
      ...this.rules()
        .filter((item) => item.enabled && item.conversationId === rule.conversationId)
        .map((item) => item.minMinutes),
    );
    return this.tickRule(rule, now, cooldown, key);
  }
  private scope(rule: Rule) {
    const origin = this.store.conversation(rule.conversationId);
    return this.store
      .conversations()
      .filter(
        (c) =>
          rule.busyScope === 'all' ||
          (rule.busyScope === 'character'
            ? c.personaId === origin?.personaId
            : c.id === rule.conversationId),
      )
      .map((c) => c.id);
  }
  private activity(rule: Rule, now: number) {
    const ids = this.scope(rule);
    if (ids.some((id) => this.triggerActions.blocked(id))) return 'busy';
    const human = this.store.latestHumanAt(rule.busyScope === 'all' ? undefined : ids);
    return human && now - Date.parse(human) < rule.humanQuietMinutes * 60000
      ? 'human_active'
      : undefined;
  }
  private async tickRule(rule: Rule, now: number, cooldown: number, manualRequestId?: string) {
    const ctx = this.ctx;
    const conversation = this.store.conversation(rule.conversationId);
    if (
      !ctx ||
      !conversation ||
      !characterEnabled(this.store, conversation.personaId, 'care') ||
      this.running.has(conversation.id)
    )
      return { skipped: 'busy' };
    const day = calendar(rule, now).day,
      key = 'care.decision.' + rule.id,
      old = this.store.get<Decision | null>(key, null);
    const state: Decision =
      old?.day === day
        ? old
        : {
            day,
            eligibleChecks: 0,
            attempts: this.store
              .sourceRunsSince('care', new Date(localTime(day, 0, 0, rule.timezone)).toISOString())
              .filter(
                (run) =>
                  run.source === 'care' &&
                  run.requestId.startsWith('care-' + rule.id + '-') &&
                  localDay(new Date(run.createdAt), rule.timezone) === day,
              ).length,
          };
    if (manualRequestId && state.attempts >= rule.dailyMax) return { skipped: 'daily_limit' };
    if (!manualRequestId && rule.mode === 'opportunities') {
      state.reason = opportunity(rule, state, now, this.random);
      state.at = new Date(now).toISOString();
      this.store.set(key, state);
      if (state.reason !== 'selected') return { skipped: state.reason };
    }
    const last = this.store.get<number>('care.lastAttempt.' + conversation.id, 0);
    if (now - last < cooldown * 60000) return { skipped: 'quiet_or_cooldown' };
    const activity = this.activity(rule, now);
    if (activity) return { skipped: activity };
    const slot = Math.floor(now / (rule.checkMinutes * 60000));
    if (!manualRequestId && state.lastSlot === slot) return { skipped: 'already_checked' };
    const controller = new AbortController();
    this.running.set(conversation.id, { id: rule.id, controller });
    const signal = AbortSignal.any([ctx.signal, controller.signal, this.router.characterSignal(conversation.personaId)]);
    try {
      const blocked = async () => {
        for (const p of ctx.capabilities
          .list('care.blockers@1')
          .filter(
            (p) => p.state === 'active' && (!rule.blockerIds || rule.blockerIds.includes(p.id)),
          )) {
          const result = (await ctx.capabilities.invoke(
            'care.blockers@1',
            p.id,
            {
              conversationId: conversation.id,
              personaId: conversation.personaId,
              scope: rule.busyScope,
            },
            signal,
          )) as { blocked: boolean };
          if (result.blocked) return p.id;
        }
      };
      const blocker = await blocked();
      if (blocker) return { skipped: blocker };
      if (!manualRequestId) state.lastSlot = slot;
      state.at = new Date(now).toISOString();
      state.reason =
        manualRequestId || rule.mode === 'opportunities'
          ? 'selected'
          : decide(rule, state, this.random);
      this.store.set(key, state);
      if (state.reason !== 'selected')
        return { skipped: state.reason, chance: state.chance, budget: state.budget };
      const context: string[] = [];
      const active = new Set(
        ctx.capabilities
          .list('care.context@1')
          .filter((provider) => provider.state === 'active')
          .map((provider) => provider.id),
      );
      for (const providerId of new Set(rule.contextIds)) {
        if (!active.has(providerId)) continue;
        const result = (await ctx.capabilities.invoke(
          'care.context@1',
          providerId,
          { personaId: conversation.personaId },
          signal,
        )) as { text: string };
        if (result.text) context.push(result.text);
      }
      signal.throwIfAborted();
      const late = this.activity(rule, now) ?? (await blocked());
      if (late) {
        this.store.set(key, { ...state, reason: late });
        return { skipped: late };
      }
      state.attempts++;
      state.reason = 'attempted';
      this.store.set(key, state);
      this.store.set('care.lastAttempt.' + conversation.id, now);
      const dispatch = await this.triggerActions.dispatch(
        {
          action: 'conversation',
          kind: 'care.opportunity',
          conversationId: conversation.id,
          requestId: manualRequestId ?? 'care-' + rule.id + '-' + Math.floor(now / 60000),
          bubble: true,
          outputTargets: rule.outputTargets, task: {type:'care.rules',id:rule.id},
          ...(manualRequestId ? { localOnly: true } : {}),
          text: [
            '这是应用发起的主动交流机会，不是使用者的新发言。沿用当前会话的角色、记忆和关系。',
            rule.prompt,
            ...context,
            `想安静时只输出 ${observationSilence}。其他时候直接给出要说的话，交由会话渠道投递。`,
          ].join('\n\n'),
        },
        'care',
        signal,
      );
      if (dispatch.state !== 'executed') return { skipped: dispatch.state };
      const result = dispatch.run;
      this.store.set('care.result.' + rule.id, {
        at: new Date().toISOString(),
        failed: result.state !== 'succeeded',
        message: result.error,
      });
      return result;
    } catch (error) {
      if (!signal.aborted)
        this.store.set('care.result.' + rule.id, {
          at: new Date().toISOString(),
          failed: true,
          message: error instanceof Error ? error.message.slice(0, 500) : '主动交流未完成',
        });
      return { failed: true };
    } finally {
      this.running.delete(conversation.id);
      this.events.emit('automation.changed', { owner: 'care' });
    }
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(packageManifest),
      references: (id) =>
        this.rules()
          .filter((task) => task.conversationId === id)
          .map((task) => ({
            label: task.name,
            page: 'automation',
            role: 'trigger',
            enabled: task.enabled,
            type: 'care.rules',
            taskId: task.id,
          })),
      character: characterFeature(this.store, 'care', z.object({}), [], ['care.rules']),
      activate: (ctx) => {
        contributeSignal(ctx, 'care.opportunity', '主动交流机会', 'conversation');
        this.ctx = ctx;
        ctx.capabilities.define({
          id: 'care.context@1',
          description: '主动交流的可选角色状态背景',
          input: z.object({ personaId: id }),
          output: z.object({ text: z.string().max(20000) }),
          providePermission: 'care.context',
          consumePermission: 'care.read',
          cardinality: 'many',
        });
        ctx.capabilities.define({
          id: 'care.blockers@1',
          description: '可选主动交流抑制信号',
          input: z.object({
            conversationId: z.string(),
            personaId: z.string().optional(),
            scope: z.enum(['all', 'character', 'conversation']).default('conversation'),
          }),
          output: z.object({ blocked: z.boolean(), reason: z.string().optional() }),
          providePermission: 'care.block',
          consumePermission: 'care.read',
          cardinality: 'many',
        });
        const op = operations(ctx, 'care');
        op(
          'check',
          '按现有避让规则手动检查一次主动交流，仅在本机展示',
          z.object({ ruleId: id, requestId: id }),
          'care.write',
          (v, _signal, caller) => {
            const rule = this.rules().find((rule) => rule.id === v.ruleId);
            invariant(rule, 'care_missing', '主动交流任务不存在。');
            const chat = this.store.conversation(rule.conversationId);
            invariant(chat, 'conversation_missing', '目标会话不存在。');
            ownPersona(caller, chat.personaId);
            return this.checkOnce(v.ruleId, v.requestId);
          },
          false,
        );
        const visibleRules = (personaId?: string) =>
          this.rules().filter(
            (rule) =>
              !personaId || this.store.conversation(rule.conversationId)?.personaId === personaId,
          );
        op('status', '读取主动交流状态与近期执行', z.object({}), 'care.read', (_v, _s, caller) => ({
          rules: visibleRules(caller.personaId),
          decisions: visibleRules(caller.personaId).map((rule) => ({
            ruleId: rule.id,
            ...this.store.get('care.decision.' + rule.id, {}),
          })),
          runs: this.store
            .runs()
            .filter(
              (r) =>
                r.source === 'care' &&
                (!caller.personaId ||
                  this.store.conversation(r.conversationId)?.personaId === caller.personaId),
            )
            .slice(-30),
        }));
        contributeAutomation(ctx, 'care.rules', '主动交流', {
          describe: () => ({
            scope: 'character',
            defaults: {
              ...config.parse({ timezone: configuredTimezone(this.store) }),
              outputTargets:['core.chat','avatar.bubble'],
              blockerIds: ctx.capabilities
                .list('care.blockers@1')
                .filter((p) => p.state === 'active')
                .map((p) => p.id),
            },
            fields: [
              {key:'outputTargets',label:'输出位置',kind:'outputs',outputSource:'care',legacyBubble:true,portability:'resource'},
              {
                key: 'conversationId',
                label: '目标会话',
                kind: 'select',
                options: this.store.conversations().map((c) => ({ value: c.id, label: c.title })),
              },
              { key: 'dailyMax', label: '每天最多尝试开口次数', kind: 'number', min: 0, max: 20 },
              {
                key: 'blockerIds', portability: 'value',
                label: '避让条件',
                kind: 'multi',
                options: ctx.capabilities
                  .list('care.blockers@1')
                  .filter((p) => p.state === 'active')
                  .map((p) => ({ value: p.id, label: p.label, owner: p.owner })),
              },
              {
                key: 'minMinutes',
                label: '最短发言间隔（分钟）',
                kind: 'number',
                min: 5,
                max: 1440,
              },
              {
                key: 'humanQuietMinutes',
                label: '用户静默时长（分钟）',
                kind: 'number',
                min: 1,
                max: 1440,
              },
              {
                key: 'busyScope', portability: 'value',
                label: '对话与观察避让范围',
                kind: 'select',
                options: [
                  { value: 'all', label: '所有 Echo 会话与观察' },
                  { value: 'character', label: '当前角色' },
                  { value: 'conversation', label: '目标会话' },
                ],
              },
              { key: 'timezone', portability: 'value', label: '时区', kind: 'text' },
              { key: 'hourStart', label: '开始小时', kind: 'number', min: 0, max: 23 },
              { key: 'hourEnd', label: '结束小时', kind: 'number', min: 1, max: 24 },
              {
                key: 'contextIds', portability: 'value',
                label: '主动交流背景来源',
                kind: 'multi',
                options: ctx.capabilities
                  .list('care.context@1')
                  .filter((p) => p.state === 'active')
                  .map((p) => ({ value: p.id, label: p.label })),
              },
              { key: 'prompt', label: '主动交流提示词', kind: 'textarea' },
            ],
            items: this.rules().map((rule) => {
              const result = this.store.get<{ at?: string; failed?: boolean }>(
                'care.result.' + rule.id,
                {},
              );
              const chat = this.store.conversation(rule.conversationId);
              return {
                id: rule.id,
                name: rule.name,
                enabled: rule.enabled,
                subject: chat?.title,
                personaId: chat?.personaId,
                state: !chat
                  ? 'unavailable'
                  : !rule.enabled
                    ? 'paused'
                    : this.running.get(chat.id)?.id === rule.id
                      ? 'running'
                      : result.failed
                        ? 'failed'
                        : 'waiting',
                lastAt: result.at,
                persistedSettings: rule,
                settings: {
                  ...rule,
                  mode: 'opportunities',
                  blockerIds:
                    rule.blockerIds ??
                    ctx.capabilities
                      .list('care.blockers@1')
                      .filter((p) => p.state === 'active')
                      .map((p) => p.id),
                },
              };
            }),
          }),
          save: (id, settings) => this.saveRule(id, settings),
          remove: (id) => {
            this.abortRule(id);
            this.setRules(this.rules().filter((rule) => rule.id !== id));
          },
        });
        if (this.store.get('care.config', null) && !this.store.get('care.rules', null)) {
          const migrated = this.rules();
          if (migrated.length) this.store.set('care.rules', migrated);
        }
        if (!this.store.get('care.opportunities.v1', false)) {
          const rules = this.rules();
          if (rules.length)
            this.store.set(
              'care.rules',
              rules.map((rule) => ({ ...rule, mode: 'opportunities' })),
            );
          this.store.set('care.opportunities.v1', true);
        }
        this.schedule();
        ctx.dispose(this.events.subscribe(event => {
          if (event.type === 'character.activity.changed') this.schedule();
        }));
        ctx.dispose(() => {
          this.ctx = undefined;
          for (const running of this.running.values()) running.controller.abort();
          this.clock.cancel('care.check');
        });
      },
    };
  }
}
