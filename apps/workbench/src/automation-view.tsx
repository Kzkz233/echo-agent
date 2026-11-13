import { OutputTargetsField, OutputHistory } from './output-targets.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AutomationField,
  AutomationItem,
  AutomationType,
} from '../../../packages/kernel/automation.ts';
import { rpc } from './client.ts';
import { locale, t } from './i18n.ts';
import { ReasoningSelect } from './reasoning-select.tsx';
import { ModelChoice } from './model-choice.tsx';
import { WorkExecutionSettings, WorkContextSettings } from './work-settings.tsx';
import {
  Button,
  EmptyState,
  requestNavigation,
  sameData,
  useConfirm,
  useUnsavedChanges,
} from './ui.tsx';

type Catalog = {
  types: AutomationType[];
  unavailable: string[];
  sources?: { id: string; label: string }[];
};
type Draft = { type: string; id: string; settings: Record<string, unknown> };
type Activity = { type: string; id: string };
const stateLabels: Record<AutomationItem['state'], string> = {
  running: '运行中',
  waiting: '等待触发',
  paused: '已暂停',
  failed: '需要检查',
  completed: '已完成',
  unavailable: '当前不可用',
};

export function TaskField({
  field,
  draft,
  onChange,
  profileId,
  plugins = [],
  workPolicy,
  features,
}: {
  field: AutomationField;
  draft: Draft;
  onChange: (key: string, value: unknown) => void;
  profileId?: string;
  plugins?: { id: string; name: string }[];
  workPolicy?: any;
  features?: string[];
}) {
  const value = draft.settings[field.key];
  const [openRow, setOpenRow] = useState<number>();
  const optionLabel = (option: { label: string; owner?: string }) =>
    t(option.label) +
    (option.owner
      ? ' (' + t(plugins.find((p) => p.id === option.owner)?.name ?? option.owner) + ')'
      : '');
  const label = field.label
    .split(' · ')
    .map((part) => t(part))
    .join(' · ');
  for (const condition of field.when ? [field.when].flat() : []) {
    const controlling = draft.settings[condition.key] ?? (condition.value === false ? false : undefined);
    if (
      Array.isArray(controlling)
        ? !controlling.includes(condition.value)
        : controlling !== condition.value
    )
      return null;
  }
  const options = (field.options ?? []).filter(
    (o) => !field.filterBy || o.scope === draft.settings[field.filterBy],
  );
  if (field.kind === 'execution') return <WorkExecutionSettings personaId={String(draft.settings.personaId ?? '') || undefined}
    initialPolicy={workPolicy} mainProfileId={profileId} features={features}
    value={value} onChange={next => onChange(field.key, next)} />;
  if (field.kind === 'work-context') return <WorkContextSettings personaId={String(draft.settings.personaId ?? '') || undefined}
    profileId={String(draft.settings.profileId ?? profileId ?? '') || undefined} features={features}
    value={draft.settings} onChange={next => {
      const key = ['compaction', 'maxOutputTokens', 'contextBlocks'].find(key => JSON.stringify(next[key]) !== JSON.stringify(draft.settings[key]));
      if (key) onChange(key, next[key]);
    }} />;
  if(field.kind==='outputs')return <OutputTargetsField value={value} onChange={(value:string[])=>onChange(field.key,value)} personaId={draft.settings.personaId} conversationId={draft.settings.conversationId||draft.settings.reportConversationId} source={(field.outputSourceField?field.outputSources?.[String(draft.settings[field.outputSourceField])]:undefined)??field.outputSource} bubble={field.legacyBubble??Boolean(draft.settings.bubble)}/>;
  if (field.kind === 'model' || field.kind === 'executor')
    return (
      <ModelChoice
        label={field.label}
        value={String(value ?? '')}
        executor={field.kind === 'executor'}
        taskId={field.inferenceTask}
        inheritValue={profileId}
        personaId={String(draft.settings.personaId ?? '') || undefined}
        onChange={(next) => onChange(field.key, next || undefined)}
      />
    );
  if (field.kind === 'reasoning')
    return (
      <ReasoningSelect
        label={field.label}
        value={String(value ?? 'inherit')}
        profileId={
          String(draft.settings.profileId ?? draft.settings.visionProfileId ?? profileId ?? '') ||
          undefined
        }
        taskId={field.inferenceTask}
        personaId={String(draft.settings.personaId ?? '') || undefined}
        onChange={(next) => onChange(field.key, next)}
      />
    );
  if (field.kind === 'records') {
    const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    return (
      <fieldset className="automation-options">
        <legend>{label}</legend>
        {field.description && <p className="muted">{t(field.description)}</p>}
        {rows.map((row, index) => {
          const key = String(row.id ?? index);
          const body = (
          <>
            {(field.rowFields ?? []).map((column) => (
              <TaskField
                key={column.key}
                field={column}
                profileId={profileId}
                plugins={plugins}
                draft={{ ...draft, settings: row }}
                onChange={(key, value) =>
                  onChange(
                    field.key,
                    rows.map((old, i) => (i === index ? { ...old, [key]: value } : old)),
                  )
                }
              />
            ))}
            <Button
              secondary
              onClick={() => {
                if (openRow === index) setOpenRow(undefined);
                else if (openRow !== undefined && openRow > index) setOpenRow(openRow - 1);
                onChange(
                  field.key,
                  rows.filter((_, i) => i !== index),
                );
              }}
            >
              {t('移除')}
            </Button>
          </>
          );
          if (!field.rowTitleKey) return <div className="card" key={key}>{body}</div>;
          return (
            <details className="card record-settings-row" key={key} open={openRow === index}>
              <summary onClick={(event) => {
                event.preventDefault();
                setOpenRow(openRow === index ? undefined : index);
              }}>
                {String(row[field.rowTitleKey] ?? '').trim() || t('未命名规则')}
              </summary>
              <div className="record-settings-fields">{body}</div>
            </details>
          );
        })}
        <Button
          secondary
          disabled={field.max !== undefined && rows.length >= field.max}
          onClick={() => {
            if (field.rowTitleKey) setOpenRow(rows.length);
            onChange(field.key, [...rows, {
              id: crypto.randomUUID(), ...(field.rowDefaults ?? { enabled: true }),
            }]);
          }}
        >
          {field.addLabel ? t(field.addLabel) : t('添加条目')}
        </Button>
      </fieldset>
    );
  }
  if (field.kind === 'multi') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    const choices = [
      ...options,
      ...selected
        .filter((v) => !options.some((o) => o.value === v))
        .map((v) => ({ value: v, label: v })),
    ];
    return (
      <fieldset className="automation-options">
        <legend>{label}</legend>
        {choices.map((choice) => (
          <label className="inline-toggle" key={choice.value}>
            <input
              type="checkbox"
              checked={selected.includes(choice.value)}
              onChange={(event) =>
                onChange(
                  field.key,
                  event.target.checked
                    ? [...selected, choice.value]
                    : selected.filter((v) => v !== choice.value),
                )
              }
            />
            {optionLabel(choice)}
          </label>
        ))}
        {!choices.length && <small>{t('没有可选项')}</small>}
      </fieldset>
    );
  }
  const text = typeof value === 'string' || typeof value === 'number' ? value : '';
  return (
    <label className={field.kind === 'boolean' ? 'inline-toggle' : 'field'}>
      {field.kind === 'boolean' ? (
        <>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(field.key, event.target.checked)}
          />
          {label}
        </>
      ) : (
        <>
          <span>{label}</span>
          {field.kind === 'select' ? (
            <select
              aria-label={label}
              value={String(text)}
              onChange={(event) => onChange(field.key, event.target.value)}
            >
              {field.allowEmpty !== false && <option value="">{t('未选择')}</option>}
              {text && !options.some((o) => String(o.value) === String(text)) && (
                <option value={text}>{String(text)}</option>
              )}
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {optionLabel(o)}
                </option>
              ))}
            </select>
          ) : field.kind === 'textarea' || field.kind === 'json' ? (
            <textarea
              aria-label={label}
              rows={field.kind === 'json' ? 3 : 5}
              value={
                field.kind === 'json' && typeof value !== 'string'
                  ? JSON.stringify(value ?? {}, null, 2)
                  : text
              }
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          ) : (
            <input
              aria-label={label}
              type={field.kind === 'number' ? 'number' : field.kind === 'datetime' ? 'datetime-local' : 'text'}
              min={field.min}
              max={field.max}
              value={text}
              onChange={(event) =>
                onChange(
                  field.key,
                  field.kind === 'number' && event.target.value !== ''
                    ? event.target.valueAsNumber
                    : event.target.value,
                )
              }
            />
          )}
        </>
      )}
      {field.description && <small>{t(field.description)}</small>}
    </label>
  );
}

