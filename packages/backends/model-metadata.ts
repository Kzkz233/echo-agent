import { EchoError, type Profile, type Reasoning } from '../contracts/index.ts';
import {
  reasoningLevels,
  type ModelListing,
  type ReasoningSupport,
} from '../contracts/reasoning.ts';

const level = (value: unknown) => {
  const raw = value === 'none' ? 'off' : value;
  return reasoningLevels.find((item) => item === raw);
};

/** Read explicit metadata only. An id, provider name or a boolean reasoning flag
 * alone does not describe which effort values an endpoint accepts. */
export function readReasoningSupport(
  row: any,
  source: ReasoningSupport['source'] = 'upstream',
): ReasoningSupport | undefined {
  const info = row?.reasoning ?? row?.capabilities?.reasoning;
  const raw =
    row?.supported_reasoning_efforts ??
    row?.supportedReasoningEfforts ??
    row?.reasoningEfforts ??
    info?.efforts ??
    row?.effort?.supported_levels;
  if (raw === false || info === false) return { source, levels: ['off'], style: 'none' };
  let entries: [unknown, unknown][];
  if (Array.isArray(raw))
    entries = raw.map((item: any) => {
      const id = typeof item === 'string' ? item : (item?.reasoningEffort ?? item?.id);
      return [id, id];
    });
  else if (raw && typeof raw === 'object') entries = Object.entries(raw);
  else if (
    Array.isArray(row?.supported_parameters) &&
    row.supported_parameters.includes('enable_thinking')
  )
    return { source, levels: ['off', 'high'], kind: 'toggle', style: 'enable_thinking' };
  else return undefined;
  const values: Record<string, string | null> = {};
  for (const [id, wire] of entries) {
    const key = level(id);
    if (key && (typeof wire === 'string' || wire === null)) values[key] = wire;
  }
  if (row?.owned_by === 'deepseek' && Array.isArray(row?.effort?.supported_levels))
    values.off = 'none';
  const levels = reasoningLevels.filter((key) => Object.hasOwn(values, key));
  if (!levels.length) return undefined;
  const defaultLevel = level(
    row?.default_reasoning_effort ??
      row?.defaultReasoningEffort ??
      info?.defaultEffort ??
      row?.effort?.default_level,
  );
  return {
    source,
    levels,
    wireValues: values,
    ...(source === 'upstream'
      ? {
          style:
            row?.owned_by === 'deepseek' && row?.effort
              ? ('deepseek' as const)
              : ('effort' as const),
        }
      : {}),
    ...(defaultLevel && levels.includes(defaultLevel) ? { default: defaultLevel } : {}),
  };
}
/** Documented adapters are explicit metadata, not an inference probe or an invented effort ladder. */
export function documentedReasoning(
  profile: Pick<Profile, 'endpoint' | 'model' | 'reasoningStyle' | 'reasoningLevels'>,
): ReasoningSupport | undefined {
  let host = '';
  try {
    host = new URL(profile.endpoint).hostname;
  } catch {}
  const style = profile.reasoningStyle;
  if (profile.reasoningLevels?.length && style === 'effort')
    return { source: 'manual', kind: 'effort', levels: profile.reasoningLevels, style };
  if (style === 'none') return { source: 'manual', levels: ['off'], style: 'none' };
  if (style === 'enable_thinking' || style === 'chat_template')
    return { source: 'manual', kind: 'toggle', levels: ['off', 'high'], style,aliases:{minimal:'high',low:'high',medium:'high',xhigh:'high',max:'high'} };
  if (style === 'deepseek')
    return {
      source: 'manual',
      kind: 'effort',
      levels: ['off', 'low', 'high', 'max'],
      default: 'high',
      style: 'deepseek',
      aliases: { minimal: 'low', medium: 'high', xhigh: 'high' },
    };
  if (style !== 'auto') return undefined;
  if (host === 'api.modelbest.cn' && /^MiniCPM-V-4\.7-(1B|35B-A3B)$/i.test(profile.model))
    return {
      source: 'catalog',
      kind: 'toggle',
      levels: ['off', 'high'],
      default: 'off',
      style: 'chat_template',
      aliases:{minimal:'high',low:'high',medium:'high',xhigh:'high',max:'high'},
      documentation: 'https://github.com/OpenBMB/MiniCPM-V/blob/main/docs/api.md',
    };
  if (host === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(profile.model))
    return {
      source: 'catalog',
      kind: 'effort',
      levels: ['off', 'low', 'high', 'max'],
      default: 'high',
      style: 'deepseek',
      aliases: { minimal: 'low', medium: 'high', xhigh: 'high' },
      documentation: 'https://api-docs.deepseek.com/guides/thinking_mode/',
    };
}
export function effectiveReasoning(
  profile: Pick<Profile, 'endpoint' | 'model' | 'reasoningStyle' | 'reasoningLevels'> & {kind?:Profile['kind']},
  upstream?: ReasoningSupport,
) {
  if(profile.kind&& !['api','pi'].includes(profile.kind))return upstream;
  const documented = documentedReasoning(profile);
  return documented?.source === 'manual' ? documented : (upstream ?? documented);
}
export function readModelListing(
  rows: unknown[],
  source: ReasoningSupport['source'] = 'upstream',
): ModelListing[] {
  const seen = new Set<string>();
  return rows
    .flatMap((row: any) => {
      const id = row?.id ?? row?.model;
      if (typeof id !== 'string' || !id || id.length > 300 || seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id,
          label: String(row.name ?? row.display_name ?? row.displayName ?? id).slice(0, 300),
          ...(readReasoningSupport(row, source)
            ? { reasoning: readReasoningSupport(row, source) }
            : {}),
        },
      ];
    })
    .slice(0, 500);
}

export function selectedReasoning(profile: Profile, override?: string) {
  const requested = !override || override === 'inherit' ? profile.reasoning : override;
  const support = profile.reasoningSupport;
  if (requested === 'inherit') return { requested, effort: undefined };
  const effort = support?.levels.includes(requested as any)
    ? requested
    : (support?.aliases?.[requested] ?? requested);
  if (support && !support.levels.includes(effort as any))
    throw new EchoError(
      'unsupported_reasoning',
      `当前模型不支持思考强度 ${requested}；请刷新模型支持项并重新选择。`,
    );
  return { requested, effort: effort as Exclude<Reasoning, 'inherit'> };
}
