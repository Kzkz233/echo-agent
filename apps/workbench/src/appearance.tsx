import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.tsx';
import { rpc } from './client.ts';
import {
  markPreferencesSaved,
  preferences,
  setPreferences,
  t,
  usePreferences,
  type Preferences,
} from './i18n.ts';
export function Appearance() {
  const prefs = usePreferences(),
    dialog = useRef<HTMLDialogElement>(null),
    [issue, setIssue] = useState('');
  const version = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = (next: Preferences) => {
    setPreferences(next, true);
    clearTimeout(timer.current);
    const request = ++version.current;
    timer.current = setTimeout(async () => {
      try {
        await rpc('preferences.save', next);
        if (request === version.current) {
          markPreferencesSaved();
          setIssue('');
        }
      } catch (e) {
        if (request === version.current) setIssue((e as Error).message);
      }
    }, 180);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <button
        className="icon-button"
        aria-label={t('外观与语言')}
        title={t('外观与语言')}
        onClick={() => dialog.current?.showModal()}
      >
        <Icon name="settings" size={17} />
      </button>
      <dialog
        className="appearance-dialog"
        ref={dialog}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="row between">
          <h2>{t('外观与语言')}</h2>
          <button
            className="icon-button"
            aria-label={t('关闭')}
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <label className="field">
          <span>{t('界面语言')}</span>
          <select
            aria-label={t('界面语言')}
            value={prefs.language}
            onChange={(e) =>
              save({ ...prefs, language: e.target.value as Preferences['language'] })
            }
          >
            <option value="zh-CN">{t('简体中文')}</option>
            <option value="en">{t('English')}</option>
          </select>
        </label>
        <div className="field">
          <span>{t('主题色')}</span>
          <div className="theme-swatches">
            {[
              ['#5969c9', '靛蓝'],
              ['#287cbd', '海蓝'],
              ['#168477', '青绿'],
              ['#b65f86', '蔷薇'],
              ['#a77729', '琥珀'],
            ].map(([accent, label]) => (
              <button
                key={accent}
                title={t(label)}
                aria-label={t(label)}
                aria-pressed={prefs.accent === accent}
                className={prefs.accent === accent ? 'selected' : ''}
                style={{ background: accent }}
                onClick={() => save({ ...prefs, accent })}
              >
                {prefs.accent === accent && <Icon name="check" size={16} />}
              </button>
            ))}
            <label className="custom-color" title={t('自定义主题色')}>
              <input
                type="color"
                aria-label={t('自定义主题色')}
                value={prefs.accent}
                onChange={(e) => save({ ...prefs, accent: e.target.value })}
              />
              <Icon name="plus" size={15} />
            </label>
          </div>
        </div>
        {issue && (
          <div className="warning" role="alert">
            {issue}
            <button className="text-button" onClick={() => save(preferences())}>
              {t('重试')}
            </button>
          </div>
        )}
        <div className="dialog-actions">
          <button className="primary" onClick={() => dialog.current?.close()}>
            {t('完成')}
          </button>
        </div>
      </dialog>
    </>
  );
}
