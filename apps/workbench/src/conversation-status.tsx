import { useEffect, useId, useRef, useState } from 'react';
import type { Run } from '../../../packages/contracts/index.ts';
import type { GenerationMetrics } from '../../../packages/contracts/generation-metrics.ts';
import { t } from './i18n.ts';
import { Icon } from './ui.tsx';

const groupLabels = {
  prefix: '固定前缀', tools: '工具定义', history: '会话历史', turn: '本轮临时内容',
};
const detailLabels: Record<string, string> = {
  'persona.profile': '角色人设', 'memory.core': '核心记忆', 'memory.recall': '参考记忆',
  'delegation.guide': '常驻委派指引', 'delegation.turn': '本轮委派信息',
  'chatstick.catalog': '表情目录', 'reflections.current': '角色关注',
  'core.presentation': '渠道约定', summary: '滚动摘要', human: '用户消息', chat: '角色回复',
  observation: '实时观察', care: '主动交流', notification: '通知', import: '导入记录',
  execution: '本轮工具调用与结果',
};
const groupHints: Record<keyof typeof groupLabels, string> = {
  prefix: '压缩会话时保留，随角色和插件设置更新。',
  tools: '压缩会话时保留，随可用工具更新。',
  history: '旧内容可归入摘要或移出输入，原始记录保留。',
  turn: '仅注入本轮，留档的内容之后归入历史。',
};

const tokenCount = (tokens: number) => tokens < 1000
  ? String(Math.round(tokens))
  : (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'K';

export function ConversationStatus({ run, limit }: { run?: Run; limit: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const metrics = run?.meta.generationMetrics as GenerationMetrics | undefined;
  const usage = run?.meta.usage as Record<string, number> | undefined;
  const legacyInput = typeof usage?.input === 'number'
    ? usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
  const reported = metrics?.inputTokens ?? (legacyInput > 0 ? legacyInput : undefined);
  const breakdown = metrics?.context;
  const estimated = breakdown ? breakdown.system + breakdown.tools + breakdown.messages : run?.meta.contextInputTokens;
  const used = reported ?? (typeof estimated === 'number' ? estimated : undefined);
  const occupancy = used !== undefined && limit > 0 ? used / limit * 100 : undefined;
  const percent = occupancy === undefined ? '—' : Math.round(occupancy) + '%';
  const display = used === undefined ? '—' : (reported === undefined ? '≈' : '') + tokenCount(used);
  const cache = metrics?.cacheHitPercent ?? (!metrics && legacyInput > 0 && (usage?.cacheRead ?? 0) > 0
    ? Math.min(100, usage!.cacheRead * 100 / legacyInput) : undefined);
  const rows = metrics?.details ? Object.entries(groupLabels).map(([id, label]) => {
    const details = metrics.details!.filter((item) => item.group === id);
    return { id, label: t(label), details, tokens: details.reduce((sum, item) => sum + item.tokens, 0) };
  }) : breakdown ? [
    { id: 'system', label: t('系统提示词'), tokens: breakdown.system },
    { id: 'tools', label: t('工具定义'), tokens: breakdown.tools },
    { id: 'messages', label: t('对话消息'), tokens: breakdown.messages },
  ] : [];
  const estimatedTotal = rows.reduce((total, row) => total + row.tokens, 0);

  return (
    <div className="conversation-status">
      {metrics && <span className="conversation-status-item" title={t('平均生成速度包含模型等待时间，工具执行单独计时。')}>
        <Icon name="speed" size={15} />
        {t('{steps} 步', { steps: metrics.modelSteps })}
        {metrics.tokensPerSecond !== undefined && ` · ${tokenCount(metrics.tokensPerSecond)} tok/s`}
      </span>}
      {used !== undefined && <span className="conversation-status-item" title={t('显示最近一轮的输入用量，缓存命中率按模型请求汇总。')}>
        <Icon name="tokens" size={15} />
        {display} tok
        {cache !== undefined && ' · ' + t('缓存命中 {percent}', { percent: Math.round(cache) + '%' })}
      </span>}
      <div className="conversation-status-anchor" ref={root}>
        <button type="button" className="conversation-context-toggle" aria-expanded={open}
          aria-controls={id} aria-label={t('查看上下文明细')} title={t('查看上下文明细')}
          onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" className="conversation-context-track" />
            {!!occupancy && <circle cx="10" cy="10" r="7.5" pathLength="100" transform="rotate(-90 10 10)"
              strokeDasharray={Math.min(100, occupancy) + ' 100'} className="conversation-context-fill" />}
          </svg>
          {percent}
        </button>
        {open && <section id={id} className="conversation-context-card" aria-label={t('上下文用量')}>
          <header>
            <span>{t('上下文已用')} <strong>{percent}</strong></span>
            <strong>{display} / {tokenCount(limit)}</strong>
          </header>
          <div className="conversation-context-bar" aria-hidden="true">
            {estimatedTotal > 0 ? rows.map((row) => <span key={row.id} data-part={row.id}
              style={{ width: Math.min(100, occupancy ?? 0) * row.tokens / estimatedTotal + '%' }} />)
              : <span data-part="messages" style={{ width: Math.min(100, occupancy ?? 0) + '%' }} />}
          </div>
          {metrics?.details ? <div className="conversation-context-groups">{rows.map((row) => 'details' in row && (
            <details key={row.id}>
              <summary><span><i data-part={row.id} />{row.label}</span><span>≈{tokenCount(row.tokens)}</span></summary>
              <p>{t(groupHints[row.id as keyof typeof groupLabels])}</p>
              <dl>{row.details.map((item) => <div key={item.source}>
                <dt>{t(detailLabels[item.source] ?? item.source)}</dt><dd>≈{tokenCount(item.tokens)}</dd>
              </div>)}</dl>
            </details>
          ))}</div> : rows.length ? <dl>{rows.map((row) => <div key={row.id}>
            <dt><i data-part={row.id} />{row.label}</dt>
            <dd>≈{tokenCount(row.tokens)}</dd>
          </div>)}</dl> : <p>{t('下一轮完成后显示上下文构成。')}</p>}
        </section>}
      </div>
    </div>
  );
}
