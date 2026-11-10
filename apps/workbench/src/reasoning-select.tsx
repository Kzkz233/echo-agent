import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Icon } from './ui.tsx';
import { type ReasoningSupport } from '../../../packages/contracts/reasoning.ts';

const labels = {
  inherit: '跟随后端默认',
  off: '关闭思考',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};
export function ReasoningSelect({
  value,
  onChange,
  label = '思考强度',
  profileId,
  connectionId,
  model,
  taskId,
  personaId,
  disabled,
  compact = false,
  support: supplied,
  capabilitiesOnly = false,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  compact?: boolean;
  profileId?: string;
  connectionId?: string;
  model?: string;
  taskId?: string;
  personaId?: string;
  support?: ReasoningSupport;
  capabilitiesOnly?: boolean;
  style?: string;
}) {
  const [result, setResult] = useState<{
    key: string;
    support?: ReasoningSupport;
    issue?: string;
    status?: string;
  }>();
  const [revision, refresh] = useState(0);
  const key = JSON.stringify([profileId, connectionId, model, taskId, personaId, style]);
  const current = result?.key === key ? result : undefined;
  const support = supplied ?? current?.support;
  useEffect(() => {
    let active = true;
    if (supplied || !(profileId || (connectionId && model) || taskId)) return;
    void rpc<{ reasoning: ReasoningSupport | null; status?: string; issue?: string }>(
      'profiles.reasoning',
      {
        profileId,
        connectionId,
        model,
        taskId,
        personaId,
        style,
        refresh: revision > 0,
      },
    )
      .then((data) => {
        if (active)
          setResult({
            key,
            support: data.reasoning ?? undefined,
            status: data.status,
            issue: data.issue,
          });
      })
      .catch((error) => {
        if (active) setResult({ key, issue: error.message });
      });
    return () => {
      active = false;
    };
  }, [key, revision, supplied]);
  const levels = support?.levels ?? [];
  const alias = support?.aliases?.[value];
  const unsupported = !!support && value !== 'inherit' && !levels.includes(value as any) && !alias;
  const levelLabel = (level: string) =>
    support?.kind === 'toggle' && level !== 'off'
      ? t('开启思考')
      : t(labels[level as keyof typeof labels] ?? level);
  const select = (
    <select
      aria-label={t(label)}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="inherit">{t(labels.inherit)}</option>
      {value !== 'inherit' && !levels.includes(value as any) && (
        <option value={value} disabled={unsupported}>
          {t(labels[value as keyof typeof labels] ?? value)}
          {alias
            ? ' → ' + t(labels[alias])
            : ' · ' + t(support ? '当前模型不支持' : '支持情况未确认')}
        </option>
      )}
      {levels.map((level) => (
        <option value={level} key={level}>
          {levelLabel(level)}
        </option>
      ))}
    </select>
  );
  if (compact)
    return (
      <label
        className={'reasoning-compact' + (unsupported ? ' warning' : '')}
        title={
          t(label) +
          ' · ' +
          t(labels[value as keyof typeof labels] ?? value) +
          (unsupported
            ? '\n' + t('当前模型不支持')
            : !support && current
              ? '\n' + t('未提供思考支持项，可按接口文档手动设置。')
              : '')
        }
      >
        <Icon name="reasoning" size={15} />
        {select}
      </label>
    );
  return (
    <label className="field">
      <span>{t(label)}</span>
      {capabilitiesOnly ? (
        <div className="row wrap">
          {levels.map((level) => (
            <span className="state-pill" key={level}>
              {levelLabel(level)}
            </span>
          ))}
        </div>
      ) : (
        select
      )}
      {support ? (
        <small className={unsupported ? 'warning' : 'muted'}>
          {t(
            unsupported
              ? '保留原设置，请选择当前模型支持的强度。'
              : support.source === 'host'
                ? '支持项来自宿主模型目录'
                : support.source === 'catalog'
                  ? '支持项来自已核对的接口文档'
                  : support.source === 'manual'
                    ? '支持项来自所选兼容方案'
                    : '支持项来自上游模型目录',
          )}
        </small>
      ) : (
        current && (
          <small className={current.issue ? 'warning' : 'muted'}>
            {t(
              current.status === 'not-listed'
                ? '当前模型未出现在上游目录中'
                : current.issue
                  ? '读取模型支持项失败'
                  : '上游未提供思考能力元数据',
            )}
            {current.issue ? ' · ' + current.issue : ''}
          </small>
        )
      )}
      {!supplied && (profileId || connectionId || taskId) && (
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          onClick={() => refresh((n) => n + 1)}
        >
          {t('刷新思考支持项')}
        </button>
      )}
    </label>
  );
}
