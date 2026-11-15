import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.tsx';
import { rpc } from './client.ts';
import { colorContrast } from '../../../packages/contracts/appearance.ts';
import {
  markPreferencesSaved,
  preferences,
  setPreferences,
  t,
  usePreferences,
  type Preferences,
} from './i18n.ts';
export function AppearanceSettings({ compact = false }: { compact?: boolean }) {
  const prefs = usePreferences(),
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
      <section className={'appearance-settings' + (compact ? ' is-compact' : '')}>
        {!compact && (
          <div className="page-title">
            <h1>{t('外观与语言')}</h1>
          </div>
        )}
        <fieldset className="appearance-modes">
          <legend>{t('界面外观')}</legend>
          {(
            [
              ['system', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ] as const
          ).map(([mode, label]) => (
            <button
              type="button"
              key={mode}
              className="appearance-mode"
              aria-pressed={(prefs.theme ?? 'system') === mode}
              onClick={() => save({ ...prefs, theme: mode })}
            >
              <span className={'appearance-mode-preview ' + mode} aria-hidden="true">
                <i />
                <i />
              </span>
              <span>{t(label)}</span>
              {(prefs.theme ?? 'system') === mode && <Icon name="check" size={14} />}
            </button>
          ))}
        </fieldset>
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
          <span>{t('强调色')}</span>
          <div className="theme-swatches">
            {[
              ['#1f647a', '湖蓝'],
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
                style={{
                  background: accent,
                  color: colorContrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#20283a',
                }}
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
          <small>{t('用于链接与交互标记，背景和主操作保持中性。')}</small>
        </div>
        <label className="field">
          <span>{t('聊天字号')}</span>
          <select
            aria-label={t('聊天字号')}
            value={prefs.chatFontSize ?? 15}
            onChange={(e) => save({ ...prefs, chatFontSize: Number(e.target.value) })}
          >
            {[14, 15, 16, 17, 18].map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('界面字号')}</span>
          <select
            aria-label={t('界面字号')}
            value={prefs.uiFontSize ?? 14}
            onChange={(event) => save({ ...prefs, uiFontSize: Number(event.target.value) })}
          >
            {[14, 15, 16].map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
        <label className="appearance-toggle">
          <span>
            {t('增强界面对比')}
            <small>{t('加深分隔线与控件边界。')}</small>
          </span>
          <input
            type="checkbox"
            aria-label={t('增强界面对比')}
            checked={prefs.highContrast ?? false}
            onChange={(e) => save({ ...prefs, highContrast: e.target.checked })}
          />
        </label>
        <label className="appearance-toggle">
          <span>
            {t('减少动态效果')}
            <small>{t('减少界面运动，保留必要的状态反馈。')}</small>
          </span>
          <input
            type="checkbox"
            aria-label={t('减少动态效果')}
            checked={prefs.reducedMotion ?? false}
            onChange={(e) => save({ ...prefs, reducedMotion: e.target.checked })}
          />
        </label>
        {issue && (
          <div className="warning" role="alert">
            {issue}
            <button className="text-button" onClick={() => save(preferences())}>
              {t('重试')}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
export function Appearance() {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        className="icon-button appearance-trigger"
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
        <AppearanceSettings compact />
        <div className="dialog-actions">
          <button className="primary" onClick={() => dialog.current?.close()}>
            {t('完成')}
          </button>
        </div>
      </dialog>
    </>
  );
}
