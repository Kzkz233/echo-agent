import type { ExecutionUpdate } from '../contracts/execution.ts';
const stringify = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
export function codexEvent(method: string, p: any): ExecutionUpdate | undefined {
  if (method === 'turn/plan/updated')
    return {
      id: 'plan',
      kind: 'plan',
      title: '执行计划',
      state: 'running',
      text: (p.plan ?? []).map((s: any) => `${s.status} · ${s.step}`).join('\n'),
    };
  if (method === 'turn/diff/updated')
    return { id: 'diff', kind: 'files', title: '文件改动', text: p.diff ?? '' };
  if (method === 'thread/tokenUsage/updated')
    return { id: 'usage', kind: 'usage', title: 'Token 用量', text: stringify(p.tokenUsage) };
  const deltaKinds: Record<string, ExecutionUpdate['kind']> = {
    'item/agentMessage/delta': 'message',
    'item/reasoning/summaryTextDelta': 'thinking',
    'item/commandExecution/outputDelta': 'command',
    'item/plan/delta': 'plan',
  };
  if (deltaKinds[method])
    return {
      id: String(p.itemId ?? method),
      kind: deltaKinds[method],
      state: 'running',
      delta: String(p.delta ?? ''),
    };
  if (!['item/started', 'item/completed'].includes(method) || !p.item) return;
  const item = p.item,
    states: Record<string, ExecutionUpdate['state']> = {
      failed: 'failed',
      declined: 'cancelled',
      interrupted: 'cancelled',
    };
  const state = states[item.status] ?? (method === 'item/completed' ? 'completed' : 'running');
  const base = { id: String(item.id ?? item.type), state };
  switch (item.type) {
    case 'agentMessage':
      return {
        ...base,
        kind: 'message',
        title: item.phase === 'commentary' ? '进展说明' : '回复',
        text: item.text,
      };
    case 'reasoning':
      return {
        ...base,
        kind: 'thinking',
        title: '思考摘要',
        text: (item.summary ?? [])
          .map((s: any) => (typeof s === 'string' ? s : (s.text ?? '')))
          .join('\n'),
      };
    case 'plan':
      return { ...base, kind: 'plan', title: '执行计划', text: item.text };
    case 'commandExecution':
      return {
        ...base,
        kind: 'command',
        title: String(item.command ?? '命令').slice(0, 300),
        text: item.aggregatedOutput,
        detail: stringify({ cwd: item.cwd, exitCode: item.exitCode, durationMs: item.durationMs }),
      };
    case 'fileChange':
      return {
        ...base,
        kind: 'files',
        title: '文件改动',
        text: (item.changes ?? []).map((c: any) => c.path + '\n' + (c.diff ?? '')).join('\n\n'),
      };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return {
        ...base,
        kind: 'tool',
        title: String(item.tool ?? item.name ?? '工具'),
        detail: stringify(item.arguments),
        text: item.result === undefined ? undefined : stringify(item.result),
      };
    case 'collabAgentToolCall':
      return {
        ...base,
        kind: 'subagent',
        title: String(item.tool ?? '宿主子代理'),
        text: stringify(item.agentsStates ?? item.status),
      };
    case 'webSearch':
      return { ...base, kind: 'tool', title: '搜索', text: stringify(item.action ?? item.query) };
  }
}
export function dshEvent(event: any): ExecutionUpdate | undefined {
  const type = String(event.type ?? ''),
    d = event.data ?? {};
  const identity = String(
    d.callId ??
      d.call?.id ??
      d.toolCall?.id ??
      d.message?.source?.callId ??
      d.id ??
      event.id ??
      event.seq ??
      type,
  );
  if (type === 'assistant/message')
    return {
      id: 'message-' + identity,
      kind: 'message',
      title: '回复',
      state: 'completed',
      text: (d.message?.content ?? [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join(''),
    };
  if (type.startsWith('tool/'))
    return {
      id: 'tool-' + identity,
      kind: 'tool',
      title: String(d.toolName ?? d.call?.name ?? d.name ?? d.message?.source?.name ?? type).slice(
        0,
        300,
      ),
      state: /end|result|completed/.test(type) ? (d.error ? 'failed' : 'completed') : 'running',
      text:
        d.result === undefined && !d.message
          ? undefined
          : stringify(d.result ?? d.message?.content),
      detail: stringify(d.arguments ?? d.input ?? d),
    };
  if (type === 'todo/write')
    return {
      id: 'plan',
      kind: 'plan',
      title: '执行计划',
      state: 'completed',
      text: stringify(d.items ?? d.todos ?? d),
    };
  if (type === 'workspace/changes')
    return {
      id: 'changes',
      kind: 'files',
      title: '文件改动',
      state: 'completed',
      text: stringify(d),
    };
  if (type.startsWith('compaction/'))
    return {
      id: 'compaction',
      kind: 'status',
      title: '上下文压缩',
      state: /end|summary/.test(type) ? 'completed' : 'running',
    };
  if (type === 'assistant/attempt')
    return {
      id: 'attempt-' + identity,
      kind: 'status',
      title: '模型请求',
      state: 'completed',
      text: stringify(d.reason ?? d.finishReason ?? ''),
    };
}
export function piEvent(event: any): ExecutionUpdate | undefined {
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const text = (event.message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
    if (text) return { id: 'message-' + event.message.timestamp, kind: 'message', title: '模型输出', state: 'completed', text };
  }
  if (event.type.startsWith('tool_execution_'))
    return {
      id: String(event.toolCallId),
      kind: ['bash', 'powershell'].includes(event.toolName) ? 'command' :
        ['write', 'edit'].includes(event.toolName) ? 'files' : 'tool',
      title: String(event.toolName ?? '工具'),
      state:
        event.type === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'running',
      ...(event.args !== undefined ? { detail: stringify(event.args) } : {}),
      ...(event.result !== undefined || event.partialResult !== undefined
        ? { text: toolText(event.result ?? event.partialResult) }
        : {}),
    };
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta')
    return {
      id: 'thinking',
      kind: 'thinking',
      title: '思考摘要',
      state: 'running',
      delta: event.assistantMessageEvent.delta,
    };
}
function toolText(result: any) {
  if (typeof result?.details?.diff === 'string') return result.details.diff;
  if (Array.isArray(result?.content)) return result.content.map((part: any) =>
    part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
  return stringify(result);
}
