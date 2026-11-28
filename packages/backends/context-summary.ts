import { maxModelRetries } from './model-retry.ts';
import type { GenerationMetrics } from '../contracts/generation-metrics.ts';
import { randomUUID } from 'node:crypto';
import {
  EchoError,
  type GenerateRequest,
  type GenerateResult,
  type Profile,
  type Reasoning,
} from '../contracts/index.ts';

/** Summary size is a writing target. The model's configured output budget still
 * applies; truncating a summary must never silently discard conversation history. */
export async function summarizeContext(input: {
  profile: Profile;
  prompt: string;
  text: string;
  maxChars: number;
  generate: (request: GenerateRequest) => Promise<GenerateResult>;
  signal: AbortSignal;
  reasoning?: Reasoning;
  onItem?: GenerateRequest['onItem'];
}) {
  const { profile, signal, maxChars } = input;
  const budget = { used: 0 };
  let corrected = false;
  let firstMetrics: GenerationMetrics | undefined;
  function generate(correction: boolean) {
    return input.generate({
      // Large history prefills and reasoning may be quiet for longer than an
      // ordinary reply. Extend only this transient request; saved model settings
      // and an explicit caller deadline remain authoritative.
      profile: { ...profile, timeoutMs: Math.max(profile.timeoutMs, 10 * 60000) },
      messages: [
        {
          role: 'system',
          text:
            input.prompt +
            `\n摘要正文不超过 ${maxChars} 字符；优先保留事实、约束与未完成事项，不复述过程。` +
            (correction ? '\n上一次没有返回摘要正文。请在最终回答中直接写出摘要，即使只需一句话。' : ''),
        },
        { role: 'user', text: input.text },
      ],
      toolPolicy: 'none',
      requestId: randomUUID(),
      reasoning: input.reasoning ?? 'inherit',
      onItem: input.onItem,
      modelRetryBudget: budget,
      signal,
    });
  }
  async function attempt(correction: boolean) {
    signal.throwIfAborted();
    const result = await generate(correction);
    signal.throwIfAborted();
    if (!result.text.trim())
      throw Object.assign(new EchoError('summary_empty', '模型未返回摘要正文。'), { metrics: result.metrics });
    return result;
  }
  try {
    try {
      return await attempt(false);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof EchoError) || error.uncertain ||
          !['summary_empty', 'pi_empty', 'provider_empty'].includes(error.code) || budget.used >= maxModelRetries)
        throw error;
      firstMetrics = (error as EchoError & { metrics?: GenerationMetrics }).metrics;
      budget.used++;
      corrected = true;
      input.onItem?.({ id: 'summary-retry', kind: 'status', state: 'completed', title: '重新生成摘要',
        text: '上次摘要正文为空，正在用同一段历史重新生成一次。' });
      const result = await attempt(true);
      return { ...result, metrics: combinedMetrics(firstMetrics, result.metrics) };
    }
  } catch (error) {
    signal.throwIfAborted();
    throw Object.assign(
      new EchoError(
        'context_compaction_failed',
        (corrected ? '重新生成摘要后，上下文压缩仍失败：' : '上下文压缩失败：') + (error instanceof Error ? error.message : String(error)),
      ),
      { cause: error, metrics: combinedMetrics(firstMetrics, (error as any)?.metrics) },
    );
  }
}

function combinedMetrics(first?: GenerationMetrics, last?: GenerationMetrics): GenerationMetrics | undefined {
  if (!first || !last) return last ?? first;
  const merged = { ...last, modelSteps: first.modelSteps + last.modelSteps };
  if (first.totalUsage && last.totalUsage) {
    const total = { ...last.totalUsage };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) total[key] += first.totalUsage[key];
    merged.totalUsage = total;
    merged.cacheHitPercent = first.cacheHitPercent !== undefined && last.cacheHitPercent !== undefined && total.input > 0
      ? Math.min(100, total.cacheRead * 100 / total.input) : undefined;
  }
  return merged;
}
