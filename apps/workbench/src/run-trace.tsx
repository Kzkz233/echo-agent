import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import type { ExecutionItem } from '../../../packages/contracts/execution.ts';
export default function RunTrace({ runId, active = false }: { runId: string; active?: boolean }) {
  const [open, setOpen] = useState(active),
    [items, setItems] = useState<ExecutionItem[]>([]),
    [limit, setLimit] = useState(40);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  useEffect(() => {
    if (!open) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      rpc('runs.items', { runId })
        .then((value) => {
          if (alive) setItems(value);
        })
        .catch(() => {});
    void load();
    const changed = (event: any) => {
      if (
        event.detail.data?.runId === runId &&
        ['run.items.changed', 'run.completed'].includes(event.detail.type)
      ) {
        // Throttle rather than debounce: an ongoing 120 ms stream must not starve rendering.
        timer ??= setTimeout(() => {
          timer = undefined;
          void load();
        }, 150);
      }
    };
    window.addEventListener('echo-event', changed);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('echo-event', changed);
    };
  }, [runId, open]);
  const labels: Record<string, string> = {
    running: '执行中',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已停止',
    unknown: '结果待核对',
  };
  return (
    <details
      className="execution-trace"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        {t('执行过程')}
        {items.length > 0 && <span>{items.length}</span>}
        {active && <i className="activity-dot" />}
      </summary>
      {open && (
        <div className="execution-items">
          {items.slice(-limit).map((item) => (
            <details className={'execution-item ' + item.kind} key={item.id}>
              <summary>
                <strong>
                  {t(
                    item.title ??
                      {
                        message: '进展说明',
                        command: '命令',
                        files: '文件改动',
                        tool: '工具调用',
                        thinking: '思考摘要',
                        plan: '执行计划',
                        subagent: '宿主子代理',
                        usage: 'Token 用量',
                        status: '状态',
                      }[item.kind],
                  )}
                </strong>
                <span className={'execution-state ' + item.state}>
                  {t(labels[item.state ?? ''] ?? '')}
                </span>
              </summary>
              {item.detail && <pre>{item.detail}</pre>}
              {item.text && <pre>{item.text}</pre>}
              {item.truncated && <small>{t('过长输出已截断')}</small>}
            </details>
          ))}
          {items.length > limit && (
            <button className="text-button" onClick={() => setLimit(limit + 40)}>
              {t('显示更多')}
            </button>
          )}
          {!items.length && (
            <span className="muted">{t(active ? '等待宿主事件' : '此轮没有详细执行记录')}</span>
          )}
        </div>
      )}
    </details>
  );
}
