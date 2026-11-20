import { useEffect, useState } from 'react';
import { failedTaskRuns, type FailedTaskRun, type TaskFailure } from '../../../packages/contracts/task-failure.ts';
import { rpc } from './client.ts';
import { locale, t } from './i18n.ts';
import { Button } from './ui.tsx';

const stages = { execution:'任务执行', compaction:'上下文压缩', handoff:'主会话接棒', finalization:'整理收尾' };
const causes = { network:'网络连接中断', timeout:'请求超时', auth:'服务拒绝访问', quota:'服务额度不足',
  rate:'请求受限', upstream:'上游服务错误', limit:'模型长度限制', checkpoint:'检查点待完成', other:'查看错误详情' };

export function FailurePanel({ failure }: { failure: TaskFailure }) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  async function check() {
    setPending(true); setFeedback('');
    try {
      const r = await rpc('connections.test', {id:failure.connectionId, generation:false});
      setFeedback(r.ok && r.verified === 'upstream' ? t('已连通模型目录。推理结果可在续跑后核对。') : t('无法验证模型目录。'));
    } catch (e) { setFeedback((e as Error).message); }
    finally { setPending(false); }
  }
  return <div className="stack">
    <strong>{t(stages[failure.stage])} · {t(causes[failure.category])}</strong>
    {failure.model && <small>{[failure.model, failure.connectionName].filter(Boolean).join(' · ')}</small>}
    <details><summary>{t('错误详情')}</summary><p className="readable-pre">{failure.error}</p></details>
    {failure.connectionId && <div><Button secondary disabled={pending} onClick={check}>{t('检查模型连接')}</Button></div>}
    {feedback && <p role="status">{feedback}</p>}
  </div>;
}

export function TaskCheckpoints({ owner, operation, taskId, personaId }: {
  owner: string; operation: string; taskId: string; personaId?: string;
}) {
  const [rows, setRows] = useState<FailedTaskRun[]>([]);
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState('');
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    if (!operation.startsWith(owner + '.')) return;
    const load = async () => {
      const seq = ++sequence;
      try {
        const result = failedTaskRuns.parse(await rpc(operation, {taskId, personaId}));
        if (active && seq === sequence) { setRows(result); setIssue(''); }
      } catch (e) { if (active && seq === sequence) setIssue((e as Error).message); }
    };
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (event:Event) => {
      const name = (event as CustomEvent).detail.type;
      if (name.startsWith(owner+'.') || name === 'run.completed') timer ??= setTimeout(() => {timer = undefined; void load();}, 200);
    };
    window.addEventListener('echo-event', update);
    return () => { active = false; clearTimeout(timer); window.removeEventListener('echo-event', update); };
  }, [owner, operation, taskId, personaId, revision]);
  async function resume(row: FailedTaskRun) {
    const checkpoint = row.checkpoint;
    if (!checkpoint?.resumeOperation?.startsWith(owner + '.') || busy) return;
    setBusy(row.id); setIssue('');
    try {
      await rpc(checkpoint.resumeOperation, {id:row.id, confirmed:true, expectedProfileId:checkpoint.expectedProfileId});
      refresh(n => n + 1);
    } catch(e) { setIssue((e as Error).message); }
    finally { setBusy(''); }
  }
  if (!rows.length && !issue) return null;
  return <section className="task-run-history"><h2>{t('中断的运行')}</h2>
    {issue && <p role="alert">{issue}</p>}
    {rows.map(row => <article className="card stack" key={row.id}>
      <strong>{new Date(row.createdAt).toLocaleString(locale())}</strong>
      <FailurePanel key={row.id + row.failure.error + row.failure.connectionId} failure={row.failure}/>
      {row.checkpoint && <div className="row wrap">
        <span>{t('已保存进度')} · {row.checkpoint.completed} / {row.checkpoint.total}</span>
        {row.checkpoint.resumeOperation?.startsWith(owner + '.') && <Button secondary disabled={!!busy} onClick={() => resume(row)}>{t('从断点续跑')}</Button>}
      </div>}
    </article>)}
  </section>;
}
