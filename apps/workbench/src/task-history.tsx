import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { locale, t } from './i18n.ts';
import { FailurePanel } from './task-failure.tsx';
import { OutputRecord } from './output-targets.tsx';

const handoff: Record<string, string> = {
  recorded: '已记入主会话',
  queued: '等待主会话接棒',
  running: '主会话处理中',
  succeeded: '主会话已完成',
  failed: '主会话处理失败',
  cancelled: '已取消',
  unknown: '结果待核对',
  unconfirmed: '暂无主会话运行记录',
};
export function TaskHistory({
  type,
  id,
  personaId,
  act,
}: {
  type: string;
  id: string;
  personaId?: string;
  act: any;
}) {
  const [history, setHistory] = useState<{ results: any[]; otherOutputs: any[] }>();
  const [issue, setIssue] = useState('');
  useEffect(() => {
    let sequence = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    setHistory(undefined);
    setIssue('');
    const refresh = () => {
      const current = ++sequence;
      void rpc('automation.history', { type, id, personaId })
        .then((value) => {
          if (sequence === current) {
            setHistory(value);
            setIssue('');
          }
        })
        .catch((e) => {
          if (sequence === current) setIssue(e.message);
        });
    };
    refresh();
    const update = (event: Event) => {
      if (
        /^(output\.|run\.(started|completed)|input\.|message\.posted|work\.|automation\.)/.test(
          (event as CustomEvent).detail.type,
        )
      )
        timer ??= setTimeout(() => {
          timer = undefined;
          refresh();
        }, 180);
    };
    window.addEventListener('echo-event', update);
    return () => {
      sequence++;
      clearTimeout(timer);
      window.removeEventListener('echo-event', update);
    };
  }, [type, id, personaId]);
  return (
    <section className="task-run-history">
      <h2>{t('结果与投递')}</h2>
      {issue && <p role="alert">{issue}</p>}
      {!issue && !history && <p>{t('正在打开…')}</p>}
      {history && !history.results.length && !history.otherOutputs.length && (
        <p className="muted">{t('暂无记录')}</p>
      )}
      {history?.results.map((r) => (
        <details key={r.id} className="card">
          <summary>
            {new Date(r.createdAt).toLocaleString(locale())} · {t(handoff[r.handoff] ?? r.handoff)}
          </summary>
          <p className="readable-pre">{r.text}</p>
          {r.executionState && (
            <p>
              {t('执行状态')} · {t(r.executionState)}
            </p>
          )}
          {r.executionFailure && <FailurePanel failure={r.executionFailure}/>}
          {r.handoffFailure && <FailurePanel failure={r.handoffFailure}/>}
          {r.outputs.map((out: any) => (
            <OutputRecord key={out.id} row={out} act={act} />
          ))}
          {!r.outputs.length && <small>{t('暂无渠道回执')}</small>}
        </details>
      ))}
      {history?.otherOutputs.map((out) => (
        <OutputRecord key={out.id} row={out} act={act} />
      ))}
    </section>
  );
}

export function RecordedTasks({ personaId, act }: { personaId:string; act:any }) {
  const [open,setOpen] = useState(false);
  const [rows,setRows] = useState<{type:string;id:string;label:string;lastAt:string}[]>();
  const [selected,setSelected] = useState<{type:string;id:string}>();
  const [error,setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () => rpc('automation.recordedTasks',{personaId}).then(value=>{
      if(active){setRows(value);setError('');}
    }).catch(e=>{if(active)setError(e.message);});
    void load();
    const update = (e:Event) => { if ((e as CustomEvent).detail.type === 'message.posted') void load(); };
    window.addEventListener('echo-event',update);
    return () => { active=false; window.removeEventListener('echo-event',update); };
  },[open,personaId]);
  return <details className="card" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>{t('历史任务')}</summary>
    {open && (selected ? <>
      <button onClick={()=>setSelected(undefined)}>{t('返回任务列表')}</button>
      <TaskHistory {...selected} personaId={personaId} act={act}/>
    </> : <>
      {error && <p role="alert">{error}</p>}
      {!error && !rows && <p>{t('正在打开…')}</p>}
      {rows?.length === 0 && <p>{t('暂无记录')}</p>}
      <div className="task-record-list">{rows?.map(row=><button className="task-record" key={row.type+':'+row.id} onClick={()=>setSelected(row)}>
        <span><strong>{t(row.label)}</strong><small>{row.id}</small></span>
        <small>{new Date(row.lastAt).toLocaleString(locale())}</small>
      </button>)}</div>
    </>)}
  </details>;
}
