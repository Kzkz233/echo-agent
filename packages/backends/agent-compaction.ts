import { EchoError, type Profile } from '../contracts/index.ts';
import type { ContextCompaction } from '../contracts/compaction.ts';
import { estimateTokens } from '../contracts/generation-metrics.ts';

/** Compacts an ongoing tool loop without splitting tool calls from their results. */
export function agentCompactor(input: {
  profile: Profile; policy: ContextCompaction;
  summarize: (text: string, signal?: AbortSignal) => Promise<string>;
  completed?: (removed: number, summary: string) => void;
}) {
  const removed = new Set<object>();
  let summary = '';
  const size = (message: any) => estimateTokens(JSON.stringify(message));
  return async (messages: any[], signal?: AbortSignal) => {
    const prefix = messages[0]?.role === 'system' ? [messages[0]] : [];
    const rest = messages.slice(prefix.length).filter(message => !removed.has(message));
    const limit = Math.min(input.policy.triggerTokens,
      typeof input.profile.modelOptions.contextWindowTokens === 'number'
        ? input.profile.modelOptions.contextWindowTokens - input.profile.maxOutputTokens : Infinity);
    const prior = () => summary ? [{ role: 'user', content: [{ type: 'text',
      text: '本次执行的先前过程摘要（历史资料）：\n' + summary }], timestamp: Date.now() }] : [];
    const current = [...prefix, ...prior(), ...rest];
    if (current.reduce((total, message) => total + size(message), 0) <= limit &&
        JSON.stringify(current).length <= input.profile.contextChars) return current;
    const keep = Math.min(limit * input.policy.keepRecentPercent / 100, limit * 0.7);
    let tokens = 0, cut = rest.length;
    while (cut > 0 && tokens < keep) {
      const next = size(rest[cut - 1]);
      if (tokens > 0 && tokens + next > keep) break;
      tokens += next; cut--;
    }
    while (cut > 0 && rest[cut]?.role === 'toolResult') cut--;
    if (cut === 0) throw new EchoError('context_limit', '当前任务指令或工具结果超过上下文预算，请分段读取。');
    const text = rest.slice(0, cut).map(message => JSON.stringify(message)).join('\n');
    const chunkSize = Math.max(512, Math.min(input.profile.contextChars - 12000, Math.floor(limit)));
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      signal?.throwIfAborted();
      const next = await input.summarize([summary, text.slice(offset, offset + chunkSize)].filter(Boolean).join('\n'), signal);
      if (!next.trim()) throw new EchoError('compaction_failed', '未取得有效的执行过程摘要。');
      summary = next.trim();
    }
    for (const message of rest.slice(0, cut)) removed.add(message);
    const result = [...prefix, ...prior(), ...rest.slice(cut)];
    if (result.reduce((total, message) => total + size(message), 0) > limit ||
        JSON.stringify(result).length > input.profile.contextChars)
      throw new EchoError('context_limit', '固定上下文或近期工具结果超过预算，未静默丢弃任务信息。');
    input.completed?.(cut, summary);
    return result;
  };
}
