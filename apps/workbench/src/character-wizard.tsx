import { revealSetting } from './settings-locator.ts';
import { QuickModel } from './quick-model.tsx';
import { SettingsFields } from './settings-fields.tsx';
import { editedCharacter, mergeCharacter, taskKey } from '../../../plugins/persona/character-edits.ts';
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
import { TaskField, TaskFieldGroups } from './automation-view.tsx';
import { RolePluginTools, grantAction } from './role-plugin-tools.tsx';
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
  initialField,
}: any) {
  const [catalog, setCatalog] = useState<any>();
  const [draft, setDraft] = useState<CharacterDraft>();
  const [step, setStep] = useState(0);
  const [editorSection, setEditorSection] = useState(
    ['profile', 'profile', 'memory', 'model', 'tasks', 'summary', 'appearance', 'expression', 'features'][
      initialStep
    ] ?? 'profile',
  );
  const [search, setSearch] = useState('');
  useEffect(() => { if (initialField && catalog) revealSetting(initialField); }, [catalog, initialField]);
  const [issue, setIssue] = useState('');
  const [packages, setPackages] = useState<any>();
  const [savedDrafts, setSavedDrafts] = useState<any[]>([]);
  const [taskIndex, setTaskIndex] = useState(-1);
  const [advancedCreation, setAdvancedCreation] = useState(false);
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
  const editBase = useRef<CharacterDraft>(undefined);
  const removals = useRef(new Set<string>());
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
          profileId: data.profiles.find((p: any) => p.available && p.eligibility?.conversation)?.id,
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
        if (initialField === t('允许观察的来源') && !next.tasks.some(row => row.type === 'observation.tasks')) { setChoosingTask(true); setTaskSearch(t('实时观察')); }
        setTaskIndex(
          initialTaskId
            ? Math.max(
                0,
                next.tasks.findIndex((task) => task.id === initialTaskId),
              )
            : initialField === t('允许观察的来源') ? next.tasks.findIndex(row => row.type === 'observation.tasks') : -1,
        );
        baseline.current = next;
        editBase.current = saved ? next : undefined;
        removals.current.clear();
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
        )),
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
      : f.resource === 'permission' ? data.mcpPermissionCatalog.filter((p:any)=>draft.toolPermissions.includes(p.permission)).map((p:any)=>({id:p.permission,name:p.external ? `${t(p.external.server)} · ${p.external.tool}` : p.owners.map((id:string)=>t(data.plugins.find((plugin:any)=>plugin.id===id)?.name??'共享模块')).join(' · ')+' · '+grantAction(p.permission)})) : [];
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
  const chatConnection = !draft.profileId && <details className="setup-capability">
    <summary>{t('连接聊天模型')}</summary>
    <QuickModel localRuntime={data.plugins.some((p: any) => p.id === 'local-models' && p.enabled)}
      onReady={async profileId => { await act(async () => true, ''); change({ profileId }); }} />
  </details>;
  const modelEditor = (
    <>
      <ModelChoice
        data={data}
        label="主会话模型"
        value={draft.profileId}
        inherit={false}
        onChange={(profileId) => change({ profileId })}
      />
      {chatConnection}
      <details className="setup-capability"><summary>{t('思考强度')}</summary>
      <ReasoningSelect
        value={draft.reasoning}
        profileId={draft.profileId || undefined}
        onChange={(value) => change({ reasoning: value as any })}
      />
      </details>
      <details className="setup-capability">
        <summary>{t('主会话上下文')} · {compaction.triggerTokens?.toLocaleString()} tokens</summary>
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
      </details>
      <EchoToolSettings permissions={draft.permissions} onSave={(permissions) => change({ permissions })} />
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
        <Button secondary onClick={() => document.getElementById('role-plugin-tools')?.querySelector('input')?.focus()}>
          {t('插件工具授权')}
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
            onChange={async (e) => {
              const saved = savedDrafts.find((row) => row.persona.id === e.target.value);
              if (saved) {
                try {
                  const exists = data.characters.some((c: any) => c.id === saved.persona.id);
                  const live = exists ? characterDraft.parse(await rpc('persona.character.read', { id:saved.persona.id })) : undefined;
                  if (live && !saved.edits) { setIssue(t('旧草稿缺少编辑基线，请从角色资料重新编辑。')); return; }
                  const next = live ? mergeCharacter(live, saved.edits) : characterDraft.parse(saved);
                  editBase.current = live;
                  removals.current = new Set((saved.edits?.tasks ?? []).flatMap((e: any) => e.action === 'remove' ? [taskKey(e.task)] : []));
                  change(next);
                  baseline.current = next;
                } catch (err) { setIssue((err as Error).message); }
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
      <RolePluginTools features={catalog.features} selectedFeatures={draft.features} toggleFeature={toggleFeature} catalog={data.mcpPermissionCatalog ?? []} plugins={data.plugins}
        main={draft.toolPermissions}
        workers={canDelegate ? (delegation?.toolPermissions as string[] | undefined) ?? [] : undefined}
        onMain={(toolPermissions) => change({ independentToolGrants: true, toolPermissions })}
        onWorkers={(permissions) => changeConfig('delegation', 'toolPermissions', permissions)}
        configure={(target) => openSettings('plugins', target)} />
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
              .filter((v: any) => v.canRemove && t(v.name).toLowerCase().includes(taskSearch.toLowerCase()))
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
        {draft.tasks.map((task, i) => {
          const registered = catalog.taskTypes.find((v: any) => v.id === task.type)?.items?.find((v: any) => v.id === task.id);
          return (
          <button
            key={task.id}
            className={i === taskIndex ? 'active' : ''}
            aria-expanded={taskIndex === i}
            onClick={() => setTaskIndex(taskIndex === i ? -1 : i)}
          >
            {String(task.settings.name ?? task.type)} · {t(task.settings.enabled ? '已启用' : '已暂停')}
            {registered?.state === 'failed' && ' · ' + t('需要检查')}
            {registered?.nextAt && task.settings.enabled && <small>{t('下次运行')} · {new Date(registered.nextAt).toLocaleString()}</small>}
          </button>
        ); })}
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
            <TaskFieldGroups fields={type.fields.filter(
                (f: any) => !['personaId', 'conversationId', 'reportConversationId'].includes(f.key),
              )} render={f => (
                <TaskField
                  plugins={data.plugins}
                  workPolicy={draft.configurations.delegation}
                  features={draft.features}
                  key={task.id + ':' + f.key}
                  field={f}
                  profileId={
                    f.modelFallback === 'main' || !f.inferenceTask || f.inferenceTask === inferenceTasks.chat
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
              )} />
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
          {type.canRemove && <Button
            secondary
            onClick={() => {
              removals.current.add(taskKey(task));
              change({ tasks: draft.tasks.filter((_, i) => i !== taskIndex) });
              setTaskIndex(-1);
            }}
          >
            {t('移除任务')}
          </Button>}
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
  const expressionField = ([key,label]: typeof expressionFields[number]) => (
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
  );
  const expressionEditor = (
    <>
      <details className="card" open>
        <summary>{t('表达风格')}</summary>
        <div className="form-grid">
          {expressionFields.filter(([key]) => key === 'chat' || deliveryTargets.some(target => target.ready && target.style === key)).map(row =>
            <details className="setup-capability" key={row[0]}><summary>{t(row[1])}</summary>{expressionField(row)}</details>)}
          {channelStyles.filter(entry => deliveryTargets.some(target => target.style === entry.style && target.ready)).map(entry => <details key={entry.style} className="setup-capability"><summary>{t(entry.label)}</summary>
            <label className="field"><span>{t('回复风格')}</span><textarea rows={3} maxLength={600} value={draft.persona.expression?.channels?.[entry.style] ?? (entry.presentation === 'external' ? draft.persona.expression?.external : '') ?? ''}
              onChange={e => change({persona:{...draft.persona,expression:{...draft.persona.expression, channels:{...draft.persona.expression?.channels,[entry.style]:e.target.value}}}})} /></label></details>)}
          <details className="setup-capability">
            <summary>{t('其他渠道的表达风格')}</summary>
            {expressionFields.filter(([key]) => key !== 'chat' && !deliveryTargets.some(target => target.ready && target.style === key)).map(expressionField)}
          {channelStyles.filter(entry => !deliveryTargets.some(target => target.style === entry.style && target.ready)).map(({ style, label, presentation }) => <label className="field" key={style}>
            <span>{t('{channel} 回复风格', { channel: t(label) })}</span>
            <textarea rows={3} maxLength={600} aria-label={t('{channel} 回复风格', { channel: t(label) })} placeholder={t('留空沿用角色人设')}
              value={draft.persona.expression?.channels?.[style] ?? (presentation === 'external' ? draft.persona.expression?.external : undefined) ?? ''}
              onChange={(event) => change({ persona: { ...draft.persona, expression: { ...draft.persona.expression,
                channels: { ...draft.persona.expression?.channels, [style]: event.target.value },
              } } })} />
          </label>)}
          </details>
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
            {item.id === 'memory' && <p>{t('角色记忆已启用。可在角色资料中查看和纠正记忆。')}</p>}
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
                  <details className="setup-capability"><summary>{t('状态动画')}</summary>
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
                  </details>
                  <SettingsFields fields={feature('avatar')?.fields.filter((f: any) => f.key !== 'assetDirectory') ?? []}
                    render={(f: any) => field('avatar', f)} advanced={(f: any) => f.advanced === true} />
                </section>
              )
            ) : (
              <SettingsFields fields={item.fields.filter((f: any) => item.id !== 'delegation' || !delegationPermissionFields.includes(f.key))}
                render={(f: any) => field(item.id, f)} advanced={(f: any) => f.advanced === true} />
            )}
            {data.inference.tasks
              .filter(
                (task: any) =>
                  task.owner === item.id && task.scope === 'character' && !item.taskTypes?.length,
              )
              .map((task: any) => (
                <details className="setup-capability" key={task.id}><summary>{t(task.label)}</summary>
                <ModelChoice
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
                /></details>
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
            <input type="search" aria-label={t('查找角色设置')} placeholder={t('查找角色设置')} value={search} onChange={e => setSearch(e.target.value)} />
            {search.trim() && [...new Map([
              ...catalog.features.filter((f: any) => draft.features.includes(f.id)).flatMap((f: any) => f.fields.map((v: any) => ({label:t(v.label), section:f.presentation?.section ?? 'extensions', task:-1}))),
              ...draft.tasks.flatMap((row, index) => (catalog.taskTypes.find((type: any) => type.id === row.type)?.fields ?? []).map((f: any) => ({label:t(f.label),section:'tasks',task:index}))),
              ...['主会话模型','思考强度','压缩触发上限（tokens）','工作目录与文件权限','子任务权限'].map(label => ({label:t(label),section:'model',task:-1})),
            ].map((entry: {label:string;section:string;task:number}) => [entry.section + entry.task + entry.label,entry] as const)).values()].filter(entry => entry.label.toLowerCase().includes(search.trim().toLowerCase())).slice(0,12).map(entry =>
              <button key={entry.section + entry.task + entry.label} onClick={() => { setEditorSection(entry.section); if (entry.task >= 0) setTaskIndex(entry.task); setSearch(''); requestAnimationFrame(() => revealSetting(entry.label)); }}>
                {entry.label}{entry.task >= 0 && ' · ' + draft.tasks[entry.task].settings.name}</button>)}
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
          <nav className="wizard-steps" hidden={!advancedCreation} aria-label={t('角色配置步骤')}>
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
              <>{profileEditor}<ModelChoice label="主会话模型" data={data} value={draft.profileId} inherit={false} onChange={(profileId) => change({ profileId })} />
              {chatConnection}</>
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
        <details><summary>{t('草稿')}</summary><Button
          secondary
          onClick={() =>
            act(async () => {
              await rpc('persona.character.draft', { ...draft, edits:editBase.current && editedCharacter(editBase.current,draft,removals.current) });
              baseline.current = draft;
            }, t('草稿已保存'))
          }
        >
          {t('保存草稿')}
        </Button></details>
        <span className="spacer" />
        {!personaId && step > 0 && (
          <Button secondary onClick={() => setStep(step - 1)}>
            {t('上一步')}
          </Button>
        )}
        {!personaId && step < steps.length - 1 && (
          <Button secondary onClick={() => { setAdvancedCreation(true); setStep(step + 1); }}>{t('更多设置')}</Button>
        )}
        {(
          <Button
            disabled={!draft.persona.name.trim()}
            onClick={() =>
              act(async () => {
                const saved = editBase.current
                  ? await rpc('persona.character.patch', { id:editBase.current.persona.id,
                      changes:editedCharacter(editBase.current,draft,removals.current), requestId:requestId.current })
                  : await rpc('persona.character.commit', { draft, createOnly:true, requestId:requestId.current });
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
