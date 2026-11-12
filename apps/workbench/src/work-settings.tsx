import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { ModelChoice } from './model-choice.tsx';
import { ReasoningSelect } from './reasoning-select.tsx';

export function WorkContextSettings({ personaId, profileId, features, value = {}, onChange }: {
  personaId?: string; profileId?: string; features?: string[]; value?: any; onChange: (value: any) => void;
}) {
  const [catalog, setCatalog] = useState<any>({ options: [], compaction: { triggerTokens: 256000, keepRecentPercent: 8 } });
  const [issue, setIssue] = useState('');
  const [models, setModels] = useState<any>();
  useEffect(() => { let alive = true; void rpc('inference.options').then(result => { if (alive) setModels(result); })
    .catch(error => { if (alive) setIssue(error.message); });
    return () => { alive = false; }; }, []);
  useEffect(() => {
    let alive = true;
    if (personaId) void rpc('work.contextOptions', { personaId, features }).then(result => {
      if (alive) { setCatalog(result); setIssue(''); }
    }).catch(error => { if (alive) setIssue(error.message); });
    return () => { alive = false; };
  }, [personaId, JSON.stringify(features)]);
  const selected: string[] = value.contextBlocks ?? catalog.selected ??
    catalog.options.filter((item: any) => item.default).map((item: any) => item.id);
  const selectedModel = models?.profiles?.find((model: any) => model.id ===
    (profileId || value.profileId || models?.defaults?.[personaId ?? '']?.main));
  const hostManaged = selectedModel?.sessionCapabilities?.contextManagement === 'host' || selectedModel?.workerOnly;
  const outputSupported = !hostManaged || selectedModel?.sessionCapabilities?.outputLimit === true;
  return <details className="setup-capability">
    <summary>{t('上下文设置')}</summary>
    {issue && <p className="warning">{issue}</p>}
    {hostManaged ? <p className="muted">{t('此执行器使用宿主的上下文压缩设置。')}</p> : <label className="field"><span>{t('上下文配置')}</span>
      <select value={value.compaction ? 'custom' : 'inherit'} onChange={event => onChange({ ...value,
        compaction: event.target.value === 'custom' ? catalog.compaction : undefined })}>
        <option value="inherit">{t('沿用角色配置')}</option><option value="custom">{t('自定义')}</option>
      </select>
    </label>}
    {!hostManaged && value.compaction && <div className="form-grid">
      <label className="field"><span>{t('压缩触发上限（tokens）')}</span>
        <input type="number" min={1024} max={2000000} value={value.compaction.triggerTokens}
          onChange={event => onChange({ ...value, compaction: { ...value.compaction, triggerTokens: Number(event.target.value) } })} />
      </label>
      <label className="field"><span>{t('压缩后保留原文（%）')}</span>
        <input type="number" min={0.1} max={99.9} step="0.1" value={value.compaction.keepRecentPercent}
          onChange={event => onChange({ ...value, compaction: { ...value.compaction, keepRecentPercent: Number(event.target.value) } })} />
      </label>
    </div>}
    {outputSupported && <label className="field"><span>{t('单次模型输出上限（tokens）')}</span>
      <input type="number" min={64} max={131072} value={value.maxOutputTokens ?? ''}
        placeholder={t('沿用模型配置')} onChange={event => onChange({ ...value,
          maxOutputTokens: event.target.value ? Number(event.target.value) : undefined })} />
    </label>}
    <fieldset className="automation-options"><legend>{t('上下文注入')}</legend>
      {catalog.options.filter((item: any) => !item.required).map((item: any) => <label className="inline-toggle" key={item.id}>
        <input type="checkbox" disabled={item.required} checked={item.required || selected.includes(item.id)}
          onChange={event => onChange({ ...value, contextBlocks: event.target.checked
            ? [...new Set([...selected, item.id])] : selected.filter(id => id !== item.id) })} />
        {t(item.label)}
      </label>)}
      {value.contextBlocks && <button type="button" className="text-button"
        onClick={() => onChange({ ...value, contextBlocks: undefined })}>{t('恢复默认')}</button>}
    </fieldset>
  </details>;
}

