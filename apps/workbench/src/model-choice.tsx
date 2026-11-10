import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { modelEligible } from './model-eligibility.ts';

export function ModelChoice({
  value = '',
  onChange,
  label = '语言模型',
  executor = false,
  data,
  taskId,
  inherit = true,
  inheritLabel = '跟随角色默认',
  inheritValue,
  personaId,
  backendKinds,
  disabled = false,
}: {
  value?: string;
  onChange: (value: string) => void;
  label?: string;
  executor?: boolean;
  data?: any;
  taskId?: string;
  inherit?: boolean;
  inheritLabel?: string;
  inheritValue?: string;
  personaId?: string;
  backendKinds?: string[];
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<any>();
  const [issue, setIssue] = useState('');
  const [pendingExecutor, selectExecutor] = useState<string>();
  useEffect(() => {
    if (data) return;
    let active = true,
      revision = 0;
    const load = () => {
      const current = ++revision;
      void rpc('inference.options')
        .then((result) => {
          if (active && current === revision) {
            setCatalog(result);
            setIssue('');
          }
        })
        .catch((error) => {
          if (active && current === revision) {
            setCatalog(undefined);
            setIssue(error.message);
          }
        });
    };
    const changed = (event: Event) => {
      if (
        /^(models|connections|plugins|inference|characters|binding)\./.test(
          (event as CustomEvent).detail.type,
        )
      )
        load();
    };
    load();
    window.addEventListener('echo-event', changed);
    return () => {
      active = false;
      window.removeEventListener('echo-event', changed);
    };
  }, [data]);
  useEffect(() => selectExecutor(undefined), [value, taskId, personaId]);
  const profiles = data?.profiles ?? catalog?.profiles ?? [];
  const adapters = data?.inference?.adapters ?? catalog?.adapters ?? [];
  const defaults = data?.inference?.defaults ?? catalog?.defaults ?? {};
  const role = personaId ? defaults[personaId] : undefined;
  const inherited =
    inheritValue ?? (role ? (taskId ? role.routes?.[taskId] : undefined) || role.main : undefined);
  const hasInheritance = inheritValue !== undefined || Boolean(personaId);
  const eligible = profiles.filter((profile: any) =>
    modelEligible(profile, { taskId, executor, backendKinds }),
  );
  const canInherit =
    inherit && (!hasInheritance || eligible.some((profile: any) => profile.id === inherited));
  const selected = profiles.find((profile: any) => profile.id === value);
  const selectedExecutor =
    pendingExecutor ??
    (selected && !selected.available
      ? 'unavailable'
      : selected?.workerOnly
        ? selected.adapterId
        : 'builtin');
  const forExecutor = (id: string) =>
    eligible.filter((profile: any) =>
      id === 'builtin' ? !profile.workerOnly : profile.adapterId === id,
    );
  const candidates = executor ? forExecutor(selectedExecutor) : eligible;
  const workerAdapters = adapters.filter((adapter: any) => adapter.workerOnly);
  const emptyLabel = hasInheritance
    ? inheritLabel
    : inheritLabel === '跟随角色默认'
      ? '未选择'
      : inheritLabel;
  return (
    <div className="model-choice">
      {executor && (
        <label className="field">
          <span>{t(label)}</span>
          <select
            aria-label={t(label)}
            value={selectedExecutor}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              selectExecutor(next);
              onChange(next === 'builtin' && canInherit ? '' : (forExecutor(next)[0]?.id ?? ''));
            }}
          >
            <option value="builtin" disabled={!canInherit && !forExecutor('builtin').length}>
              {t('内置执行器')}
            </option>
            {workerAdapters.map((adapter: any) => (
              <option
                key={adapter.id}
                value={adapter.id}
                disabled={!forExecutor(adapter.id).length}
              >
                {t(adapter.label)}
              </option>
            ))}
            {selectedExecutor !== 'builtin' &&
              !workerAdapters.some((adapter: any) => adapter.id === selectedExecutor) && (
                <option value={selectedExecutor} disabled>
                  {t('执行器不可用')}
                </option>
              )}
          </select>
        </label>
      )}
      <label className="field">
        <span>{t(executor ? '执行模型' : label)}</span>
        <select
          aria-label={t(executor ? '执行模型' : label)}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            selectExecutor(undefined);
            onChange(event.target.value);
          }}
        >
          <option value="" disabled={!canInherit || (executor && selectedExecutor !== 'builtin')}>
            {t(inherit ? emptyLabel : '选择模型')}
            {inherit && hasInheritance && !canInherit ? ' · ' + t('当前不可用') : ''}
          </option>
          {candidates.map((profile: any) => (
            <option key={profile.id} value={profile.id}>
              {profile.model || profile.name}
              {profile.connectionName ? ' · ' + profile.connectionName : ''}
            </option>
          ))}
          {value && !candidates.some((profile: any) => profile.id === value) && (
            <option value={value} disabled>
              {selected?.model || selected?.name || value} · {t('当前不可用')}
            </option>
          )}
        </select>
      </label>
      {issue && <p className="warning">{issue}</p>}
      {executor && selectedExecutor !== 'builtin' && !candidates.length && (
        <p className="muted">{t('请在执行器插件中添加可用的执行配置。')}</p>
      )}
    </div>
  );
}
