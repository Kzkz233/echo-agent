import { randomUUID } from 'node:crypto';
import {
  EchoError,
  type GenerateRequest,
  type GenerateResult,
  type Profile,
} from '../contracts/index.ts';
import { effectiveReasoning } from './model-metadata.ts';

/** Summary size is a writing target. The model's configured output budget still
 * applies; truncating a summary must never silently discard conversation history. */
export async function summarizeContext(input: {
  profile: Profile;
  prompt: string;
  text: string;
  maxChars: number;
  generate: (request: GenerateRequest) => Promise<GenerateResult>;
  signal: AbortSignal;
  onItem?: GenerateRequest['onItem'];
}) {
  const { profile, signal, maxChars } = input;
  const support = effectiveReasoning(profile, profile.reasoningSupport);
  try {
    const result = await input.generate({
      profile,
      messages: [
        {
          role: 'system',
          text:
            input.prompt +
            `\n摘要正文不超过 ${maxChars} 字符；优先保留事实、约束与未完成事项，不复述过程。`,
        },
        { role: 'user', text: input.text },
      ],
      toolPolicy: 'none',
      requestId: randomUUID(),
      reasoning:
        support?.levels.includes('off') ? 'off' : 'inherit',
      onItem: input.onItem,
      signal,
    });
    signal.throwIfAborted();
    if (!result.text.trim())
      throw new EchoError('summary_empty', '模型未返回有效摘要，原始历史已保留。');
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw Object.assign(
      new EchoError(
        'context_compaction_failed',
        '上下文压缩失败：' + (error instanceof Error ? error.message : String(error)),
      ),
      { cause: error, metrics: (error as any)?.metrics },
    );
  }
}