export function WorkExecutionSettings({ personaId, initialPolicy, mainProfileId, features, value = {}, onChange }: {
  personaId?: string; initialPolicy?: any; mainProfileId?: string; features?: string[]; value?: any; onChange: (value: any) => void;
}) {
  const [policy, setPolicy] = useState<any>();
  const [issue, setIssue] = useState('');
  const [models, setModels] = useState<any>();
  const [toolLabels, setToolLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    if (personaId) void Promise.all([initialPolicy ? Promise.resolve({ configurations: { delegation: initialPolicy } }) :
      rpc<any>('persona.character.read', { id: personaId }),
      rpc<any>('inference.options'), rpc<any>('work.contextOptions', { personaId, features })])
      .then(([result, models, context]) => { if (alive) {
        setPolicy(result.configurations.delegation); setModels(models); setToolLabels(context.toolLabels); setIssue('');
      } })
      .catch(error => { if (alive) setIssue(error.message); });
    return () => { alive = false; };
  }, [personaId, JSON.stringify(initialPolicy), JSON.stringify(features)]);
  const main = mainProfileId || models?.defaults?.[personaId ?? '']?.main;
  return <details className="setup-capability">
    <summary>{t('执行设置')}</summary>
    {issue && <p className="warning">{issue}</p>}
    <ModelChoice executor label="子任务执行器" personaId={personaId} value={value.profileId ?? ''}
      disabled={policy?.selectionMode === 'fixed'}
      inheritValue={policy?.selectionMode === 'fixed' ? policy.fixedProfileId || main : main}
      data={models && { profiles: models.profiles.filter((model: any) => model.id === main ||
        policy?.allowedProfileIds?.includes(model.id)), inference: models }}
      onChange={profileId => onChange({ ...value, profileId: profileId || undefined })} />
    <ReasoningSelect value={value.reasoning ?? 'inherit'} personaId={personaId} profileId={value.profileId || main}
      onChange={reasoning => onChange({ ...value, reasoning })} />
    <label className="field"><span>{t('工作目录')}</span>
      <select value={value.projectDirectory ?? ''} onChange={event => onChange({ ...value, projectDirectory: event.target.value || undefined })}>
        <option value="">{t('跟随角色默认')}</option>
        {(policy?.workspaces ?? []).map((root: any) => <option key={root.path} value={root.path}>{root.path}</option>)}
      </select>
    </label>
    <label className="inline-toggle"><input type="checkbox" checked={value.fullAccess || value.write || false}
      disabled={value.fullAccess === true || policy?.approvals === 'deny'}
      onChange={event => onChange({ ...value, write: event.target.checked })} />{t('允许修改文件')}</label>
    <label className="field"><span>{t('执行时限（分钟）')}</span>
      <input type="number" min={1} max={policy?.timeoutMinutes ?? 20}
        value={value.timeoutMinutes ?? Math.min(20, policy?.timeoutMinutes ?? 20)}
        onChange={event => onChange({ ...value, timeoutMinutes: Number(event.target.value) })} />
    </label>
    <details><summary>{t('高级执行设置')}</summary>
      {policy?.allowFullAccess && <label className="inline-toggle"><input type="checkbox" checked={value.fullAccess ?? false}
        onChange={event => onChange({ ...value, fullAccess: event.target.checked })} />{t('本机完全访问')}</label>}
      {policy?.terminal && <label className="inline-toggle"><input type="checkbox" checked={value.terminal ?? false}
        disabled={!(value.write || value.fullAccess) || policy.approvals !== 'ask'}
        onChange={event => onChange({ ...value, terminal: event.target.checked })} />{t('允许终端命令')}</label>}
      {(policy?.workspaces ?? []).map((root: any) => <label className="field" key={root.path}><span>{root.path}</span>
        <select value={(value.workspaces ?? []).find((item: any) => item.path === root.path)?.write ? 'write' :
          (value.workspaces ?? []).some((item: any) => item.path === root.path) ? 'read' : 'none'}
          onChange={event => onChange({ ...value, workspaces: [...(value.workspaces ?? []).filter((item: any) => item.path !== root.path),
            ...(event.target.value === 'none' ? [] : [{ path: root.path, write: event.target.value === 'write' }])] })}>
          <option value="none">{t('不使用')}</option><option value="read">{t('只读')}</option>
          <option value="write" disabled={!root.write || !(value.write || value.fullAccess)}>{t('读写')}</option>
        </select>
      </label>)}
    </details>
    <fieldset className="automation-options"><legend>{t('应用工具')}</legend>
      {(policy?.toolPermissions ?? []).map((permission: string) => <label className="inline-toggle" key={permission}>
        <input type="checkbox" checked={(value.toolPermissions ?? policy.toolPermissions.filter((id: string) => id.endsWith('.read'))).includes(permission)}
          onChange={event => {
            const tools = value.toolPermissions ?? policy.toolPermissions.filter((id: string) => id.endsWith('.read'));
            onChange({ ...value, toolPermissions: event.target.checked ? [...new Set([...tools, permission])] : tools.filter((id: string) => id !== permission) });
          }} />{t(toolLabels[permission] ?? permission.split('.')[0])} · {t(permission.endsWith('.read') ? '读取' : permission.endsWith('.write') ? '修改' : '调用')}
      </label>)}
    </fieldset>
    <WorkContextSettings personaId={personaId} profileId={value.profileId || main} features={features} value={value} onChange={onChange} />
  </details>;
}
