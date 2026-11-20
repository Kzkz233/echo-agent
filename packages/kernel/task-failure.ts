import type { Store } from './store.ts';
import type { Connection, ModelProfile } from '../contracts/inference.ts';
import type { TaskFailure } from '../contracts/task-failure.ts';

export function describeFailure(store: Store, error: string, stage: TaskFailure['stage'], profileId?: string, model?: string): TaskFailure {
  const profile = profileId ? store.document<ModelProfile>('profiles', profileId) : undefined;
  const service = profile?.connectionId ? store.document<Connection>('connections', profile.connectionId) : undefined;
  const causes: [RegExp, TaskFailure['category']][] = [
    [/整理会话结束时尚有|整理会话尚未提交完成回执|整理会话结束，但没有确认完成/, 'checkpoint'],
    [/insufficient[_ ]quota|insufficient.balance|余额不足|HTTP\s+402\b/i, 'quota'],
    [/\b(401|403)\b|unauthori[sz]ed|invalid.api.key/i, 'auth'],
    [/\b429\b|rate.limit/i, 'rate'],
    [/ETIMEDOUT|ERR_CONNECT_TIMEOUT|timed?\s*out|timeout|超时/i, 'timeout'],
    [/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connection error|fetch failed|socket hang up/i, 'network'],
    [/\b50[0-49]\b|bad gateway|service unavailable/i, 'upstream'],
    [/达到生成上限|context_length_exceeded|maximum context length/i, 'limit'],
  ];
  return {
    stage: /上下文压缩失败|compaction failed/i.test(error) ? 'compaction' : stage,
    category: causes.find(([pattern]) => pattern.test(error))?.[1] ?? 'other',
    error, model: model || profile?.model || profileId,
    ...(service && ['core.api', 'core.pi'].includes(service.adapterId) ? { connectionId: service.id, connectionName: service.name } : {}),
  };
}
