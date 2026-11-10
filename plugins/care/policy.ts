import { outputTargets } from '../../packages/contracts/delivery.ts';
import { z } from 'zod';
import { id } from '../../packages/contracts/index.ts';
import { localDay, localTime } from '../../packages/kernel/time.ts';
export const config = z.object({
  outputTargets: outputTargets.optional(),
  id: id.default('default'),
  name: z.string().trim().min(1).max(80).default('主动交流'),
  enabled: z.boolean().default(false),
  conversationId: z.string().default(''),
  checkMinutes: z.number().int().min(5).max(1440).default(30),
  mode: z.enum(['opportunities', 'daily-budget', 'probability']).default('opportunities'),
  probability: z.number().min(0).max(100).default(10),
  dailyMax: z.number().int().min(0).max(20).default(3),
  weight0: z.number().min(0).max(100).default(10),
  weight1: z.number().min(0).max(100).default(35),
  weight2: z.number().min(0).max(100).default(35),
  weight3: z.number().min(0).max(100).default(20),
  minMinutes: z.number().int().min(5).max(1440).default(60),
  contextIds: z.array(id).max(30).default(['reflections.current']),
  blockerIds: z.array(id).max(100).optional(),
  humanQuietMinutes: z.number().int().min(1).max(1440).default(10),
  busyScope: z.enum(['all', 'character', 'conversation']).default('all'),
  hourStart: z.number().int().min(0).max(23).default(8),
  hourEnd: z.number().int().min(1).max(24).default(23),
  timezone: z.string().default('Asia/Shanghai'),
  prompt: z
    .string()
    .max(10000)
    .default(
      '结合近期交流和角色在意的事，自然地说一句想说的话。可以表达惦念、好奇或想接着聊的内容，不把关注点逐条汇报或当作催办事项。没有想说的话可以保持沉默。最多100字。',
    ),
});
export type Rule = z.infer<typeof config>;
export type Decision = {
  mode?: Rule['mode'];
  day: string;
  budget?: number;
  attempts: number;
  eligibleChecks: number;
  lastSlot?: number;
  at?: string;
  reason?: string;
  chance?: number;
  opportunities?: number[];
  checkedOpportunity?: number;
  plan?: string;
};
export function calendar(rule: Rule, now: number) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: rule.timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
  return {
    day: localDay(new Date(now), rule.timezone),
    allowed: hour >= rule.hourStart && hour < rule.hourEnd,
  };
}
export function drawBudget(rule: Rule, random: () => number) {
  const weights = [rule.weight0, rule.weight1, rule.weight2, rule.weight3],
    total = weights.reduce((a, b) => a + b, 0);
  let roll = random() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return Math.min(i, rule.dailyMax);
  }
  return Math.min(3, rule.dailyMax);
}
export function decide(rule: Rule, state: Decision, random: () => number) {
  if (state.mode && state.mode !== rule.mode) state.budget = undefined;
  state.mode = rule.mode;
  if (rule.mode === 'probability') state.budget = rule.dailyMax;
  state.budget ??= rule.mode === 'daily-budget' ? drawBudget(rule, random) : rule.dailyMax;
  const remaining = Math.max(0, Math.min(state.budget, rule.dailyMax) - state.attempts);
  const slots = Math.max(1, Math.ceil(((rule.hourEnd - rule.hourStart) * 60) / rule.checkMinutes));
  const chance =
    rule.mode === 'probability'
      ? rule.probability / 100
      : Math.min(1, remaining / Math.max(1, slots - state.eligibleChecks));
  state.eligibleChecks++;
  state.chance = remaining ? chance : 0;
  if (!remaining) return 'daily_limit';
  return random() < chance ? 'selected' : 'probability_missed';
}
/** Spread opportunities over the window; missed or blocked opportunities are never made up. */
export function opportunity(rule: Rule, state: Decision, now: number, random: () => number) {
  const plan = JSON.stringify([
    state.day,
    rule.dailyMax,
    rule.minMinutes,
    rule.hourStart,
    rule.hourEnd,
    rule.timezone,
  ]);
  if (state.plan !== plan) {
    const begin = Math.max(now, localTime(state.day, rule.hourStart, 0, rule.timezone));
    const end = localTime(
      state.day,
      rule.hourEnd === 24 ? 23 : rule.hourEnd,
      rule.hourEnd === 24 ? 59 : 0,
      rule.timezone,
    );
    const gap = rule.minMinutes * 60000;
    const count = Math.min(
      Math.max(0, rule.dailyMax - state.attempts),
      Math.max(0, Math.ceil((end - begin) / gap)),
    );
    const slack = Math.max(0, end - begin - gap * Math.max(0, count - 1));
    state.opportunities = Array.from(
      { length: count },
      (_, i) => begin + i * gap + (slack * (i + random())) / count,
    );
    state.plan = plan;
    state.checkedOpportunity = -1;
  }
  if (state.attempts >= rule.dailyMax) return 'daily_limit';
  let selected = false;
  for (let i = (state.checkedOpportunity ?? -1) + 1; i < (state.opportunities?.length ?? 0); i++) {
    const at = state.opportunities![i];
    if (at > now) break;
    state.checkedOpportunity = i;
    selected = now - at <= Math.min(rule.checkMinutes, 5) * 60000;
  }
  return selected ? 'selected' : 'waiting_opportunity';
}
