import { lazy, useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { statusText, t } from './i18n.ts';
import { Button, EmptyState, useConfirm, PathInput } from './ui.tsx';
import { ModelChoice } from './model-choice.tsx';
import { ReasoningSelect } from './reasoning-select.tsx';
import { ChatView } from './chat-view.tsx';
import { ConversationInteractions } from './host-interactions.tsx';
const RunTrace = lazy(() => import('./run-trace.tsx'));

export function CharacterHome({ role, data, act, edit, openTask, setPage }: any) {
  const confirm = useConfirm();
  const [character, setCharacter] = useState<any>();
  const activity = data.characterActivities?.[role.id] ?? { enabled: true, revision: 0 };
  useEffect(() => {
    let alive = true;
    rpc('persona.character.read', { id: role.id }).then((value) => {
      if (alive) setCharacter(value);
    });
    return () => {
      alive = false;
    };
  }, [role.id, data.characters]);
  const exportRole = () =>
    act(async () => {
      const pack = await rpc('persona.package.export', {
        personaId: role.id,
        packageId: role.id,
        version: '1.0.0',
      });
      if (
        !(await confirm({
          title: t('核对角色包'),
          confirmLabel: t('导出角色包'),
          description: (
            <>
              <p>
                {pack.name} · {pack.version}
              </p>
              <p>
                {pack.features
                  .map((feature: any) =>
                    t(
                      data.plugins.find((plugin: any) => plugin.id === feature.id)?.name ??
                        feature.id,
                    ),
                  )
                  .join(' · ')}
              </p>
              <p>
                {t('任务模板')} · {pack.tasks.length}　{t('素材大小')} ·{' '}
                {(
                  JSON.stringify(pack.features.map((f: any) => f.assets ?? {})).length / 1024
                ).toFixed(0)}{' '}
                KB
              </p>
              <p>{t('包含角色设定、任务提示词及所选素材。请确认这些内容适合分享。')}</p>
              <details>
                <summary>{t('角色人设')}</summary>
                <div className="readable-pre">{pack.persona.prompt}</div>
              </details>
              {pack.tasks.map((task: any) => (
                <details key={task.id}>
                  <summary>
                    {t('任务模板')} · {task.type}
                  </summary>
                  <div className="readable-pre">
                    {Object.entries(task.settings)
                      .map(([key, value]) => key + '\n' + String(value))
                      .join('\n\n')}
                  </div>
                </details>
              ))}
            </>
          ),
        }))
      )
        return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = role.name + '.echo-character.json';
      link.click();
      URL.revokeObjectURL(url);
    }, '');
  return (
    <div className="character-home">
      <header className="character-home-heading">
        <div>
          <h1>{role.name}</h1>
          {!activity.enabled && <span className="state-pill">{t('角色已停用')}</span>}
          <span>{character?.state === 'needs-attention' ? character.issue : ''}</span>
        </div>
        <div className="row">
          <Button
            secondary
            onClick={() =>
              act(() =>
                rpc('characters.setActive', {
                  personaId: role.id,
                  enabled: !activity.enabled,
                  revision: activity.revision,
                }),
              )
            }
          >
            {t(activity.enabled ? '停用角色' : '启用角色')}
          </Button>
          {character?.features.includes('avatar') &&
            data.plugins.some((plugin: any) => plugin.id === 'avatar' && plugin.enabled) && (
              <Button
                secondary
                disabled={!activity.enabled}
                onClick={() =>
                  act(() =>
                    rpc('avatar.configureRole', {
                      personaId: role.id,
                      patch: { enabled: !data.avatarProfiles?.[role.id]?.enabled },
                    }),
                  )
                }
              >
                {t(data.avatarProfiles?.[role.id]?.enabled ? '隐藏桌宠' : '显示桌宠')}
              </Button>
            )}
          <Button secondary onClick={exportRole}>
            {t('导出角色包')}
          </Button>
          <Button secondary onClick={() => edit(role)}>
            {t('配置角色')}
          </Button>
        </div>
      </header>
      {!activity.enabled && (
        <p className="muted">{t('任务、会话和桌宠已暂停，配置与历史保留。')}</p>
      )}
      {character?.mainConversationId ? (
        <ChatView
          {...{ data, act, setPage, openTask }}
          editRole={edit}
          fixedConversationId={character.mainConversationId}
        />
      ) : (
        <EmptyState title={t(character ? '完成角色配置后开始交流' : '正在打开…')} />
      )}
    </div>
  );
}
export function DelegationView({
  data,
  act,
  personaId,
  setPage,
  selectedTaskId,
  detailOnly = false,
}: any) {
  const [tasks, setTasks] = useState<any[]>([]),
    [current, setCurrent] = useState(''),
    [goal, setGoal] = useState(''),
    [acceptance, setAcceptance] = useState(''),
    [configuration, setConfiguration] = useState<any>(),
    [profileId, setProfileId] = useState(''),
    [reviewText, setReviewText] = useState(''),
    [text, setText] = useState('');
  const [lifetime, setLifetime] = useState('once'),
    [contextMode, setContextMode] = useState('continue');
  const [workspace, setWorkspace] = useState(''),
    [write, setWrite] = useState(false),
    [terminal, setTerminal] = useState(false),
    [fullAccess, setFullAccess] = useState(false);
  const [tools, setTools] = useState<string[]>([]),
    [reasoning, setReasoning] = useState('inherit'),
    [instructions, setInstructions] = useState('');
  const [extraRoots, setExtraRoots] = useState<{ path: string; write: boolean }[]>([]);
  const [timeoutMinutes, setTimeoutMinutes] = useState(20);
  const [attempts, setAttempts] = useState<any[]>([]);
  useEffect(() => {
    if (selectedTaskId) setCurrent(selectedTaskId);
  }, [selectedTaskId]);
  useEffect(() => {
    if (current)
      void rpc<any[]>('delegation.history', { taskId: current, personaId }).then(setAttempts);
  }, [current, tasks]);
  const load = () => rpc('delegation.list', { personaId }).then(setTasks);
  useEffect(() => {
    void load();
    void rpc('persona.character.read', { id: personaId }).then((value) => {
      const policy = value.configurations.delegation;
      setConfiguration(policy);
      setWorkspace(policy.workspaces[0]?.path ?? '');
      setTools((policy.toolPermissions ?? []).filter((p: string) => p.endsWith('.read')));
      setTimeoutMinutes(Math.min(20, policy.timeoutMinutes));
    });
    const handler = (e: any) => {
      if (
        e.detail.type.startsWith('delegation.') ||
        e.detail.type === 'interaction.changed' ||
        e.detail.type === 'run.started'
      )
        void load();
    };
    window.addEventListener('echo-event', handler);
    return () => window.removeEventListener('echo-event', handler);
  }, [personaId]);
  const task = tasks.find((row) => row.id === current),
    main =
      data.characters.find((row: any) => row.id === personaId)?.mainConversationId ??
      data.conversations.find(
        (row: any) =>
          row.personaId === personaId && row.kind !== 'worker' && row.kind !== 'group-member',
      )?.id;
  const mainProfile = data.conversations.find((c: any) => c.id === main)?.binding?.profileId;
  const allowedProfiles = data.profiles.filter(
    (p: any) => p.id === mainProfile || configuration?.allowedProfileIds.includes(p.id),
  );
  const canChooseFull = configuration?.allowFullAccess && configuration.approvals !== 'deny' &&
    allowedProfiles.some((profile: any) => profile.id === (profileId || mainProfile) && ['api', 'pi'].includes(profile.kind));
  const states: Record<string, string> = {
    queued: '等待执行',
    running: '执行中',
    waiting: '等待确认',
    completed: '执行完成',
    failed: '执行失败',
    cancelled: '已停止',
    unknown: '结果待核对',
  };
  return (
    <div className="delegation-workspace">
      {!detailOnly && (
        <>
          <h1>{t('手动委派子任务')}</h1>
          <details className="card" open>
            <summary>{t('任务目标')}</summary>
            <label className="field">
              <span>{t('工作目标')}</span>
              <textarea
                aria-label={t('工作目标')}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <label className="field">
              <span>{t('验收要求')}</span>
              <textarea
                aria-label={t('验收要求')}
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
              />
            </label>
            <PathInput label="工作目录" value={workspace} onChange={setWorkspace} directory />
            <details className="card">
              <summary>{t('本次执行设置')}</summary>
              <ModelChoice
                label="执行模型"
                data={{ ...data, profiles: allowedProfiles }}
                executor
                value={profileId}
                onChange={setProfileId}
                inheritValue={mainProfile}
              />
              <ReasoningSelect
                label="思考强度"
                value={reasoning}
                onChange={setReasoning}
                profileId={profileId || mainProfile}
              />
              <label className="field">
                <span>{t('本次执行时限（分钟）')}</span>
                <input
                  type="number"
                  min={1}
                  max={configuration?.timeoutMinutes ?? 120}
                  value={timeoutMinutes}
                  onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
                />
              </label>
              <label className="inline-toggle">
                <input
                  type="checkbox"
                  checked={write}
                  disabled={configuration?.approvals === 'deny'}
                  onChange={(e) => {
                    setWrite(e.target.checked);
                    if (!e.target.checked) setTerminal(false);
                  }}
                />
                {t('本次允许修改文件')}
              </label>
              {canChooseFull && <label className="inline-toggle">
                <input type="checkbox" checked={fullAccess} onChange={(event) => setFullAccess(event.target.checked)} />
                {t('本任务使用本机完全访问')}
              </label>}
              {configuration?.terminal && (
                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={terminal}
                    disabled={!write || configuration.approvals === 'deny'}
                    onChange={(e) => setTerminal(e.target.checked)}
                  />
                  {t('本次请求终端命令')}
                </label>
              )}
              <p className="muted">
                {t('操作审批')} · {t(configuration?.approvals === 'deny' ? '不允许' : configuration?.approvalReviewer === 'main' ? '主会话代审' : '逐次确认')}
              </p>
              <fieldset className="automation-options">
                <legend>{t('附加工作目录')}</legend>
                {(configuration?.workspaces ?? [])
                  .filter((r: any) => r.path !== workspace)
                  .map((root: any) => {
                    const selected = extraRoots.find((r) => r.path === root.path);
                    return (
                      <div key={root.path} className="row wrap">
                        <label className="inline-toggle">
                          <input
                            type="checkbox"
                            checked={!!selected}
                            onChange={(e) =>
                              setExtraRoots(
                                e.target.checked
                                  ? [...extraRoots, { path: root.path, write: false }]
                                  : extraRoots.filter((r) => r.path !== root.path),
                              )
                            }
                          />
                          {root.path}
                        </label>
                        {selected && root.write && write && (
                          <label className="inline-toggle">
                            <input
                              type="checkbox"
                              checked={selected.write}
                              onChange={(e) =>
                                setExtraRoots(
                                  extraRoots.map((r) =>
                                    r.path === root.path ? { ...r, write: e.target.checked } : r,
                                  ),
                                )
                              }
                            />
                            {t('允许写入')}
                          </label>
                        )}
                      </div>
                    );
                  })}
              </fieldset>
              <fieldset className="automation-options">
                <legend>{t('本次应用工具权限')}</legend>
                {(configuration?.toolPermissions ?? []).map((permission: string) => {
                  const item = data.mcpPermissionCatalog.find(
                    (p: any) => p.permission === permission,
                  );
                  const owners = item?.owners
                    .map((id: string) =>
                      t(data.plugins.find((p: any) => p.id === id)?.name ?? '共享模块'),
                    )
                    .join(' · ');
                  return (
                    <label className="inline-toggle" key={permission}>
                      <input
                        type="checkbox"
                        checked={tools.includes(permission)}
                        onChange={(e) =>
                          setTools(
                            e.target.checked
                              ? [...tools, permission]
                              : tools.filter((p) => p !== permission),
                          )
                        }
                      />
                      {owners} ·{' '}
                      {t(
                        permission.endsWith('.read')
                          ? '读取'
                          : permission.endsWith('.write')
                            ? '修改'
                            : '调用',
                      )}
                    </label>
                  );
                })}
              </fieldset>
              <label className="field">
                <span>{t('子任务补充指引')}</span>
                <textarea
                  aria-label={t('子任务补充指引')}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </label>
            </details>
            <div className="form-grid">
              <label className="field">
                <span>{t('持续方式')}</span>
                <select value={lifetime} onChange={(e) => setLifetime(e.target.value)}>
                  <option value="once">{t('一次性任务')}</option>
                  <option value="continuous">{t('持续任务')}</option>
                </select>
              </label>
              <label className="field">
                <span>{t('任务上下文')}</span>
                <select value={contextMode} onChange={(e) => setContextMode(e.target.value)}>
                  <option value="continue">{t('延续工作会话')}</option>
                  <option value="fresh">{t('每次独立执行')}</option>
                </select>
              </label>
            </div>
            <Button
              disabled={
                data.characterActivities?.[personaId]?.enabled === false ||
                !main ||
                !goal.trim() ||
                !acceptance.trim()
              }
              onClick={() =>
                act(async () => {
                  const task = await rpc('delegation.request', {
                    conversationId: main,
                    requestId: crypto.randomUUID(),
                    goal,
                    acceptance,
                    execution: {
                      profileId: profileId || undefined,
                      projectDirectory: workspace,
                      write,
                      fullAccess: canChooseFull && fullAccess ? true : undefined,
                      terminal,
                      reasoning,
                      timeoutMinutes,
                      prompt: instructions,
                      toolPermissions: tools,
                      workspaces: extraRoots
                        .filter((r) => r.path !== workspace)
                        .map((r) => ({ ...r, write: write && r.write })),
                    },
                    lifetime,
                    contextMode,
                  });
                  setCurrent(task.id);
                  setGoal('');
                  setAcceptance('');
                  await load();
                }, t('任务已受理'))
              }
            >
              {t('委派子任务')}
            </Button>
          </details>
          <div className="task-tabs">
            {tasks.map((task) => (
              <button
                key={task.id}
                className={task.id === current ? 'active' : ''}
                onClick={() => setCurrent(task.id)}
              >
                {task.goal.slice(0, 36)} · {t(states[task.state])}
              </button>
            ))}
          </div>
        </>
      )}
      {task && (
        <section className="card">
          <div className="row">
            <h2>{task.goal}</h2>
            <span className="state-pill">{t(states[task.state])}</span>
          </div>
          <p>{task.acceptance}</p>
          <div className="row wrap">
            <span className="state-pill">
              {t(task.lifetime === 'continuous' ? '持续任务' : '一次性任务')}
            </span>
            <span>{t(task.contextMode === 'fresh' ? '每次独立执行' : '延续工作会话')}</span>
          </div>
          <p className="muted">
            {task.template?.name} ·{' '}
            {data.profiles.find((profile: any) => profile.id === task.profileId)?.name} ·{' '}
            {t(
              ({ pending: '待验收', accepted: '验收通过', 'needs-work': '需要返工' } as any)[
                task.acceptanceStatus
              ] ?? '待验收',
            )}
          </p>
          {task.runId && (
            <RunTrace
              runId={task.runId}
              active={task.state === 'running' || task.state === 'waiting'}
            />
          )}
          <ConversationInteractions id={task.workerConversationId} act={act} />
          {task.approvalReviews?.length > 0 && <details>
            <summary>{t('主会话代审记录')}</summary>
            <ul>{task.approvalReviews.map((review: any, index: number) => <li key={index}>
              {t(review.decision === 'allow' ? '已批准' : '已拒绝')} · {review.path}
            </li>)}</ul>
          </details>}
          {task.error && <p className="warning">{task.error}</p>}
          {task.checkpoint && (
            <section>
              <h3>{t('最近检查点')}</h3>
              <pre className="readable-pre">{task.checkpoint.text}</pre>
              {task.checkpoint.artifacts.map((path: string) => (
                <p key={path}>{path}</p>
              ))}
            </section>
          )}
          {task.result && <pre className="readable-pre">{task.result}</pre>}
          {task.report && (
            <section className="worker-evidence">
              <h3>{t('交付证据')}</h3>
              <p>{task.report.verification}</p>
              {task.report.unresolved && <p className="warning">{task.report.unresolved}</p>}
              {(task.evidence ?? []).map((evidence: any) => (
                <p key={evidence.path}>
                  {evidence.path} ·{' '}
                  {t(
                    evidence.state === 'verified'
                      ? '文件已核验'
                      : evidence.state === 'outside'
                        ? '超出项目范围'
                        : '文件缺失',
                  )}
                  {evidence.sha256 && <small> · SHA-256 {evidence.sha256.slice(0, 16)}</small>}
                </p>
              ))}
            </section>
          )}
          {task.review && <p>{task.review.text}</p>}
          {task.state === 'completed' && (
            <div className="field">
              <label className="field">
                <span>{t('验收意见')}</span>
                <textarea value={reviewText} onChange={(e) => setReviewText(e.target.value)} />
              </label>
              <div className="row">
                {['accepted', 'needs-work'].map((decision) => (
                  <Button
                    key={decision}
                    secondary
                    disabled={!reviewText.trim()}
                    onClick={() =>
                      act(async () => {
                        await rpc('delegation.review', {
                          taskId: task.id,
                          attempt: task.attempt,
                          conversationId: main,
                          decision,
                          text: reviewText,
                        });
                        setReviewText('');
                        await load();
                      })
                    }
                  >
                    {t(decision === 'accepted' ? '验收通过' : '需要返工')}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="row wrap">
            {!['running', 'waiting', 'queued', 'unknown'].includes(task.state) &&
              task.lifetime === 'continuous' &&
              ['paused', 'active', 'ended']
                .filter((state) => state !== (task.lifecycle ?? 'active'))
                .map((state) => (
                  <Button
                    key={state}
                    secondary
                    onClick={() =>
                      act(async () => {
                        await rpc('delegation.lifecycle', {
                          taskId: task.id,
                          conversationId: main,
                          lifecycle: state,
                        });
                        await load();
                      })
                    }
                  >
                    {t(
                      state === 'paused' ? '暂停任务' : state === 'ended' ? '结束任务' : '恢复任务',
                    )}
                  </Button>
                ))}
            <Button
              secondary
              onClick={() => {
                sessionStorage.setItem('echo.chat', task.workerConversationId);
                setPage('chat');
              }}
            >
              {t('打开子任务会话')}
            </Button>
            {['running', 'waiting', 'queued'].includes(task.state) && (
              <Button
                secondary
                onClick={() =>
                  act(
                    () => rpc('delegation.cancel', { taskId: task.id, conversationId: main }),
                    t('已请求停止'),
                  )
                }
              >
                {t('停止')}
              </Button>
            )}
            {task.state === 'unknown' && (
              <Button
                secondary
                onClick={() =>
                  act(async () => {
                    await rpc('delegation.reconcile', { taskId: task.id, conversationId: main });
                    await load();
                  })
                }
              >
                {t('核对运行结果')}
              </Button>
            )}
          </div>
          {['completed', 'failed', 'cancelled'].includes(task.state) && (
            <div className="field">
              <textarea
                aria-label={t('补充任务说明')}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <Button
                disabled={!text.trim()}
                onClick={() =>
                  act(async () => {
                    await rpc('delegation.resume', {
                      taskId: task.id,
                      conversationId: main,
                      text,
                      requestId: crypto.randomUUID(),
                    });
                    setText('');
                    await load();
                  }, t('已继续任务'))
                }
              >
                {t('继续任务')}
              </Button>
            </div>
          )}
          {!!attempts.length && (
            <details className="task-run-history">
              <summary>
                {t('历次运行')} · {attempts.length}
              </summary>
              {attempts.map((attempt) => (
                <article key={attempt.attempt} className="card">
                  <strong>
                    #{attempt.attempt} · {t(states[attempt.state])}
                  </strong>
                  <p className="muted">
                    {attempt.finishedAt && new Date(attempt.finishedAt).toLocaleString()}
                  </p>
                  <pre className="readable-pre">
                    {attempt.report?.summary ?? attempt.result ?? attempt.error}
                  </pre>
                  {attempt.review && <p>{attempt.review.text}</p>}
                </article>
              ))}
            </details>
          )}
        </section>
      )}
    </div>
  );
}
export function GroupView({ data, act, groupId, onSelect, setPage }: any) {
  const [state, setState] = useState<any>({
      messages: [],
      turns: [],
      conversations: [],
      busy: false,
    }),
    [text, setText] = useState(''),
    [speakers, setSpeakers] = useState<string[]>([]),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(''),
    [members, setMembers] = useState<string[]>([]),
    [groupPrompt, setGroupPrompt] = useState(''),
    [historyWindow, setHistoryWindow] = useState(40),
    [context, setContext] = useState('');
  const group = data.groups?.find((g: any) => g.id === groupId);
  const turns = new Map<string, { state: string; error?: string }>(
    state.turns.map((turn: any) => [turn.id, turn]),
  );
  const load = () =>
    groupId ? rpc('groups.messages', { id: groupId }).then(setState) : Promise.resolve();
  useEffect(() => {
    setSpeakers(
      group?.members
        ?.filter((id: string) => data.characterActivities?.[id]?.enabled !== false)
        .slice(0, 1) ?? [],
    );
    void load();
    const handler = (e: any) => {
      if (e.detail.type === 'groups.updated' || e.detail.type === 'interaction.changed')
        void load();
    };
    window.addEventListener('echo-event', handler);
    return () => window.removeEventListener('echo-event', handler);
  }, [groupId, group?.revision]);
  useEffect(() => {
    setSpeakers((previous) =>
      previous.filter((id) => data.characterActivities?.[id]?.enabled !== false),
    );
  }, [data.characterActivities]);
  const startEdit = () => {
    setEditing(true);
    setName(group?.name ?? '');
    setMembers(group?.members ?? []);
    setContext(group?.context ?? '');
    setGroupPrompt(group?.prompt ?? '');
    setHistoryWindow(group?.historyWindow ?? 40);
  };
  const send = () =>
    act(async () => {
      await rpc('groups.send', { groupId, text, speakers, requestId: crypto.randomUUID() });
      setText('');
      await load();
    }, '');
  return (
    <div className="group-workspace">
      <div className="page-title page-title-actions">
        <h1>{group?.name ?? t('群聊')}</h1>
        <Button secondary onClick={startEdit}>
          {t(group ? '群聊设置' : '创建群聊')}
        </Button>
      </div>
      {editing && (
        <section className="card">
          <label className="field">
            <span>{t('群聊名称')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <fieldset className="automation-options">
            <legend>{t('成员')}</legend>
            {data.personas.map((role: any) => (
              <label className="inline-toggle" key={role.id}>
                <input
                  type="checkbox"
                  checked={members.includes(role.id)}
                  onChange={(e) =>
                    setMembers(
                      e.target.checked
                        ? [...members, role.id]
                        : members.filter((id) => id !== role.id),
                    )
                  }
                />
                {role.name}
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>{t('共享资料')}</span>
            <textarea value={context} onChange={(e) => setContext(e.target.value)} />
          </label>
          <Button
            disabled={!name.trim() || !members.length}
            onClick={() =>
              act(async () => {
                const saved = await rpc('groups.save', {
                  id: group?.id ?? crypto.randomUUID(),
                  revision: group?.revision ?? 0,
                  name,
                  members,
                  context,
                  ...(groupPrompt.trim() ? { prompt: groupPrompt } : {}),
                  historyWindow,
                });
                setEditing(false);
                onSelect(saved.id);
              })
            }
          >
            {t('保存')}
          </Button>
          <details>
            <summary>{t('群聊上下文')}</summary>
            <label className="field">
              <span>{t('讨论规则')}</span>
              <textarea value={groupPrompt} onChange={(e) => setGroupPrompt(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('新增共享记录窗口')}</span>
              <input
                type="number"
                min={5}
                max={100}
                value={historyWindow}
                onChange={(e) => setHistoryWindow(Number(e.target.value))}
              />
            </label>
          </details>
        </section>
      )}
      {group && (
        <>
          <div className="group-messages">
            {state.messages.map((m: any) => (
              <article key={m.id} className={'group-message ' + m.role}>
                <strong>{m.meta.authorName ?? t('你')}</strong>
                <div className="readable-pre">{m.text}</div>
                {turns.get(m.id)?.state === 'running' && (
                  <small role="status">{t('执行中')}</small>
                )}
                {turns.get(m.id)?.error && (
                  <p className="warning readable-pre">
                    <strong>{statusText(turns.get(m.id)!.state)}</strong> · {turns.get(m.id)?.error}
                  </p>
                )}
              </article>
            ))}
          </div>
          {state.conversations.map((c: any) => (
            <ConversationInteractions key={c.id} id={c.id} act={act} />
          ))}
          {state.turns.some((turn: any) => turn.state === 'unknown') && (
            <div className="card row wrap">
              {state.conversations.map((chat: any) => (
                <Button
                  key={chat.id}
                  secondary
                  onClick={() => {
                    sessionStorage.setItem('echo.chat', chat.id);
                    setPage('chat');
                  }}
                >
                  {chat.title}
                </Button>
              ))}
              <Button
                secondary
                onClick={() =>
                  act(async () => {
                    await rpc('groups.resolve', { id: groupId, confirmed: true });
                    await load();
                  })
                }
              >
                {t('核对并恢复群聊')}
              </Button>
            </div>
          )}
          <div className="group-composer">
            <div className="row wrap">
              <span>{t('请谁回应')}</span>
              {group.members.map((id: string) => (
                <label key={id} className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={speakers.includes(id)}
                    disabled={data.characterActivities?.[id]?.enabled === false}
                    onChange={(e) =>
                      setSpeakers(
                        e.target.checked ? [...speakers, id] : speakers.filter((v) => v !== id),
                      )
                    }
                  />
                  {data.personas.find((r: any) => r.id === id)?.name}
                  {data.characterActivities?.[id]?.enabled === false && (
                    <small>{t('已停用')}</small>
                  )}
                </label>
              ))}
            </div>
            <textarea
              placeholder={t('说点什么…')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!state.busy && text.trim() && speakers.length) void send();
                }
              }}
            />
            <div className="row">
              {state.busy ? (
                <Button secondary onClick={() => act(() => rpc('groups.cancel', { id: groupId }))}>
                  {t('停止')}
                </Button>
              ) : (
                <Button disabled={!text.trim() || !speakers.length} onClick={send}>
                  {t('发送')}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
      {!group && !editing && <EmptyState title={t('选择或创建一个群聊')} />}
    </div>
  );
}
