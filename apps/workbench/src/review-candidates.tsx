import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button } from './ui.tsx';

export function ReviewCandidates({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false), [page, setPage] = useState<any>(), [offset, setOffset] = useState(0);
  const [full, setFull] = useState<Record<string, any>>({}), [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void rpc('review.candidates', { jobId, state: 'all', offset }).then(value => { if (alive) setPage(value); })
      .catch(error => { if (alive) setError(String(error.message)); });
    return () => { alive = false; };
  }, [jobId, offset, open]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('候选记忆')}</summary>
    {error && <p className="warning">{error}</p>}
    {page?.items.map((row: any) => <div key={row.id} className="card">
      <strong>{row.title}</strong> · {t(row.state === 'pending' ? '待处理' : row.state === 'changed' ? '已处理' : '无需修改')}
      <p style={{ whiteSpace: 'pre-wrap' }}>{full[row.id]?.text ?? row.excerpt}</p>
      {row.reason && <p>{row.reason}</p>}
      {!full[row.id] && <Button secondary onClick={() => void rpc('review.readCandidate', { jobId, id: row.id })
        .then(value => setFull(previous => ({ ...previous, [row.id]: value }))).catch(error => setError(error.message))}>{t('查看完整内容')}</Button>}
    </div>)}
    {page && !page.total && <p>{t('没有候选记忆')}</p>}
    <div className="row">
      {offset > 0 && <Button secondary onClick={() => setOffset(Math.max(0, offset - 12))}>{t('上一页')}</Button>}
      {page?.hasMore && <Button secondary onClick={() => setOffset(page.nextOffset)}>{t('下一页')}</Button>}
    </div>
  </details>;
}
