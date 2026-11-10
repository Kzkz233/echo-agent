import { invariant, type Reasoning } from '../contracts/index.ts';
export type CodexModel = {
  id: string;
  model: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
};
export function selectCodexReasoning(
  models: CodexModel[],
  model: string | undefined,
  requested: Reasoning | undefined,
  configured: Reasoning,
) {
  const selected = model
    ? models.find((m) => m.model === model || m.id === model)
    : models.find((m) => m.isDefault);
  const wanted = requested && requested !== 'inherit' ? requested : configured;
  if (wanted === 'inherit')
    return {
      model: selected?.model ?? model,
      requested: wanted,
      effort: selected?.defaultReasoningEffort,
    };
  invariant(
    selected?.supportedReasoningEfforts?.length,
    'codex_capabilities',
    'Codex 未返回当前模型的思考选项，未提交推理请求。',
  );
  const supported = selected.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    raw = wanted === 'off' ? 'none' : wanted;
  const effort = supported.includes(raw)
    ? raw
    : wanted === 'off'
      ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].find((e) =>
          supported.includes(e),
        )
      : undefined;
  invariant(effort, 'codex_reasoning', '当前 Codex 模型不支持所选思考强度：' + wanted);
  return { model: selected.model, requested: wanted, effort };
}
export function codexFailure(error: unknown) {
  let detail = error;
  for (let n = 0; n < 4; n++) {
    if (typeof detail === 'string') {
      try {
        const parsed = JSON.parse(detail);
        detail = parsed;
        continue;
      } catch {
        break;
      }
    }
    if (detail && typeof detail === 'object')
      detail = (detail as any).error ?? (detail as any).message;
    else break;
  }
  return typeof detail === 'string'
    ? detail.replace(/Bearer\s+\S+|sk-[\w-]+/gi, '[redacted]').slice(0, 600)
    : '';
}
