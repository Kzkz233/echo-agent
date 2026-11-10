import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';

export function OutputTargetsField({
  value,
  onChange,
  personaId,
  conversationId,
  source,
  bubble,
}: any) {
  const [options, setOptions] = useState<any>({ targets: [], defaults: [] });
  const [issue, setIssue] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      rpc('outputs.targets', {
        personaId: personaId || undefined,
        conversationId: conversationId || undefined,
        source,
        bubble,
      })
        .then((result) => {
          if (active) {
            setOptions(result);
            setIssue('');
          }
        })
        .catch((error) => {
          if (active) setIssue(error.message);
        });
    void load();
    const listener = (e: any) => {
      if (/^(plugins|channels|characters|settings)\./.test(e.detail.type)) void load();
    };
    window.addEventListener('echo-event', listener);
    return () => {
      active = false;
      window.removeEventListener('echo-event', listener);
    };
  }, [personaId, conversationId, source, bubble]);
  const selected: string[] = value ?? options.defaults;
  const rows = [
    ...options.targets,
    ...selected
      .filter((id) => !options.targets.some((o: any) => o.id === id))
      .map((id) => ({ id, label: id, ready: false, issue: t('输出插件或目标当前不可用。') })),
  ];
  return (
    <fieldset className="automation-options output-targets">
      <legend>{t('输出位置')}</legend>
      <div className="output-target-grid">
        {rows.map((option: any) => (
          <label key={option.id} className="output-target-option">
            <input
              type="checkbox"
              checked={selected.includes(option.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, option.id]
                    : selected.filter((id) => id !== option.id),
                )
              }
            />
            <span>
              {t(option.label)}
              {option.issue && <small>{t(option.issue)}</small>}
            </span>
          </label>
        ))}
      </div>
      {issue && <p role="alert">{issue}</p>}
      <p className="muted">
        {t(
          selected.length
            ? '同一结果分别投递，投递失败不会重新生成回复。'
            : '不主动展示，只保留任务结果。',
        )}
      </p>
    </fieldset>
  );
}

export function OutputHistory({ personaId, taskType, taskId, act }: any) {
  const [rows, setRows] = useState<any[]>([]),
    [issue, setIssue] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      rpc('outputs.list', { personaId, taskType, taskId })
        .then((result) => {
          if (active) setRows(result);
        })
        .catch((error) => {
          if (active) setIssue(error.message);
        });
    void load();
    const listener = (event: any) => {
      if (event.detail.type === 'output.changed' || event.detail.type === 'output.staged')
        void load();
    };
    window.addEventListener('echo-event', listener);
    return () => {
      active = false;
      window.removeEventListener('echo-event', listener);
    };
  }, [personaId, taskType, taskId]);
  const labels: Record<string, string> = {
    pending: '等待投递',
    sending: '投递中',
    queued: '已进入渠道队列',
    delivered: '已送达',
    failed: '投递失败',
    unknown: '结果待核对',
    skipped: '未投递',
    closed: '已结束跟进',
  };
  if (!rows.length && !issue) return null;
  return (
    <section className="task-run-history">
      <h2>{t('结果与投递')}</h2>
      {issue && <p role="alert">{issue}</p>}
      {rows.map((row) => (
        <details key={row.id} className="card">
          <summary>{row.title ?? row.text.slice(0, 80)}</summary>
          <p className="readable-pre">{row.text}</p>
          {row.deliveries.map((receipt: any) => (
            <div key={receipt.id} className="row between">
              <span>
                {t(
                  row.plan.targets.find((target: any) => target.id === receipt.targetId)?.label ??
                    receipt.targetId,
                )}{' '}
                · {t(labels[receipt.state])}
                {receipt.reason && <small> · {t(receipt.reason)}</small>}
              </span>
              {receipt.state === 'failed' && (
                <button
                  onClick={() =>
                    act(() => rpc('outputs.retry', { id: receipt.id, confirmed: true }))
                  }
                >
                  {t('重试投递')}
                </button>
              )}
              {['queued', 'unknown'].includes(receipt.state) && (
                <>
                  <button onClick={() => act(() => rpc('outputs.inspect'))}>{t('核对投递')}</button>
                  <button
                    onClick={() =>
                      act(() => rpc('outputs.resolve', { id: receipt.id, confirmed: true }))
                    }
                  >
                    {t('已核对，结束跟进')}
                  </button>
                </>
              )}
            </div>
          ))}
          {!row.deliveries.length && <span className="muted">{t('仅保留结果')}</span>}
        </details>
      ))}
    </section>
  );
}
