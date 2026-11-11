import { isDeepStrictEqual } from 'node:util';
import { invariant } from '../../packages/contracts/index.ts';
import type { CharacterDraft } from '../../plugins/persona/character-contracts.ts';
import { starterCharacters, starterSourcePrompts, starterStudio } from './starter-content.ts';
import {
  starterCharacters as legacyCharacters,
  starterSourcePrompts as legacySourcePrompts,
} from './starter-content-v2.ts';

type Example = (typeof starterCharacters)[number];
type Content = { [K in Exclude<keyof Example, 'expression'>]: string } & {
  expression: Record<string, unknown>;
};
type Defaults = Record<string, unknown>;
const legacyStudio = {
  context:
    '这是使用者与 Hina、Miyu 的共享工作室，可以一起讨论学习、创作、日常计划或项目。没有预设的私人经历。',
  prompt:
    '以自己的角色身份参与讨论，结合共享记录和其他成员的回答作出补充。避免轮流重复总结，不替别人发言；不引用私聊、私有记忆或不存在的工具结果。使用者可以选择本轮由谁回应。',
};

/** Only publisher-owned text slots. No models, grants, activity, assets or schedules. */
export function starterDefaults(
  example: Content,
  sources: Record<string, string> = starterSourcePrompts,
): Defaults {
  return {
    'persona.prompt': example.prompt,
    'persona.expression.chat': example.expression.chat,
    'persona.expression.external': example.expression.external,
    'persona.expression.bubble': example.expression.bubble,
    'persona.expression.stickers': example.expression.stickers,
    // This channel ID is a single key, not a dotted object path.
    'persona.expression.channels': example.expression.channels,
    'configurations.memory.queryPrompt': example.query,
    'configurations.delegation.prompt': example.delegation,
    'configurations.delegation.reportPrompt': example.handoff,
    'review.policies:prompt': example.review,
    'review.policies:memoryPrompt': example.memory,
    'review.policies:corePrompt': example.core,
    'review.policies:reportPrompt': example.report,
    'review.policies:sourcePrompts': sources,
    'review.policies:targetPrompts': { 'reflections.state': example.concern },
    'care.rules:prompt': example.care,
    'observation.tasks:interactionPrompt': example.interaction,
    'observation.tasks:observationPrompt': example.observation,
    'mail-triggers.rules:prompt': example.mail,
  };
}

// Merge each prompt independently, including registered channel/source keys. A deleted
// or edited local value is intentional; only unchanged defaults take the new text.
function merge(base: unknown, local: any, remote: any): any {
  if (isDeepStrictEqual(local, base)) return structuredClone(remote);
  if ([base, local, remote].every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    const result = { ...local };
    for (const key of Object.keys(remote)) {
      const value = merge((base as any)[key], local[key], remote[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  // A newly introduced registered channel/source can coexist with local entries.
  if (
    base === undefined &&
    local &&
    remote &&
    typeof local === 'object' &&
    typeof remote === 'object'
  )
    return merge({}, local, remote);
  return local;
}

export function refreshStarterDraft(current: CharacterDraft, example: Example, version: string) {
  invariant(
    current.package?.id === 'echo-starter-' + example.id,
    'example_conflict',
    '示例角色包不匹配。',
  );
  const draft = structuredClone(current);
  // Catalog settings also contain editor aliases. Keep only the canonical maps,
  // otherwise saveTask would let a stale sourcePrompt.* override the new map.
  for (const task of draft.tasks.filter((task) => task.type === 'review.policies'))
    for (const key of Object.keys(task.settings))
      if (key.startsWith('sourcePrompt.') || key.startsWith('targetPrompt.'))
        delete task.settings[key];
  const baseline = current.package!.baseline;
  const stored = baseline.starterDefaults as Defaults | undefined;
  // Version 2 saved only persona.prompt. Other exact, publicly shipped defaults
  // are recoverable; unknown versions must never be guessed or overwritten.
  const old =
    stored ??
    (current.package!.version.startsWith('2.')
      ? starterDefaults(
          legacyCharacters.find((row) => row.id === example.id)! as Content,
          legacySourcePrompts,
        )
      : {});
  if (!stored && typeof (baseline.persona as any)?.prompt === 'string')
    old['persona.prompt'] = (baseline.persona as any).prompt;
  const next = starterDefaults(example);
  let updated = 0;
  let preserved = 0;
  for (const [path, remote] of Object.entries(next)) {
    let holder: any = draft;
    let key: string;
    if (path.includes(':')) {
      const [type, setting] = path.split(':');
      const suffix = {
        'review.policies': 'review',
        'care.rules': 'care',
        'observation.tasks': 'observe',
        'mail-triggers.rules': 'mail',
      }[type];
      const task = draft.tasks.find(
        (t) => t.type === type && t.id === draft.persona.id + '-' + suffix,
      );
      if (!task) continue; // Never resurrect a task removed by its owner.
      holder = task.settings;
      key = setting;
    } else {
      const parts = path.split('.');
      key = parts.pop()!;
      for (const part of parts) holder = holder?.[part];
      if (!holder) continue;
    }
    // Unknown older defaults are kept, including deliberately missing values.
    if (!stored && !current.package!.version.startsWith('2.') && !(path in old)) continue;
    const value = merge(old[path], holder[key], remote);
    if (!isDeepStrictEqual(holder[key], value)) {
      holder[key] = value;
      updated++;
    } else if (!isDeepStrictEqual(value, remote)) preserved++;
  }
  draft.package = {
    ...current.package!,
    version,
    baseline: {
      ...baseline,
      version,
      persona: { name: example.name, prompt: example.prompt },
      starterDefaults: next,
    },
  };
  return { draft, updated, preserved };
}

export function refreshStarterGroup(current: any, baseline = legacyStudio) {
  const context = merge(baseline.context, current.context, starterStudio.context);
  const prompt = merge(baseline.prompt, current.prompt, starterStudio.prompt);
  return { ...current, context, prompt };
}
