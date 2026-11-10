import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, EmptyState } from './ui.tsx';
import { DelegationView } from './character-workspace.tsx';
import { AutomationView } from './automation-view.tsx';
import { ReviewResume } from './review-resume.tsx';
import { taskPresentation } from '../../../packages/contracts/tasks.ts';

export function TaskWorkspace({ data, act, personaId, setPage, openTask, configureRole }: any) {
  const [catalog, setCatalog] = useState<any>({ types: [] }),
    [workers, setWorkers] = useState<any[]>([]);
  const [history, setHistory] = useState(false),
    [filter, setFilter] = useState(''),
    [selected, setSelected] = useState<any>();
  const [view, setView] = useState<'automation' | 'work'>('work');
  const [manual, setManual] = useState(false),
    [reviewRuns, setReviewRuns] = useState<any[]>([]);
  const delegation =
    data.plugins.some((p: any) => p.id === 'delegation' && p.enabled) &&
    data.characters.some((r: any) => r.id === personaId);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const results = await Promise.allSettled([
        rpc('automation.catalog'),
        delegation ? rpc('delegation.list', { personaId }) : Promise.resolve([]),
        data.plugins.some((p: any) => p.id === 'review' && p.enabled)
          ? rpc('review.list')
          : Promise.resolve([]),
      ]);
      if (!alive) return;
      if (results[0].status === 'fulfilled') setCatalog(results[0].value);
      if (results[1].status === 'fulfilled') setWorkers(results[1].value);
      if (results[2].status === 'fulfilled') setReviewRuns(results[2].value);
    };
    void load();
    const update = (event: any) => {
      if (
        /^(automation\.|delegation\.|review\.|run\.|interaction\.|observation\.)/.test(
          event.detail.type,
        )
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 180);
      }
    };
    window.addEventListener('echo-event', update);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener('echo-event', update);
    };
  }, [personaId, delegation]);
  const roleTasks = data.characters.find((r: any) => r.id === personaId)?.taskIds ?? [];
  const automations = catalog.types.flatMap((type: any) =>
    type.items
      .filter(
        (item: any) =>
          (item.personaId ?? item.settings?.personaId) === personaId ||
          roleTasks.some((r: any) => r.id === item.id && r.type === type.id),
      )
      .map((item: any) => ({
        key: type.id + ':' + item.id,
        id: item.id,
        name: item.name,
        type: type.id,
        typeName: type.name,
        kind: 'automation',
        item,
        definition: type,
        ended: false,
        label: (
          {
            running: '执行中',
            waiting: '等待触发',
            paused: '已暂停',
            failed: '需要检查',
            unavailable: '当前不可用',
            completed: '已完成',
          } as any
        )[item.state],
      })),
  );
  const rows = [
    ...automations,
    ...workers.map((task: any) => ({
      key: task.id,
      id: task.id,
      name: task.goal,
      type: 'delegation',
      typeName: '任务委派',
      kind: 'worker',
      lifetime: task.lifetime ?? 'once',
      ...taskPresentation(task),
      inactive: taskPresentation(task).ended || task.lifecycle === 'paused',
    })),
  ].filter((row) =>
    view === 'automation'
      ? row.kind === 'automation'
      : row.kind === 'worker' &&
        ('inactive' in row && row.inactive) === history &&
        (!filter || ('lifetime' in row && row.lifetime === filter)),
  );
  const current =
    selected?.kind === 'automation'
      ? automations.find((row: any) => row.key === selected.key)
      : selected;
  return (
    <div className="task-workspace">
      <div className="page-title page-title-actions">
        <h1>{t('任务')}</h1>
        <Button
          secondary={view === 'work'}
          onClick={() => (view === 'automation' ? configureRole() : setManual(true))}
        >
          {t(view === 'automation' ? '添加自动化' : '手动委派')}
        </Button>
      </div>
      <div className="page-sheets" role="tablist" aria-label={t('任务类别')}>
        <button
          role="tab"
          aria-selected={view === 'automation'}
          className={view === 'automation' ? 'active' : ''}
          onClick={() => {
            setView('automation');
            setSelected(undefined);
            setManual(false);
          }}
        >
          {t('自动化')}
        </button>
        {delegation && (
          <button
            role="tab"
            aria-selected={view === 'work'}
            className={view === 'work' ? 'active' : ''}
            onClick={() => {
              setView('work');
              setSelected(undefined);
              setManual(false);
            }}
          >
            {t('子任务')}
          </button>
        )}
      </div>
      {manual ? (
        <>
          <Button secondary onClick={() => setManual(false)}>
            {t('返回任务列表')}
          </Button>
          <DelegationView {...{ data, act, personaId, setPage }} />
        </>
      ) : current ? (
        <>
          <Button secondary onClick={() => setSelected(undefined)}>
            {t('返回任务列表')}
          </Button>
          {current.kind === 'worker' ? (
            <DelegationView
              {...{ data, act, personaId, setPage }}
              selectedTaskId={current.id}
              detailOnly
            />
          ) : (
            <>
              <AutomationView
                {...{ act, openTask, personaId }}
                only={current.type}
                focusId={current.id}
                detailOnly
                roleTasks={roleTasks}
              />
              {current.type === 'review.policies' && (
                <section className="task-run-history">
                  <h2>{t('历次运行')}</h2>
                  {reviewRuns
                    .filter((run) => run.policy?.id === current.id)
                    .map((run) => (
                      <article key={run.id} className="card">
                        <strong>{new Date(run.createdAt).toLocaleString()}</strong>
                        <span> · {t(run.state)}</span>
                        <p>{run.report ?? run.error ?? run.notes}</p>
                        <p>
                          {run.nextPacket} / {run.totalPackets}
                        </p>
                        {run.state === 'paused' && <ReviewResume run={run} act={act} />}
                        {run.state === 'completed' && !run.applied && (
                          <Button
                            secondary
                            onClick={() =>
                              act(() => rpc('review.apply', { id: run.id, confirmed: true }))
                            }
                          >
                            {t('应用整理建议')}
                          </Button>
                        )}
                      </article>
                    ))}
                </section>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {view === 'work' && (
            <div className="task-list-toolbar">
              <div className="page-sheets" role="tablist" aria-label={t('任务列表')}>
                <button
                  role="tab"
                  aria-selected={!history}
                  className={!history ? 'active' : ''}
                  onClick={() => setHistory(false)}
                >
                  {t('活跃')}
                </button>
                <button
                  role="tab"
                  aria-selected={history}
                  className={history ? 'active' : ''}
                  onClick={() => setHistory(true)}
                >
                  {t('非活跃')}
                </button>
              </div>
              <select
                aria-label={t('持续方式')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">{t('全部任务')}</option>
                <option value="once">{t('一次性任务')}</option>
                <option value="continuous">{t('持续任务')}</option>
              </select>
            </div>
          )}
          <div className="task-record-list">
            {rows.map((row: any) => (
              <button
                className="task-record"
                key={row.key}
                onClick={() => {
                  if (row.definition?.statusPage && row.definition.statusPage !== 'automation')
                    openTask(row.definition.statusPage, row.type, row.id, 'status');
                  else setSelected(row);
                }}
              >
                <span>
                  <strong>{row.name}</strong>
                  <small>
                    {t(row.typeName)}
                    {row.kind === 'worker' && (
                      <> · {t(row.lifetime === 'once' ? '一次性任务' : '持续任务')}</>
                    )}
                  </small>
                </span>
                <span className="state-pill">
                  {t(row.item?.suspendedByCharacter ? '角色已停用' : row.label)}
                </span>
                <small>{row.item?.nextAt ? new Date(row.item.nextAt).toLocaleString() : ''}</small>
              </button>
            ))}
          </div>
          {!rows.length && (
            <EmptyState
              title={t(
                view === 'automation' ? '暂无自动化' : history ? '暂无非活跃子任务' : '暂无子任务',
              )}
            />
          )}
        </>
      )}
    </div>
  );
}
