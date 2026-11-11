import { modelDisplayName } from '../../../packages/contracts/model-services.ts';
import { ModelChoice } from './model-choice.tsx';
import { ReasoningSelect } from './reasoning-select.tsx';
import { modelEligible } from './model-eligibility.ts';
import { t } from './i18n.ts';

/** Executor types come from the adapter registry; profile ids remain the grant ceiling. */
export function DelegationExecutors({
  data,
  policy,
  mainProfileId,
  onChange,
}: {
  data: any;
  policy: any;
  mainProfileId: string;
  onChange: (patch: any) => void;
}) {
  const models = data.profiles.filter((p: any) => modelEligible(p, { executor: true }));
  const ids: string[] = policy.allowedProfileIds ?? [];
  const allowed = models.filter((p: any) => p.id === mainProfileId || ids.includes(p.id));
  const groups = [
    { id: 'builtin', label: '内置执行器' },
    ...(data.inference?.adapters ?? []).filter((a: any) => a.workerOnly),
  ];
  const groupFor = (p: any) => (p.workerOnly ? p.adapterId : 'builtin');
  const mode = policy.selectionMode ?? 'choose';
  const fixed = policy.fixedProfileId || mainProfileId;
  return (
    <section className="record-fields" data-delegation-executors>
      <label className="field">
        <span>{t('子任务执行方式')}</span>
        <select
          aria-label={t('子任务执行方式')}
          value={mode}
          onChange={(e) => onChange({ selectionMode: e.target.value })}
        >
          <option value="choose">{t('主会话按任务选择')}</option>
          <option value="fixed">{t('使用指定执行器')}</option>
        </select>
      </label>
      {mode === 'fixed' ? (
        <ModelChoice
          data={{ ...data, profiles: allowed }}
          executor
          label="指定执行器"
          value={policy.fixedProfileId ?? ''}
          inheritValue={mainProfileId}
          onChange={(value) => onChange({ fixedProfileId: value })}
        />
      ) : null}
      <fieldset className="automation-options">
        <legend>{t('可用执行器')}</legend>
        {groups.map((group: any) => {
          const candidates = models.filter((p: any) => groupFor(p) === group.id);
          const granted = candidates.filter(
            (p: any) => p.id === mainProfileId || ids.includes(p.id),
          );
          return (
            <details key={group.id}>
              <summary>
                {t(group.label)} · {granted.length}/{candidates.length}
              </summary>
              {candidates.map((p: any) => (
                <label key={p.id} className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={p.id === mainProfileId || ids.includes(p.id)}
                    disabled={p.id === mainProfileId}
                    onChange={(e) =>
                      onChange({
                        allowedProfileIds: e.target.checked
                          ? [...new Set([...ids, p.id])]
                          : ids.filter((id) => id !== p.id),
                      })
                    }
                  />
                  {modelDisplayName(p)}
                  {p.connectionName ? ' · ' + p.connectionName : ''}
                  {p.id === mainProfileId ? ' · ' + t('主会话配置') : ''}
                </label>
              ))}
              {!candidates.length && (
                <p className="muted">{t('请在执行器插件中添加可用的执行配置。')}</p>
              )}
            </details>
          );
        })}
        {ids
          .filter((id) => !models.some((p: any) => p.id === id))
          .map((id) => (
            <label key={id} className="inline-toggle">
              <input
                type="checkbox"
                checked
                onChange={() =>
                  onChange({ allowedProfileIds: ids.filter((value) => value !== id) })
                }
              />
              {id} · {t('当前不可用')}
            </label>
          ))}
      </fieldset>
      <ReasoningSelect
        label="子任务默认思考强度"
        value={policy.defaultReasoning ?? 'inherit'}
        profileId={mode === 'fixed' ? fixed : mainProfileId}
        onChange={(value) => onChange({ defaultReasoning: value })}
      />
      <p className="muted">{t('每次委派可单独选择思考强度；受理前会检查所选执行器是否支持。')}</p>
    </section>
  );
}
