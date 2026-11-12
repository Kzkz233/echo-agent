import { modelDisplayName } from '../../../packages/contracts/model-services.ts';
import { AvatarBehavior } from './avatar-behavior.tsx';
import { PortraitEditor } from './character-portrait.tsx';
import { lazy, useEffect, useRef, useState } from 'react';
import {
  characterDraft,
  type CharacterDraft,
} from '../../../plugins/persona/character-contracts.ts';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, PathInput, useConfirm, useUnsavedChanges, sameData, requestNavigation } from './ui.tsx';
import { TaskField } from './automation-view.tsx';
import { EchoToolSettings, PermissionSettings, SubtaskApprovalSettings } from './host-interactions.tsx';
import { ReasoningSelect } from './reasoning-select.tsx';
import { ModelChoice } from './model-choice.tsx';
import { modelEligible } from './model-eligibility.ts';
import { inferenceTasks } from '../../../packages/contracts/inference.ts';
import { contextCompaction } from '../../../packages/contracts/compaction.ts';
import type { OutputTarget } from '../../../packages/contracts/delivery.ts';
import { defaultEchoReadPermissions } from '../../../packages/contracts/interaction.ts';
import { RoleWorkspaces } from './role-workspaces.tsx';
import { DelegationExecutors } from './delegation-executors.tsx';
import { WorkContextSettings } from './work-settings.tsx';
const AvatarAssets = lazy(() => import('./avatar-assets.tsx'));
const ChatStickView = lazy(() =>
  import('./chatstick-view.tsx').then((module) => ({ default: module.ChatStickView })),
);
const ChannelBindings = lazy(() =>
  import('./feature-views.tsx').then((module) => ({ default: module.FeaturePage })),
);

