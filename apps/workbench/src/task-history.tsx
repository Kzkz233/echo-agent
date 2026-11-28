import { AppTime } from './message-time.tsx';
import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { statusText, t } from './i18n.ts';
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
function ResultStatus({ result }: { result: any }) {
  const targets = result.expectedTargets ?? [];
  const delivered = new Set(result.outputs.filter((out: any) => out.phase !== 'progress')
    .flatMap((out: any) => out.deliveries.filter((r: any) => r.state === 'delivered').map((r: any) => r.targetId)));
  const count = targets.filter((target: any) => delivered.has(target.id)).length;
  return <>
    {result.executionState && <>{statusText(result.executionState)}{result.resumable && ' · ' + t('已保存断点')} → </>}
    {t(handoff[result.handoff] ?? result.handoff)}
    {targets.length > 0 && <> → {t('已送达')} {count}/{targets.length}</>}
  </>;
}

function ResultDetails({ result, act, resumed = false }: { result: any; act: any; resumed?: boolean }) {
  const seen = new Set(result.outputs.filter((out: any) => out.phase !== 'progress').flatMap((out: any) => out.deliveries.map((r: any) => r.targetId)));
  return <details className="card">
    <summary><AppTime at={result.createdAt}/> · {resumed && <>{t('从断点续跑')} · </>}<ResultStatus result={result}/></summary>
    <p className="readable-pre">{result.text}</p>
    {result.executionFailure && <FailurePanel failure={result.executionFailure}/>}
    {result.handoffFailure && <FailurePanel failure={result.handoffFailure}/>}
    {result.outputs.map((out: any) => <OutputRecord key={out.id} row={out} act={act}/>)}
    {result.expectedTargets?.filter((target: any) => !seen.has(target.id)).map((target: any) =>
      <div key={target.id}><small>{t(target.label)} · {t(target.ready === false ? target.issue || '输出目标当前不可用。' : '暂无渠道回执')}</small></div>)}
  </details>;
}

const groupKey = (row: {personaId?:string;runKey?:string}) => JSON.stringify([row.personaId, row.runKey]);

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
  const [history, setHistory] = useState<{ results: any[]; otherOutputs: any[]; occurrences?: any[] }>();
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
        /^(output\.|run\.(started|completed)|input\.|message\.posted|work\.|automation\.|review\.|scheduler\.|agenda\.reminder)/.test(
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
  const byRun = new Map<string, any[]>();
  const occurrences = history?.occurrences ?? [];
  for (const occurrence of occurrences) if (occurrence.runKey) byRun.set(groupKey(occurrence), []);
  const separate = [];
  for (const result of history?.results ?? []) {
    const group = result.runKey && byRun.get(groupKey(result));
    if (group) group.push(result);
    else separate.push(result);
  }
  return (
    <section className="task-run-history">
      <h2>{t('结果与投递')}</h2>
      {issue && <p role="alert">{issue}</p>}
      {!issue && !history && <p>{t('正在打开…')}</p>}
      {history && !occurrences.length && !history.results.length && !history.otherOutputs.length && <p className="muted">{t('暂无记录')}</p>}
      {occurrences.map(row => {
        const results = byRun.get(groupKey(row)) ?? [];
        return <details className="card" key={JSON.stringify([row.personaId,row.scheduled,row.source])}>
          <summary><AppTime at={row.scheduled}/> · {t(row.outcome === 'skipped' ? '已跳过' : row.outcome === 'catchup' ? '补跑' : '按时触发')}
            {results[0] && <> → <ResultStatus result={results[0]}/></>}
            {row.executionState && <> → {row.executionState === 'empty' ? t('没有新材料') : statusText(row.executionState)}</>}
          </summary>
          <p>{t('原定时间')} <AppTime at={row.scheduled} detail/> · {t('实际处理')} <AppTime at={row.observed} detail/>
            {row.first < row.scheduled && <> · {t('合并自')} <AppTime at={row.first} detail/></>}
          </p>
          {results.map((r, index) => <ResultDetails key={r.id} result={r} act={act} resumed={results[index + 1]?.resumable}/>)}
        </details>;
      })}
      {separate.map(r => <ResultDetails key={r.id} result={r} act={act}/>)}
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
        <small><AppTime at={row.lastAt}/></small>
      </button>)}</div>
    </>)}
  </details>;
}