export function AutomationView({
  act,
  openTask,
  only,
  compact = false,
  personaId,
  configureRole,
  roleTasks = [],
  focusId,
  detailOnly = false,
}: {
  act: (work: () => Promise<unknown>, message?: string) => Promise<unknown>;
  openTask: (page: string, type: string, id: string, mode?: 'status' | 'edit') => void;
  only?: string;
  compact?: boolean;
  personaId?: string;
  configureRole?: (taskId?: string) => void;
  roleTasks?: { id: string; type: string }[];
  focusId?: string;
  detailOnly?: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog>({ types: [], unavailable: [] });
  const [issue, setIssue] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [activity, setActivity] = useState<Activity>();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (focusId && only) setActivity({ type: only, id: focusId });
  }, [focusId, only]);
  const ticket = useRef(0);
  const confirm = useConfirm();
  const load = useCallback(async () => {
    const rev = ++ticket.current;
    try {
      const value = await rpc<Catalog>('automation.catalog');
      if (rev === ticket.current) {
        setCatalog(value);
        setIssue('');
      }
      return value;
    } catch (error) {
      if (rev === ticket.current) setIssue((error as Error).message);
    }
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    void load();
    const refresh = (event: Event) => {
      if (
        !/^(automation\.|review\.updated|observation\.(tasks\.changed|completed)|scheduler\.updated|plugins\.changed|conversation\.)/.test(
          (event as CustomEvent).detail.type,
        )
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 120);
    };
    window.addEventListener('echo-event', refresh);
    return () => {
      ticket.current++;
      clearTimeout(timer);
      window.removeEventListener('echo-event', refresh);
    };
  }, [load]);
  const type = catalog.types.find((entry) => entry.id === draft?.type);
  const saved = type?.items.find((item) => item.id === draft?.id);
  const activityType = catalog.types.find((entry) => entry.id === activity?.type);
  const activityItem = activityType?.items.find((item) => item.id === activity?.id);
  const baseline = useRef<Record<string, unknown> | undefined>(undefined);
  useUnsavedChanges(Boolean(draft && !sameData(draft.settings, baseline.current)), '自动化任务');
  const editTask = (entry: AutomationType, item?: AutomationItem) => {
    if (item && configureRole) return configureRole(item.id);
    if (entry.scope === 'character' || item?.personaId || item?.settings?.personaId) return;
    if (entry.page) {
      openTask(entry.page, entry.id, item?.id ?? 'new', 'edit');
      return;
    }
    return requestNavigation(() => {
      setActivity(undefined);
      setCreating(false);
      const settings = item?.settings ?? { ...entry.defaults, name: t(entry.name), enabled: false };
      baseline.current = settings;
      setDraft({ type: entry.id, id: item?.id ?? crypto.randomUUID(), settings });
    });
  };
  const showActivity = (entry: AutomationType, item: AutomationItem) => {
    if (entry.statusPage) {
      openTask(entry.statusPage, entry.id, item.id, 'status');
      return;
    }
    return requestNavigation(() => {
      setDraft(undefined);
      setCreating(false);
      setActivity({ type: entry.id, id: item.id });
    });
  };
  useEffect(() => {
    const target = sessionStorage.getItem('echo.automation.open');
    if (!target) return;
    const { type: typeId, id, mode = 'edit' } = JSON.parse(target);
    const entry = catalog.types.find((entry) => entry.id === typeId);
    if (!entry || entry.page || (only && only !== entry.id)) return;
    const item = entry.items.find((item) => item.id === id);
    if (mode === 'status' && item) {
      sessionStorage.removeItem('echo.automation.open');
      if (entry.statusPage && entry.statusPage !== 'automation')
        openTask(entry.statusPage, entry.id, item.id, 'status');
      else {
        setDraft(undefined);
        setActivity({ type: entry.id, id: item.id });
      }
    } else if (item || id === 'new') {
      sessionStorage.removeItem('echo.automation.open');
      editTask(entry, item);
    }
  }, [catalog, only]);
  const change = (key: string, value: unknown) =>
    setDraft((current) => {
      if (!current) return current;
      const settings = { ...current.settings, [key]: value };
      for (const field of type?.fields ?? [])
        if (field.filterBy === key) settings[field.key] = field.kind === 'multi' ? [] : '';
      return { ...current, settings };
    });
  const types = catalog.types
    .filter((entry) => !only || entry.id === only)
    .filter((entry) => !personaId || entry.scope === 'character')
    .map((entry) => ({
      ...entry,
      items: personaId
        ? entry.items.filter(
            (item) =>
              (item.personaId ?? item.settings?.personaId) === personaId ||
              roleTasks.some((task) => task.type === entry.id && task.id === item.id),
          )
        : entry.items,
    }));
  const list = types.filter((entry) => !filter || entry.id === filter);
  const creatable = types.filter((entry) => entry.scope !== 'character');
  return (
    <div className="automation-workspace">
      {!detailOnly && (
        <div className="page-title page-title-actions">
          <h1>{t(only ? (types[0]?.name ?? '自动化任务') : '自动化任务')}</h1>
          {!configureRole && !!creatable.length && (
            <Button
              onClick={() =>
                creatable.length === 1 ? editTask(creatable[0]) : setCreating(!creating)
              }
            >
              {t('新建任务')}
            </Button>
          )}
        </div>
      )}
      {creating && (
        <div className="card">
          <h2>{t('选择任务类型')}</h2>
          <div className="row wrap">
            {creatable.map((entry) => (
              <Button key={entry.id} secondary onClick={() => editTask(entry)}>
                {t(entry.name)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {issue && <p className="warning">{issue}</p>}
      {activityType && activityItem && (
        <section className="card automation-status">
          <div className="row between">
            <div>
              <h2>{t('运行情况')}</h2>
              <p>
                <strong>{activityItem.name}</strong>
                <span className="muted">
                  {' · '}
                  {t(activityType.name)}
                  {activityItem.subject ? ' · ' + activityItem.subject : ''}
                </span>
              </p>
            </div>
            <span className={'state-pill ' + (activityItem.state === 'running' ? 'on' : '')}>
              {t(activityItem.suspendedByCharacter ? '角色已停用' : stateLabels[activityItem.state])}
            </span>
          </div>
          <OutputHistory {...{act}} personaId={activityItem.personaId??activityItem.settings?.personaId} taskType={activityType.id} taskId={activityItem.id}/>
          <dl className="automation-status-grid">
            <div>
              <dt>{t('任务状态')}</dt>
              <dd>{activityItem.enabled ? t('已启用') : t('已暂停')}</dd>
            </div>
            <div>
              <dt>{t('最近执行')}</dt>
              <dd>
                {activityItem.lastAt
                  ? new Date(activityItem.lastAt).toLocaleString(locale())
                  : t('暂无记录')}
              </dd>
            </div>
            <div>
              <dt>{t('下次执行')}</dt>
              <dd>
                {activityItem.nextAt
                  ? new Date(activityItem.nextAt).toLocaleString(locale())
                  : t('未安排')}
              </dd>
            </div>
          </dl>
          <div className="row wrap">
            {activityType.canRun && (
              <Button
                secondary
                onClick={() =>
                  act(async () => {
                    await rpc('automation.run', {
                      type: activityType.id,
                      id: activityItem.id,
                      requestId: crypto.randomUUID(),
                    });
                    await load();
                  })
                }
              >
                {t('运行一次')}
              </Button>
            )}
            {activityType.scope !== 'character' &&
              !activityItem.personaId &&
              !activityItem.settings?.personaId && (
                <Button onClick={() => editTask(activityType, activityItem)}>
                  {t('编辑任务')}
                </Button>
              )}
            {!detailOnly&&<Button secondary onClick={() => requestNavigation(() => setActivity(undefined))}>
              {t('返回任务列表')}
            </Button>}
          </div>
        </section>
      )}
      {!only && !compact && !personaId && !!catalog.sources?.length && (
        <details className="card">
          <summary>{t('已登记的触发来源')}</summary>
          <div className="row wrap">
            {catalog.sources.map((source) => (
              <span className="state-pill" key={source.id}>
                {t(source.label)}
              </span>
            ))}
          </div>
        </details>
      )}
      {catalog.unavailable.length > 0 && (
        <p className="warning">
          {t('无法读取任务类型')} · {catalog.unavailable.map((name) => t(name)).join(' · ')}
        </p>
      )}
      {!only && types.length > 1 && (
        <div className="row toolbar">
          <select
            aria-label={t('任务类型')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="">{t('全部任务')}</option>
            {types.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {t(entry.name)}
              </option>
            ))}
          </select>
        </div>
      )}
      {draft && type && (
        <section className="card automation-editor">
          <h2>{t(type.name)}</h2>
          <label className="field">
            <span>{t('任务名称')}</span>
            <input
              value={String(draft.settings.name ?? '')}
              onChange={(event) => change('name', event.target.value)}
            />
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={draft.settings.enabled === true}
              onChange={(event) => change('enabled', event.target.checked)}
            />
            {t('启用任务')}
          </label>
          <div className="form-grid">
            {type.fields.map((field) => (
              <TaskField key={draft.id + ':' + field.key} {...{ field, draft }} onChange={change} />
            ))}
          </div>
          <div className="row wrap">
            <Button
              onClick={() =>
                act(async () => {
                  const settings = { ...draft.settings };
                  for (const field of type.fields)
                    if (field.kind === 'json' && typeof settings[field.key] === 'string')
                      settings[field.key] = JSON.parse(settings[field.key] as string);
                  await rpc('automation.save', { type: draft.type, id: draft.id, settings });
                  const updated = await load();
                  const item = updated?.types
                    .find((entry) => entry.id === draft.type)
                    ?.items.find((item) => item.id === draft.id);
                  baseline.current = item?.settings ?? settings;
                  setDraft({ ...draft, settings: baseline.current });
                }, t('任务已保存'))
              }
            >
              {t('保存任务')}
            </Button>
            {saved && type.canRun && (
              <Button
                secondary
                onClick={() =>
                  act(async () => {
                    await rpc('automation.run', {
                      type: draft.type,
                      id: draft.id,
                      requestId: crypto.randomUUID(),
                    });
                    await load();
                  }, t('任务已发起'))
                }
              >
                {t('运行一次')}
              </Button>
            )}
            {saved && type.canRemove && (
              <Button
                secondary
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: t('移除任务'),
                      description: t('已有运行记录会保留。'),
                      confirmLabel: t('移除任务'),
                      danger: true,
                    }))
                  )
                    return;
                  await act(async () => {
                    await rpc('automation.remove', { type: draft.type, id: draft.id });
                    setDraft(undefined);
                    await load();
                  }, t('任务已移除'));
                }}
              >
                {t('移除任务')}
              </Button>
            )}
            <Button secondary onClick={() => requestNavigation(() => setDraft(undefined))}>
              {t('关闭')}
            </Button>
          </div>
        </section>
      )}
      {!detailOnly &&
        (list.some((entry) => entry.items.length) ? (
          <div className="automation-list">
            {list.flatMap((entry) =>
              entry.items.map((item) => (
                <div key={entry.id + ':' + item.id} className="card automation-item">
                  <button
                    className="automation-item-open"
                    aria-pressed={activity?.id === item.id && activity.type === entry.id}
                    onClick={() => showActivity(entry, item)}
                  >
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {t(entry.name)}
                        {item.subject ? ' · ' + item.subject : ''}
                      </small>
                    </span>
                    <span className={'state-pill ' + (item.state === 'running' ? 'on' : '')}>
                      {t(item.suspendedByCharacter ? '角色已停用' : stateLabels[item.state])}
                    </span>
                    <small>
                      {item.nextAt
                        ? t('下次执行') + ' ' + new Date(item.nextAt).toLocaleString(locale())
                        : item.lastAt
                          ? t('最近执行') + ' ' + new Date(item.lastAt).toLocaleString(locale())
                          : ''}
                    </small>
                  </button>
                  {entry.scope !== 'character' && !item.personaId && !item.settings?.personaId && (
                    <Button secondary onClick={() => editTask(entry, item)}>
                      {t('编辑')}
                    </Button>
                  )}
                </div>
              )),
            )}
          </div>
        ) : (
          !compact && <EmptyState title={t('还没有自动化任务')} />
        ))}
      {!personaId&&!activity&&<OutputHistory {...{act}}/>}
    </div>
  );
}
