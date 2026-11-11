import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { avatarStateClip } from '../../../packages/contracts/avatar.ts';
export function AvatarBehavior({ personaId, config, providers, onChange }: any) {
  const [clips, setClips] = useState<string[]>(['idle', 'walk', 'jump']);
  const [states, setStates] = useState<any[]>([]);
  const [stateClips, setStateClips] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    setStateClips({});
    if (config.renderer && config.renderer !== 'frames')
      void rpc('avatar.rendererInfo', { renderer: config.renderer, personaId })
        .then((info) => {
          if (active) {
            setStateClips(info.stateClips);
            if (info.clips.length) setClips(info.clips);
          }
        })
        .catch(() => {});
    if (personaId)
      void rpc<string[]>('avatar.clips', { personaId })
        .then((items) => {
          if (active && items.length) setClips(items);
        })
        .catch(() => {});
    void rpc<any[]>('avatar.states', personaId ? { personaId } : {})
      .then((items) => {
        if (active) setStates(items);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [personaId, config.assetDirectory, config.renderer]);
  const available = providers.filter(
    (provider: any) => provider.point === 'avatar.renderers@1' && provider.state === 'active',
  );
  return (
    <>
      <label className="field">
        <span>{t('Character renderer')}</span>
        <select
          value={config.renderer ?? 'frames'}
          onChange={(event) => onChange({ renderer: event.target.value })}
        >
          <option value="frames">{t('Frame animation (lightweight default)')}</option>
          {available.map((provider: any) => (
            <option key={provider.id} value={provider.id}>
              {t(provider.label)}
            </option>
          ))}
          {config.renderer &&
            config.renderer !== 'frames' &&
            !available.some((provider: any) => provider.id === config.renderer) && (
              <option value={config.renderer}>
                {config.renderer} · {t('当前不可用')}
              </option>
            )}
        </select>
      </label>
      {
        <section className="state-animation-settings">
          <h3>{t('状态动画')}</h3>
          <p className="muted">{t('多个状态可同时生效，优先播放优先级较高的动画。')}</p>
          <div className="state-animation-grid">
            {states.map((state) => {
              const rule = config.stateRules?.[state.id] ?? {};
              const clip = rule.clip ?? stateClips[state.id] ?? avatarStateClip(state, config);
              const patch = (value: any) =>
                onChange({
                  stateRules: { ...config.stateRules, [state.id]: { ...rule, ...value } },
                });
              return (
                <div className="state-animation-row" key={state.id}>
                  <span>
                    {t(state.label)} <small>({state.owner})</small>
                  </span>
                  <label className="field">
                    <span>{t('动画')}</span>
                    <select value={clip} onChange={(event) => patch({ clip: event.target.value })}>
                      {[...new Set([...clips, clip])].map((name) => (
                        <option value={name} key={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t('优先级')}</span>
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={rule.priority ?? state.priority}
                      onChange={(event) => patch({ priority: event.target.valueAsNumber })}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </section>
      }
    </>
  );
}