const steps = ['角色资料', '角色功能', '模型与权限', '检查并创建'];
const expressionFields = [
  ['chat', '应用对话风格'],
  ['external', 'QQ 回复风格'],
  ['bubble', '桌宠气泡风格'],
] as const;
const initialExpression = {
  chat: '自然清楚地交流。闲聊简短，复杂问题先用一句话说明准备怎么处理，再继续工作。',
  external: '按即时消息的语气写。闲聊可以分成几条发送。汇报保留完整正文，先说结论。',
  bubble: '口语化，先说重点。一般一两句，适合在桌宠气泡中阅读。',
};
function editableChannelStyles(targets: OutputTarget[]) {
  return [...new Map(targets.flatMap(({ style, label, presentation }) =>
    style && !['chat', 'external', 'bubble'].includes(style)
      ? [[style, { style, label: label.split(' · ')[0], presentation }] as const] : [],
  )).values()];
}
export function CharacterWizard({
  data,
  act,
  personaId,
  onComplete,
  onClose,
  openSettings,
  openTask,
  initialStep = 0,
  initialTaskId,
}: any) {
  const [catalog, setCatalog] = useState<any>();
  const [draft, setDraft] = useState<CharacterDraft>();
  const [step, setStep] = useState(0);
  const [editorSection, setEditorSection] = useState(
    ['profile', 'profile', 'memory', 'model', 'tasks', 'summary', 'appearance', 'expression'][
      initialStep
    ] ?? 'profile',
  );
  const [issue, setIssue] = useState('');
  const [packages, setPackages] = useState<any>();
  const [savedDrafts, setSavedDrafts] = useState<any[]>([]);
  const [taskIndex, setTaskIndex] = useState(0);
  const [choosingTask, setChoosingTask] = useState(false);
  const [taskSearch, setTaskSearch] = useState('');
  const [taskPreview, setTaskPreview] = useState('');
  const [deliveryTargets, setDeliveryTargets] = useState<OutputTarget[]>([]);
  const channelStyles = editableChannelStyles(deliveryTargets);
  useEffect(() => setTaskPreview(''), [taskIndex, draft]);
  useEffect(() => {
    if (!personaId || !['expression', 'chatstick'].includes(editorSection)) return;
    let active = true;
    const load = () => rpc<{ targets: OutputTarget[] }>('outputs.targets', { personaId, conversationId: data.characters.find((role: any) => role.id === personaId)?.mainConversationId })
      .then((result) => {
        if (active) setDeliveryTargets(result.targets);
      }).catch(() => {});
    void load();
    const listener = (event: Event) => {
      if (['channels.updated', 'plugins.changed'].includes((event as CustomEvent).detail.type)) void load();
    };
    window.addEventListener('echo-event', listener);
    return () => { active = false; window.removeEventListener('echo-event', listener); };
  }, [personaId, editorSection]);
  const confirm = useConfirm();
  const baseline = useRef<unknown>(undefined);
  const requestId = useRef(crypto.randomUUID());
  useUnsavedChanges(Boolean(draft && !sameData(draft, baseline.current)), '角色配置');
  useEffect(() => {
    let active = true;
    void (async () => {
      const value = await rpc('persona.character.catalog');
      const drafts = await rpc('persona.character.drafts');
      const saved = personaId ? await rpc('persona.character.read', { id: personaId }) : undefined;
      const newId = crypto.randomUUID();
      const newTargets = saved ? [] : await rpc<{ targets: OutputTarget[] }>('outputs.targets', { personaId: newId })
        .then((result) => result.targets).catch(() => []);
      const initialChannels = Object.fromEntries(newTargets.flatMap(({ style, initialStyle }) =>
        style && initialStyle && !['chat', 'external', 'bubble'].includes(style) ? [[style, t(initialStyle)]] : []));
      const next = characterDraft.parse(
        saved ?? {
          persona: { id: newId, name: '', prompt: '', expression: {
            chat: t(initialExpression.chat), external: t(initialExpression.external), bubble: t(initialExpression.bubble),
            ...(Object.keys(initialChannels).length ? { channels: initialChannels } : {}),
          } },
          features: value.features
            .filter((f: any) => ['memory', 'avatar'].includes(f.id))
            .map((f: any) => f.id),
          configurations: Object.fromEntries(value.features.map((f: any) => [f.id, f.value])),
          independentToolGrants: true,
          toolPermissions: (data.mcpPermissionCatalog ?? [])
            .filter(
              (row: any) =>
                row.scope === 'character' &&
                defaultEchoReadPermissions.includes(row.permission),
            )
            .map((row: any) => row.permission),
        },
      );
      if (active) {
        setCatalog(value);
        setDraft(next);
        if (!saved) setDeliveryTargets(newTargets);
        setSavedDrafts(drafts);
        setTaskIndex(
          initialTaskId
            ? Math.max(
                0,
                next.tasks.findIndex((task) => task.id === initialTaskId),
              )
            : 0,
        );
        baseline.current = next;
      }
    })().catch((error) => setIssue(error.message));
    return () => {
      active = false;
    };
  }, [personaId, initialTaskId]);
  const change = (patch: Partial<CharacterDraft>) => {
    requestId.current = crypto.randomUUID();
    setDraft((old) => (old ? { ...old, ...patch } : old));
  };
  if (!draft || !catalog) return <div className="card">{issue || t('正在打开…')}</div>;
  const feature = (id: string) => catalog.features.find((f: any) => f.id === id);
  const model = data.profiles.find((p: any) => p.id === draft.profileId);
  const compaction = { ...contextCompaction.parse({}), ...draft.compaction };
  const delegation = draft.configurations.delegation;
  const canDelegate = draft.features.includes('delegation') && Boolean(feature('delegation'));
  const delegationPermissionFields = ['autonomous', 'workspaces', 'toolPermissions', 'approvals', 'terminal', 'allowFullAccess', 'approvalReviewer'];
  const changeConfig = (id: string, key: string, value: unknown) =>
    change({
      configurations: {
        ...draft.configurations,
        [id]: { ...draft.configurations[id], [key]: value },
      },
    });
  const task = draft.tasks[taskIndex];
  const type = catalog.taskTypes.find((v: any) => v.id === task?.type);
  const availableTasks = catalog.taskTypes.filter(
    (v: any) =>
      v.scope === 'character' &&
      (draft.features.includes(v.owner) ||
        catalog.features.some(
          (feature: any) =>
            draft.features.includes(feature.id) && feature.taskTypes?.includes(v.id),
        )) &&
      v.canRemove,
  );
  const toggleFeature = (id: string, enabled: boolean) => {
    const selected = new Set(draft.features);
    const add = (id: string) => {
      if (selected.has(id)) return;
      selected.add(id);
      for (const dependency of feature(id)?.requires ?? [])
        if (feature(dependency)) add(dependency);
    };
    if (enabled) add(id);
    else {
      selected.delete(id);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of selected)
          if (
            (feature(candidate)?.requires ?? []).some(
              (dependency: string) => feature(dependency) && !selected.has(dependency),
            )
          ) {
            selected.delete(candidate);
            changed = true;
          }
      }
    }
    change({
      features: [...selected],
      tasks: draft.tasks.map((task) => {
        const type = catalog.taskTypes.find((entry: any) => entry.id === task.type);
        const available =
          selected.has(type?.owner) ||
          [...selected].some((id) => feature(id)?.taskTypes?.includes(task.type));
        if (!available)
          return {
            ...task,
            enabledWhenAvailable: task.enabledWhenAvailable ?? Boolean(task.settings.enabled),
            settings: { ...task.settings, enabled: false },
          };
        if (task.enabledWhenAvailable !== undefined) {
          const { enabledWhenAvailable, ...rest } = task;
          return { ...rest, settings: { ...task.settings, enabled: enabledWhenAvailable } };
        }
        return task;
      }),
    });
  };
  const field = (
    featureId: string,
    f: any,
    rowValue?: any,
    rowUpdate?: (v: any) => void,
  ): React.ReactNode => {
    const value = rowUpdate ? rowValue : draft.configurations[featureId]?.[f.key];
    const rows = f.resource === 'vault' ? data.vaults
      : f.resource === 'mailAccount' ? data.mailAccounts ?? []
      : f.resource === 'executor' ? data.profiles.filter((p:any)=>p.id!==draft.profileId&&modelEligible(p,{executor:true}))
      : f.resource === 'permission' ? data.mcpPermissionCatalog.filter((p:any)=>draft.toolPermissions.includes(p.permission)).map((p:any)=>({id:p.permission,name:p.external ? `${t(p.external.server)} · ${p.external.tool}` : p.owners.map((id:string)=>t(data.plugins.find((plugin:any)=>plugin.id===id)?.name??'共享模块')).join(' · ')+' · '+t(p.permission.endsWith('.read')?'读取':p.permission.endsWith('.write')?'修改':'调用')})) : [];
    const update = (next: unknown) =>
      rowUpdate ? rowUpdate(next) : changeConfig(featureId, f.key, next);
    if (featureId === 'delegation' && f.key === 'allowedProfileIds')
      return <DelegationExecutors key={f.key} data={data} policy={draft.configurations.delegation}
        mainProfileId={draft.profileId} onChange={patch => change({ configurations: {
          ...draft.configurations, delegation: { ...draft.configurations.delegation, ...patch },
        } })} />;
    if (f.type !== 'multi' && (f.resource === 'executor' || f.resource === 'model'))
      return (
        <ModelChoice
          key={f.key}
          data={data}
          executor={f.resource === 'executor'}
          taskId={f.inferenceTask}
          backendKinds={f.backendKinds}
          inheritValue={draft.profileId}
          personaId={draft.persona.id}
          label={f.label}
          value={String(value ?? '')}
          onChange={update}
        />
      );
    if (f.type === 'records')
      return (
        <section className="record-fields" key={f.key}>
          <h3>{t(f.label)}</h3>
          {f.description && <p className="muted">{t(f.description)}</p>}
          {(Array.isArray(value) ? value : []).map((row: any, index: number) => (
            <div className="card" key={row.id ?? index}>
              <div className="form-grid">
                {f.rowFields.map((child: any) =>
                  field(featureId, child, row[child.key], (next) =>
                    update(
                      value.map((item: any, i: number) =>
                        i === index ? { ...item, [child.key]: next } : item,
                      ),
                    ),
                  ),
                )}
              </div>
              <Button
                secondary
                onClick={() => update(value.filter((_: any, i: number) => i !== index))}
              >
                {t(f.removeLabel ?? '移除')}
              </Button>
            </div>
          ))}
          <Button
            secondary
            disabled={(value?.length ?? 0) >= (f.max ?? Infinity)}
            onClick={() => update([...(value ?? []), { ...f.defaults, id: crypto.randomUUID() }])}
          >
            {t(f.addLabel ?? '添加条目')}
          </Button>
        </section>
      );
    const Container = f.type === 'multi' ? 'div' : 'label';
    return (
      <Container className="field" key={f.key} role={f.type === 'multi' ? 'group' : undefined} aria-label={f.type === 'multi' ? t(f.label) : undefined}>
        <span>{t(f.label)}</span>
        {f.type === 'boolean' ? (
          <input
            type="checkbox"
            disabled={f.disabled}
            checked={value === true}
            onChange={async (e) => {
              const checked = e.target.checked;
              if (checked && f.key === 'allowFullAccess' && !await confirm({
                title: t('允许委派本机完全访问'), danger: true,
                description: t('主会话可为具体子任务授予当前系统账户可用的文件访问。'),
              })) return;
              update(checked);
            }}
          />
        ) : f.type === 'multi' ? (
          <div className="row wrap">
              {[...rows,...(Array.isArray(value)?value:[]).filter((id:string)=>!rows.some((row:any)=>row.id===id)).map((id:string)=>({id,name:id+' · '+t('当前不可用')}))].map((r: any) => (
              <label className="inline-toggle" key={r.id}>
                <input
                  type="checkbox"
                  checked={Array.isArray(value) && value.includes(r.id)}
                  onChange={(e) =>
                    update(
                      e.target.checked
                        ? [...(Array.isArray(value) ? value : []), r.id]
                        : (Array.isArray(value) ? value : []).filter((v) => v !== r.id),
                    )
                  }
                />
                {r.name}
              </label>
            ))}
          </div>
        ) : f.resource || f.type === 'select' ? (
          <select
            aria-label={t(f.label)}
            value={String(value ?? '')}
            onChange={(e) => update(e.target.value)}
          >
            <option value="">{t('未选择')}</option>
            {(f.resource
              ? rows
              : (f.options ?? []).map((id: string) => ({ id, name: t(f.optionLabels?.[id] ?? id) }))
            ).map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.name ?? r.title}
              </option>
            ))}
          </select>
        ) : f.type === 'path' ? (
          <PathInput
            label={t(f.label)}
            value={String(value ?? '')}
            onChange={update}
            directory={f.pathMode !== 'file'}
          />
        ) : f.type === 'textarea' ? (
          <textarea rows={5} value={String(value ?? '')} onChange={(e) => update(e.target.value)} />
        ) : (
          <input
            type={f.type === 'number' ? 'number' : 'text'}
            min={f.min}
            max={f.max}
            step="any"
            value={String(value ?? '')}
            onChange={(e) => update(f.type === 'number' ? Number(e.target.value) : e.target.value)}
          />
        )}
        {f.description && <small>{t(f.description)}</small>}
      </Container>
    );
  };
  const profileEditor = (
    <>
      <PortraitEditor
        persona={draft.persona}
        onChange={(portrait: string | undefined) =>
          change({ persona: { ...draft.persona, portrait } })
        }
      />
      <label className="field">
        <span>{t('角色名称')}</span>
        <input
          aria-label={t('角色名称')}
          value={draft.persona.name}
          onChange={(e) => change({ persona: { ...draft.persona, name: e.target.value } })}
        />
      </label>
      <label className="field">
        <span>{t('角色人设')}</span>
        <textarea
          aria-label={t('角色人设')}
          rows={10}
          value={draft.persona.prompt}
          onChange={(e) => change({ persona: { ...draft.persona, prompt: e.target.value } })}
        />
      </label>
    </>
  );
  const modelEditor = (
    <>
      <ModelChoice
        data={data}
        label="主会话模型"
        value={draft.profileId}
        inherit={false}
        onChange={(profileId) => change({ profileId })}
      />
      <ReasoningSelect
        value={draft.reasoning}
        profileId={draft.profileId || undefined}
        onChange={(value) => change({ reasoning: value as any })}
      />
      <fieldset>
        <legend>{t('主会话上下文')}</legend>
        <div className="form-grid">
          <label className="field">
            <span>{t('压缩触发上限（tokens）')}</span>
            <input type="number" min={1024} max={2000000} value={compaction.triggerTokens || ''}
              onChange={(event) => change({ compaction: { ...compaction, triggerTokens: Number(event.target.value) } })} />
          </label>
          <label className="field">
            <span>{t('压缩后保留原文（%）')}</span>
            <input type="number" min={0.1} max={99.9} step="0.1" value={compaction.keepRecentPercent || ''}
              onChange={(event) => change({ compaction: { ...compaction, keepRecentPercent: Number(event.target.value) } })} />
          </label>
        </div>
        <small>{t('保留比例按有效上下文上限计算，完整聊天记录保留。')}</small>
      </fieldset>
      <details className="setup-capability">
        <summary>{t('应用工具权限')}</summary>
        <EchoToolSettings permissions={draft.permissions} onSave={(permissions) => change({ permissions })} />
        {canDelegate && <p className="muted">{t('子任务最多可获得勾选的工具。未指定工具时，仅授予其中的查询工具。')}</p>}
        <div className="role-permission-list">
          {(data.mcpPermissionCatalog ?? [])
            .filter(
              (row: any) => row.scope === 'character',
            )
            .map((row: any) => {
              const selected = draft.toolPermissions.includes(row.permission);
              const owners = row.owners
                .map((id: string) => data.plugins.find((plugin: any) => plugin.id === id))
                .filter(Boolean)
                .map((plugin: any) => t(plugin.name));
              return (
                <div className="role-tool-grant" key={row.permission}>
                  <strong title={row.permission}>{row.external ? <>{t(row.external.server)} · {row.external.tool}{!row.external.available && ` · ${t('待配置')}`}</> : <>{owners.join(' · ') || t('共享模块')} · {t(
                    row.permission.endsWith('.read') ? '读取' : row.permission.endsWith('.write') ? '修改' : '调用',
                  )}</>}</strong>
                  <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) =>
                      change({
                        independentToolGrants: true,
                        toolPermissions: event.target.checked
                          ? [...new Set([...draft.toolPermissions, row.permission])]
                          : draft.toolPermissions.filter((value) => value !== row.permission),
                      })
                    }
                  />
                    {t('主会话')}
                  </label>
                  {canDelegate && <label className="inline-toggle">
                    <input type="checkbox" checked={(delegation?.toolPermissions as string[] | undefined)?.includes(row.permission) ?? false}
                      onChange={(event) => {
                        const current = (delegation?.toolPermissions as string[] | undefined) ?? [];
                        changeConfig('delegation', 'toolPermissions', event.target.checked
                          ? [...new Set([...current, row.permission])] : current.filter((permission) => permission !== row.permission));
                      }} />
                    {t('子任务')}
                  </label>}
                </div>
              );
            })}
        </div>
      </details>
      {model && (
        <details className="setup-capability">
          <summary>{t('工作目录与文件权限')}</summary>
          <RoleWorkspaces personaId={draft.persona.id} permissions={draft.permissions}
            workers={canDelegate ? (delegation?.workspaces as { path: string; write: boolean }[] | undefined) ?? [] : undefined}
            onChange={(permissions, roots) => change({
              permissions,
              ...(roots === undefined ? {} : { configurations: {
                ...draft.configurations, delegation: { ...delegation, workspaces: roots },
              } }),
            })} />
          <PermissionSettings
            value={draft.permissions}
            backend={model}
            disabled={false}
            managedWorkspace
            onSave={(value) => change({ permissions: value })}
          />
        </details>
      )}
      {canDelegate && <details className="setup-capability">
        <summary>{t('子任务权限')}</summary>
        <div className="form-grid">
          <SubtaskApprovalSettings policy={delegation} onChange={(approval) => change({
            configurations: { ...draft.configurations, delegation: { ...delegation, ...approval } },
          })} />
          {feature('delegation')?.fields
            .filter((entry: any) => ['autonomous', 'terminal', 'allowFullAccess'].includes(entry.key))
            .map((entry: any) => field('delegation', {
              ...entry, disabled: delegation?.approvals === 'deny' && entry.key !== 'autonomous',
            }))}
        </div>
      </details>}
      {canDelegate && <WorkContextSettings personaId={draft.persona.id} profileId={draft.profileId} features={draft.features} value={delegation}
        onChange={value => change({ configurations: { ...draft.configurations, delegation: value } })} />}
      <Button secondary onClick={() => openSettings('backends')}>
        {t('管理模型服务')}
      </Button>
    </>
  );
  const featureEditor = (
    <>
      <div className="row wrap">
        <label className="button secondary">
          {t('导入角色包')}
          <input
            hidden
            type="file"
            accept=".json"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const pack = JSON.parse(await file.text());
                const imported = await rpc(
                  personaId ? 'persona.package.update' : 'persona.package.import',
                  personaId ? { personaId, package: pack } : pack,
                );
                setPackages(imported);
                if (!imported.missing.length) {
                  change(characterDraft.parse(imported.draft));
                  setIssue('');
                } else setIssue(t('请先启用所需插件') + ' · ' + imported.missing.join(', '));
              } catch (error) {
                setIssue((error as Error).message);
              }
            }}
          />
        </label>
        <Button secondary onClick={() => openSettings('plugins')}>
          {t('管理插件')}
        </Button>
      </div>
      {packages && <p>{packages.draft.persona.name}</p>}
      <p className="muted role-feature-scope-note">
        {t('选择此角色使用的功能。插件安装与启停在应用设置中管理。')}
      </p>
      {!personaId && savedDrafts.length > 0 && (
        <label className="field">
          <span>{t('继续创建草稿')}</span>
          <select
            value=""
            onChange={(e) => {
              const saved = savedDrafts.find((row) => row.persona.id === e.target.value);
              if (saved) {
                change(characterDraft.parse(saved));
                baseline.current = saved;
              }
            }}
          >
            <option value="">{t('选择草稿')}</option>
            {savedDrafts.map((row) => (
              <option value={row.persona.id} key={row.persona.id}>
                {row.persona.name || t('未命名角色')}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="role-feature-grid">
        {[...catalog.features]
          .sort((a: any, b: any) => (a.presentation?.order ?? 0) - (b.presentation?.order ?? 0))
          .map((f: any) => (
            <label
              className={'role-feature ' + (draft.features.includes(f.id) ? 'selected' : '')}
              key={f.id}
            >
              <input
                type="checkbox"
                disabled={f.id === 'delegation'}
                checked={draft.features.includes(f.id)}
                onChange={(e) => toggleFeature(f.id, e.target.checked)}
              />
              <strong>{t(f.name)}</strong>
              <span>
                {data.plugins.find((p: any) => p.id === f.id)?.description &&
                  t(data.plugins.find((p: any) => p.id === f.id).description)}
              </span>
            </label>
          ))}
      </div>
    </>
  );
  const taskEditor = (
    <>
      <div className="row wrap">
        <Button secondary onClick={() => setChoosingTask(!choosingTask)}>
          {t('新建任务')}
        </Button>
      </div>
      {choosingTask && (
        <section className="task-type-picker">
          <label className="field">
            <span>{t('选择任务类型')}</span>
            <input
              value={taskSearch}
              onChange={(event) => setTaskSearch(event.target.value)}
              placeholder={t('搜索任务类型')}
            />
          </label>
          <div className="task-type-grid">
            {availableTasks
              .filter((v: any) => t(v.name).toLowerCase().includes(taskSearch.toLowerCase()))
              .map((type: any) => (
                <button
                  type="button"
                  key={type.id}
                  onClick={() => {
                    change({
                      tasks: [
                        ...draft.tasks,
                        {
                          id: crypto.randomUUID(),
                          type: type.id,
                          settings: {
                            ...type.defaults,
                            name: t(type.name),
                            enabled: false,
                            personaId: draft.persona.id,
                          },
                        },
                      ],
                    });
                    setTaskIndex(draft.tasks.length);
                    setChoosingTask(false);
                  }}
                >
                  <strong>{t(type.name)}</strong>
                  <span>
                    {t(data.plugins.find((p: any) => p.id === type.owner)?.description ?? '')}
                  </span>
                  <small>
                    {t(data.plugins.find((p: any) => p.id === type.owner)?.name ?? type.owner)}
                  </small>
                </button>
              ))}
          </div>
        </section>
      )}
      <div className="task-tabs">
        {draft.tasks.map((task, i) => (
          <button
            key={task.id}
            className={i === taskIndex ? 'active' : ''}
            onClick={() => setTaskIndex(i)}
          >
            {String(task.settings.name ?? task.type)}
          </button>
        ))}
      </div>
      {task && type && (
        <div className="task-configuration">
          {!availableTasks.some((entry: any) => entry.id === type.id) && (
            <p className="muted">{t('所需能力已停用，任务配置仍保留。')}</p>
          )}
          <fieldset
            disabled={!availableTasks.some((entry: any) => entry.id === type.id)}
            className="task-fields"
          >
            {personaId && type.items?.some((item: any) => item.id === task.id) && (
              <Button
                secondary
                onClick={() =>
                  openTask(type.statusPage ?? 'automation', type.id, task.id, 'status')
                }
              >
                {t('查看运行情况')}
              </Button>
            )}
            <label className="field">
              <span>{t('任务名称')}</span>
              <input
                value={String(task.settings.name ?? '')}
                onChange={(e) =>
                  change({
                    tasks: draft.tasks.map((row, i) =>
                      i === taskIndex
                        ? { ...row, settings: { ...row.settings, name: e.target.value } }
                        : row,
                    ),
                  })
                }
              />
            </label>
            <label className="inline-toggle">
              <input
                type="checkbox"
                checked={task.settings.enabled === true}
                onChange={(e) =>
                  change({
                    tasks: draft.tasks.map((row, i) =>
                      i === taskIndex
                        ? { ...row, settings: { ...row.settings, enabled: e.target.checked } }
                        : row,
                    ),
                  })
                }
              />
              {t('启用任务')}
            </label>
            <div className="form-grid">
              {type.fields.filter(
                (f: any) => !['personaId', 'conversationId', 'reportConversationId'].includes(f.key),
              ).map((f: import('../../../packages/kernel/automation.ts').AutomationField) => (
                <TaskField
                  plugins={data.plugins}
                  workPolicy={draft.configurations.delegation}
                  features={draft.features}
                  key={task.id + ':' + f.key}
                  field={f}
                  profileId={
                    !f.inferenceTask || f.inferenceTask === inferenceTasks.chat
                      ? draft.profileId
                      : (draft.routes[f.inferenceTask] ?? draft.profileId)
                  }
                  draft={{
                    type: task.type,
                    id: task.id,
                    settings: {
                      ...task.settings,
                      personaId: draft.persona.id,
                      conversationId: task.settings.conversationId ||
                        data.characters.find((role: any) => role.id === draft.persona.id)?.mainConversationId,
                    },
                  }}
                  onChange={(key, value) =>
                    change({
                      tasks: draft.tasks.map((row, i) =>
                        i === taskIndex
                          ? { ...row, settings: { ...row.settings, [key]: value } }
                          : row,
                      ),
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          {type.previewOperation && (
            <section className="task-prompt-preview">
              <Button
                secondary
                onClick={() =>
                  act(async () => {
                    const preview = await rpc(type.previewOperation, {
                      personaId: draft.persona.id,
                      settings: task.settings,
                    });
                    setTaskPreview(preview.text);
                  }, '')
                }
              >
                {t('预览整理指引')}
              </Button>
              {taskPreview && <pre className="readable-pre">{taskPreview}</pre>}
            </section>
          )}
          <Button
            secondary
            onClick={() => {
              change({ tasks: draft.tasks.filter((_, i) => i !== taskIndex) });
              setTaskIndex(0);
            }}
          >
            {t('移除任务')}
          </Button>
        </div>
      )}
    </>
  );
  const summaryEditor = (
    <div className="role-summary">
      <h2>{draft.persona.name || t('未命名角色')}</h2>
      <p>{draft.persona.prompt.slice(0, 300)}</p>
      <dl>
        <dt>{t('角色功能')}</dt>
        <dd>{draft.features.map((id) => t(feature(id)?.name ?? id)).join(' · ')}</dd>
        <dt>{t('主会话模型')}</dt>
        <dd>{model ? modelDisplayName(model) : t('稍后连接')}</dd>
        <dt>{t('自动化任务')}</dt>
        <dd>
          {draft.tasks
            .map(
              (task) =>
                String(task.settings.name ?? task.type) +
                (task.settings.enabled ? ' · ' + t('启用') : ' · ' + t('已暂停')),
            )
            .join('、') || t('暂无')}
        </dd>
      </dl>
    </div>
  );
  const expressionEditor = (
    <>
      <details className="card" open>
        <summary>{t('表达风格')}</summary>
        <div className="form-grid">
          {expressionFields.map(([key, label]) => (
            <label className="field" key={key}>
              <span>{t(label)}</span>
              <textarea
                rows={3}
                aria-label={t(label)}
                maxLength={600}
                placeholder={t('留空沿用角色人设')}
                value={draft.persona.expression?.[key] ?? ''}
                onChange={(e) =>
                  change({
                    persona: {
                      ...draft.persona,
                      expression: {
                        ...draft.persona.expression,
                        [key]: e.target.value,
                      },
                    },
                  })
                }
              />
            </label>
          ))}
          {channelStyles.map(({ style, label, presentation }) => <label className="field" key={style}>
            <span>{t('{channel} 回复风格', { channel: t(label) })}</span>
            <textarea rows={3} maxLength={600} aria-label={t('{channel} 回复风格', { channel: t(label) })} placeholder={t('留空沿用角色人设')}
              value={draft.persona.expression?.channels?.[style] ?? (presentation === 'external' ? draft.persona.expression?.external : undefined) ?? ''}
              onChange={(event) => change({ persona: { ...draft.persona, expression: { ...draft.persona.expression,
                channels: { ...draft.persona.expression?.channels, [style]: event.target.value },
              } } })} />
          </label>)}
        </div>
      </details>
      {personaId &&
        data.plugins.some((plugin: any) => plugin.id === 'channels' && plugin.enabled) && (
          <details className="card" open>
            <summary>{t('会话通道')}</summary>
            <ChannelBindings
              page="channels"
              personaId={personaId}
              data={data}
              act={act}
              setPage={openSettings}
              embedded
            />
          </details>
        )}
      {!personaId && <p className="muted">{t('创建角色后，可在这里绑定消息通道。')}</p>}
    </>
  );
  const extraSections = new Map<string, { id: string; title: string; order: number }>();
  for (const item of catalog.features.filter((item: any) => draft.features.includes(item.id))) {
    const presentation = item.presentation ?? {
      section: 'extensions',
      title: '扩展能力',
      order: 100,
    };
    if (!extraSections.has(presentation.section))
      extraSections.set(presentation.section, {
        id: presentation.section,
        title: presentation.title,
        order: presentation.order ?? 100,
      });
  }
  if (draft.features.some((id) => !feature(id)))
    extraSections.set('extensions', { id: 'extensions', title: '扩展能力', order: 100 });
  const sections = [
    { id: 'profile', title: '角色资料' },
    { id: 'features', title: '角色功能' },
    { id: 'model', title: '模型与权限' },
    ...['memory', 'tools', 'tasks', 'expression', 'appearance']
      .filter((id) => extraSections.has(id) || ['tasks', 'expression'].includes(id))
      .map(
        (id) =>
          extraSections.get(id) ?? { id, title: id === 'tasks' ? '自动化任务' : '通道与表达' },
      ),
    ...[...extraSections.values()]
      .filter(
        (entry) => !['memory', 'tools', 'tasks', 'expression', 'appearance'].includes(entry.id),
      )
      .sort((a, b) => a.order - b.order),
    { id: 'summary', title: '配置概览' },
  ];
  const stickerPolicy = (draft.configurations.chatstick?.channels ?? {}) as Record<string, boolean>;
  const renderFeatures = (section: string) => (
    <>
      {catalog.features
        .filter(
          (item: any) =>
            draft.features.includes(item.id) &&
            item.presentation?.editor !== 'avatar-materials' &&
            (item.presentation?.section ?? 'extensions') === section &&
            (item.fields.length ||
              item.presentation?.editor ||
              (!item.taskTypes?.length && data.inference.tasks.some((task: any) => task.owner === item.id && task.scope === 'character'))),
        )
        .sort((a: any, b: any) => (a.presentation?.order ?? 0) - (b.presentation?.order ?? 0))
        .map((item: any) => (
          <section key={item.id} className="role-settings-block" data-role-feature={item.id}>
            <h2>{t(item.name)}</h2>
            {item.presentation?.editor === 'chatstick' && (
              <>
                <label className="field">
                  <span>{t('表情使用偏好')}</span>
                  <textarea
                    rows={3}
                    aria-label={t('表情使用偏好')}
                    maxLength={600}
                    placeholder={t('留空沿用默认风格')}
                    value={draft.persona.expression?.stickers ?? ''}
                    onChange={(event) => change({
                      persona: {
                        ...draft.persona,
                        expression: { ...draft.persona.expression, stickers: event.target.value },
                      },
                    })}
                  />
                </label>
                <fieldset className="sticker-channels">
                  <legend>{t('表情投递渠道')}</legend>
                  {deliveryTargets.map((target) => (
                    <label className={'inline-toggle' + (!target.supportsImages ? ' unavailable' : '')} key={target.id}>
                      <input type="checkbox" aria-label={t(target.label)} disabled={!target.supportsImages}
                        checked={target.supportsImages && stickerPolicy[target.id] !== false}
                        onChange={(event) => changeConfig('chatstick', 'channels', { ...stickerPolicy, [target.id]: event.target.checked })} />
                      <span>{t(target.label)}</span>
                      {!target.supportsImages && <small>{t('不支持图片')}</small>}
                    </label>
                  ))}
                </fieldset>
                {personaId && <ChatStickView personaId={personaId} embedded />}
              </>
            )}
            {item.presentation?.editor === 'avatar' ? (
              draft.features.includes('avatar') && (
                <section>
                  <AvatarAssets
                    data={{
                      ...data,
                      avatarConfig: {
                        ...draft.configurations.avatar,
                        renderer: draft.configurations.avatar?.renderer ?? 'frames',
                      },
                    }}
                    act={act}
                    personaId={personaId}
                    builtin={
                      <img
                        src="/assets/cute-girl/atlas.png"
                        alt={t('内置素材')}
                        style={{ maxHeight: 160, objectFit: 'contain' }}
                      />
                    }
                    onSelect={(value: any) => {
                      const { extensionConfiguration, ...avatar } = value;
                      change({
                        configurations: {
                          ...draft.configurations,
                          avatar: { ...draft.configurations.avatar, ...avatar },
                          ...(extensionConfiguration ? { [extensionConfiguration.id]: { ...draft.configurations[extensionConfiguration.id], [extensionConfiguration.field]: extensionConfiguration.value } } : {}),
                        },
                      });
                    }}
                  />
                  <AvatarBehavior
                    personaId={personaId}
                    config={draft.configurations.avatar ?? {}}
                    providers={data.providers ?? []}
                    onChange={(value: any) =>
                      change({
                        configurations: {
                          ...draft.configurations,
                          avatar: { ...draft.configurations.avatar, ...value },
                        },
                      })
                    }
                  />
                  <div className="form-grid">
                    {feature('avatar')
                      ?.fields.filter((f: any) => f.key !== 'assetDirectory')
                      .map((f: any) => field('avatar', f))}
                  </div>
                </section>
              )
            ) : (
              <div className="form-grid">
                {item.fields
                  .filter(
                    (field: any) => item.id !== 'delegation' || !delegationPermissionFields.includes(field.key),
                  )
                  .map((f: any) => field(item.id, f))}
              </div>
            )}
            {data.inference.tasks
              .filter(
                (task: any) =>
                  task.owner === item.id && task.scope === 'character' && !item.taskTypes?.length,
              )
              .map((task: any) => (
                <ModelChoice
                  key={task.id}
                  data={data}
                  taskId={task.id}
                  inheritLabel="使用主会话模型"
                  inheritValue={draft.profileId}
                  personaId={draft.persona.id}
                  executor={task.id === inferenceTasks.review}
                  label={task.label}
                  value={draft.routes[task.id] ?? ''}
                  onChange={(value) => {
                    const routes = { ...draft.routes };
                    if (value) routes[task.id] = value;
                    else delete routes[task.id];
                    change({ routes });
                  }}
                />
              ))}
            {!item.fields.length &&
              !data.inference.tasks.some((task: any) => task.owner === item.id) &&
              item.taskTypes?.length > 0 && (
                <p className="muted">{t('在自动化任务中配置触发条件和执行参数。')}</p>
              )}
          </section>
        ))}
      {section === 'extensions' &&
        draft.features
          .filter((id) => !feature(id))
          .map((id) => (
            <p className="warning" key={id}>
              {t(data.plugins.find((plugin: any) => plugin.id === id)?.name ?? id)} ·{' '}
              {t('插件不可用，原配置保留')}
            </p>
          ))}
    </>
  );
  return (
    <div className={'character-wizard' + (personaId ? ' role-editor' : '')}>
      <div className="page-title page-title-actions">
        <h1>{t(personaId ? '编辑角色' : '创建角色')}</h1>
        <Button secondary onClick={() => requestNavigation(onClose)}>
          {t('关闭')}
        </Button>
      </div>
      <div className="role-editor-layout">
        {personaId ? (
          <nav className="role-editor-nav" aria-label={t('角色设置分类')}>
            {sections.map((section) => (
              <button
                key={section.id}
                className={editorSection === section.id ? 'active' : ''}
                aria-current={editorSection === section.id ? 'page' : undefined}
                onClick={() => setEditorSection(section.id)}
              >
                {t(section.title)}
              </button>
            ))}
          </nav>
        ) : (
          <nav className="wizard-steps" aria-label={t('角色配置步骤')}>
            {steps.map((label, i) => (
              <button
                key={label}
                className={step === i ? 'active' : ''}
                onClick={() => setStep(i)}
                aria-current={step === i ? 'step' : undefined}
              >
                <span>{i + 1}</span>
                {t(label)}
              </button>
            ))}
          </nav>
        )}
        <div className="role-editor-content">
          {issue && <p className="warning">{issue}</p>}
          <section className="card wizard-sheet">
            {personaId ? (
              editorSection === 'profile' ? (
                profileEditor
              ) : editorSection === 'model' ? (
                modelEditor
              ) : editorSection === 'features' ? (
                featureEditor
              ) : editorSection === 'tasks' ? (
                <>
                  {renderFeatures('tasks')}
                  {taskEditor}
                </>
              ) : editorSection === 'summary' ? (
                summaryEditor
              ) : (
                <>
                  {editorSection === 'expression' && expressionEditor}
                  {renderFeatures(editorSection)}
                </>
              )
            ) : step === 0 ? (
              profileEditor
            ) : step === 1 ? (
              <>
                {featureEditor}
                {sections
                  .filter(
                    (section) => !['profile', 'model', 'features', 'summary'].includes(section.id),
                  )
                  .map((section) => (
                    <details className="setup-capability" key={section.id}>
                      <summary>{t(section.title)}</summary>
                      {section.id === 'expression' && expressionEditor}
                      {renderFeatures(section.id)}
                      {section.id === 'tasks' && taskEditor}
                    </details>
                  ))}
              </>
            ) : step === 2 ? (
              modelEditor
            ) : (
              summaryEditor
            )}
          </section>
        </div>
      </div>
      <footer className="wizard-actions">
        <Button
          secondary
          onClick={() =>
            act(async () => {
              await rpc('persona.character.draft', draft);
              baseline.current = draft;
            }, t('草稿已保存'))
          }
        >
          {t('保存草稿')}
        </Button>
        <span className="spacer" />
        {!personaId && step > 0 && (
          <Button secondary onClick={() => setStep(step - 1)}>
            {t('上一步')}
          </Button>
        )}
        {!personaId && step < steps.length - 1 ? (
          <Button onClick={() => setStep(step + 1)}>{t('下一步')}</Button>
        ) : (
          <Button
            disabled={!draft.persona.name.trim()}
            onClick={() =>
              act(async () => {
                const saved = await rpc('persona.character.commit', {
                  draft,
                  requestId: requestId.current,
                });
                baseline.current = draft;
                onComplete(saved);
              }, t('角色配置已保存'))
            }
          >
            {t(personaId ? '保存角色' : '创建角色')}
          </Button>
        )}
      </footer>
    </div>
  );
}
