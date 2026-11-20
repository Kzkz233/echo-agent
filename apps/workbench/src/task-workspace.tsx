import { useTaskCatalog } from './use-task-catalog.ts';
import { FailurePanel } from './task-failure.tsx';
import { RecordedTasks, TaskHistory } from './task-history.tsx';
import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, EmptyState } from './ui.tsx';
import { DelegationView } from './character-workspace.tsx';
import { AutomationView } from './automation-view.tsx';
import { ReviewResume } from './review-resume.tsx';
import { TaskModelDetails } from './task-model-details.tsx';
import { ReviewCandidates } from './review-candidates.tsx';
import { ChatView } from './chat-view.tsx';
import { PageTabs } from './page-header.tsx';
import { taskPresentation } from '../../../packages/contracts/tasks.ts';

export function TaskWorkspace({ data, act, personaId, setPage, openTask, configureRole }: any) {
  const stateKey = 'echo.task-view.' + personaId;
  const [saved] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(stateKey) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  });
  const { catalog, ready, error:catalogError } = useTaskCatalog();
  const [workers, setWorkers] = useState<any[]>([]);
  const [history, setHistory] = useState(saved.history === true),
    [filter, setFilter] = useState(typeof saved.filter === 'string' ? saved.filter : ''),
    [selected, setSelected] = useState<any>(
      typeof saved.selected === 'string' ? { key: saved.selected } : undefined,
    );
  const [view, setView] = useState<'automation' | 'work'>(
    saved.view === 'automation' ? 'automation' : 'work',
  );
  const [manual, setManual] = useState(false),
    [reviewRuns, setReviewRuns] = useState<any[]>([]);
  const [workSessions, setWorkSessions] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        stateKey,
        JSON.stringify({ view, history, filter, selected: selected?.key }),
      );
    } catch {}
  }, [stateKey, view, history, filter, selected?.key]);
  const delegation =
    data.plugins.some((p: any) => p.id === 'delegation' && p.enabled) &&
    data.characters.some((r: any) => r.id === personaId);
  const canDelegate = delegation && data.characters.some((r: any) => r.id === personaId && r.features.includes('delegation'));
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const results = await Promise.allSettled([
        delegation ? rpc('delegation.list', { personaId }) : Promise.resolve([]),
        data.plugins.some((p: any) => p.id === 'review' && p.enabled)
          ? rpc('review.list')
          : Promise.resolve([]),
        rpc('work.list', { personaId }),
      ]);
      if (!alive) return;
      if (results[0].status === 'fulfilled') setWorkers(results[0].value);
      if (results[1].status === 'fulfilled') setReviewRuns(results[1].value);
      if (results[2].status === 'fulfilled') setWorkSessions(results[2].value);
      setLoaded(true);
    };
    void load();
    const update = (event: any) => {
      if (
        /^(work\.|automation\.|delegation\.|review\.|run\.(started|completed)|interaction\.|observation\.|characters\.updated|binding\.changed|inference\.)/.test(
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
  const allRows = [
    ...automations,
    ...workSessions
      .filter((work) => work.origin.type !== 'delegation')
      .map((work) => ({
        ...work,
        key: work.id,
        name: work.title,
        type: work.origin.type,
        typeName: work.origin.name,
        kind: 'worker',
        managed: true,
        lifetime: work.persistent === false ? 'once' : 'continuous',
        inactive:
          !automations.some(
            (task: any) =>
              task.type === work.origin.type &&
              task.id === work.origin.id &&
              task.item.enabled &&
              !task.item.suspendedByCharacter,
          ) ||
          (work.persistent === false && !['running', 'waiting'].includes(work.state)),
        label: (
          {
            running: '执行中',
            waiting: '等待确认',
            idle: '等待触发',
            failed: '执行失败',
            unknown: '结果待核对',
            cancelled: '已停止',
          } as Record<string, string>
        )[work.state],
      })),
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
  ];
  const rows = allRows.filter((row) =>
    view === 'automation'
      ? row.kind === 'automation'
      : row.kind === 'worker' &&
        ('inactive' in row && row.inactive) === history &&
        (!filter || ('lifetime' in row && row.lifetime === filter)),
  );
  const current = selected ? allRows.find((row) => row.key === selected.key) : undefined;
  return (
    <div className="task-workspace">
      <div className="page-title page-title-actions">
        <h1>{t('任务')}</h1>
        {(view === 'automation' || canDelegate) && (
          <Button
            secondary={view === 'work'}
            onClick={() => (view === 'automation' ? configureRole() : setManual(true))}
          >
            {t(view === 'automation' ? '添加自动化' : '手动委派')}
          </Button>
        )}
      </div>
      <PageTabs
        label="任务类别"
        prefix="task"
        controls="task-panel"
        items={[
          { id: 'automation', text: '自动化' },
          { id: 'work', text: '子任务' },
        ]}
        selected={view}
        onSelect={(id) => {
          setView(id as 'automation' | 'work');
          setSelected(undefined);
          setManual(false);
        }}
      />
      <div id="task-panel" role="tabpanel" aria-labelledby={'task-' + view}>
        {view === 'automation' && !!catalog.unavailable?.length && <p role="status">{t('无法读取任务类型')} · {catalog.unavailable.join(' · ')}</p>}
        {catalogError && <p role="alert">{catalogError}</p>}
        {!loaded || !ready ? <EmptyState title={t('正在打开…')} /> : manual ? (
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
            {current.kind === 'worker' && <TaskHistory act={act} personaId={personaId} type={current.managed ? current.origin.type : 'delegation'} id={current.managed ? current.origin.id : current.id}/>}
            {current.background ? (
              <AutomationView
                {...{ act, openTask, personaId }}
                only={current.type}
                focusId={current.id}
                detailOnly
                roleTasks={roleTasks}
              />
            ) : current.managed ? (
              <section>
                <div className="page-title page-title-actions">
                  <h2>{current.name}</h2>
                  <Button
                    secondary
                    onClick={() =>
                      openTask('automation', current.origin.type, current.origin.id, 'edit')
                    }
                  >
                    {t('来源自动化任务')}
                  </Button>
                </div>
                <p>{t('执行设置由来源任务管理。')}</p>
                {current.failure && <FailurePanel key={current.id + current.error} failure={current.failure}/>}
                {['running', 'waiting'].includes(current.state) && (
                  <Button
                    secondary
                    onClick={() => act(() => rpc('work.cancel', { id: current.id }))}
                  >
                    {t('停止本次执行')}
                  </Button>
                )}
                <ChatView
                  {...{ data, act, setPage, openTask }}
                  fixedConversationId={current.conversationId}
                  surface="session"
                  managedSettings
                />
              </section>
            ) : current.kind === 'worker' ? (
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
                          {run.taskModel && <TaskModelDetails model={run.taskModel} />}
                          {run.state === 'paused' && <ReviewResume run={run} act={act} />}
                          {run.checkpointFlow && <ReviewCandidates jobId={run.id} />}
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
                  onClick={() => setSelected(row)}
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
                  <small>
                    {row.item?.nextAt ? new Date(row.item.nextAt).toLocaleString() : ''}
                  </small>
                </button>
              ))}
            </div>
            {view === 'automation' && <RecordedTasks key={personaId} personaId={personaId} act={act}/>}
            {!rows.length && (
              <EmptyState
                title={t(
                  view === 'automation'
                    ? '暂无自动化'
                    : history
                      ? '暂无非活跃子任务'
                      : '暂无子任务',
                )}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
