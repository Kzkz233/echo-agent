import { useSyncExternalStore } from 'react';
import catalog from './locales.json';
import type { Preferences } from '../../../packages/contracts/index.ts';
import { preferencesSchema } from '../../../packages/contracts/index.ts';
import { appearanceSnapshot, defaultAccent } from '../../../packages/contracts/appearance.ts';
export type { Preferences };
export const defaults: Preferences = { language: 'zh-CN', accent: defaultAccent };
let value: Preferences = defaults;
let unsaved = false;
const listeners = new Set<() => void>();
try {
  const saved = JSON.parse(localStorage.getItem('echo.appearance') ?? 'null');
  const parsed = preferencesSchema.safeParse(saved);
  if (parsed.success) value = parsed.data;
} catch {}
export const preferences = () => value;
export function usePreferences() {
  return useSyncExternalStore((callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }, preferences);
}
const index = new Map<string, [string, string]>();
for (const pair of catalog as [string, string][]) for (const text of pair) index.set(text, pair);
export function t(source: string, parameters?: Record<string, string | number>): string {
  const text = index.get(source)?.[value.language === 'en' ? 1 : 0] ?? source;
  return parameters
    ? text.replace(/\{(\w+)\}/g, (token, key) =>
        parameters[key] === undefined ? token : String(parameters[key]),
      )
    : text;
}
export function errorText(code: string | undefined, message: string) {
  const own: Record<string, string> = {
    missing_route: '请先选择语言模型。',
    missing_profile: '请先选择语言模型。',
    missing_conversation: '找不到这条会话。',
    conversation_busy: '会话仍有运行或未知结果，请先核对。',
    unresolved_run: '会话仍有运行或未知结果，请先核对。',
    conversation_referenced: '会话仍有绑定，请先解除。',
  };
  if (value.language === 'en' && own[code ?? '']) return t(own[code!]);
  if (code === 'invalid_request' && message.trim().startsWith('['))
    return t('配置项无效，请检查表单。');
  return t(message);
}
export const locale = () => (value.language === 'en' ? 'en-US' : 'zh-CN');
export function statusText(state: string) {
  const labels: Record<string, string> = {
    active: '已启用',
    disabled: '未启用',
    waiting: '等待依赖',
    failed: '失败',
    unknown: '结果待核对',
    succeeded: '已成功',
    completed: '已完成',
    pending: '待处理',
    running: '进行中',
    executing: '进行中',
    paused: '已暂停',
    rejected: '已拒绝',
    delivered: '已投递',
    queued: '排队中',
    draft: '草稿',
    sent: '已发送',
    sending: '发送中',
    read: '已读',
    unread: '未读',
    open: '待办',
    done: '已完成',
    cancelled: '已取消',
    blocked: '已阻塞',
  };
  return t(labels[state] ?? state);
}
const systemAppearance = matchMedia('(prefers-color-scheme: dark)');
export const currentAppearance = () => appearanceSnapshot(value, systemAppearance.matches);
let appearanceRevision = 0;
function apply() {
  const revision = ++appearanceRevision;
  document.documentElement.dataset.echoThemeChanging = 'true';
  const appearance = currentAppearance();
  for (const [key, color] of Object.entries(appearance.tokens))
    document.documentElement.style.setProperty(key, color);
  document.documentElement.style.colorScheme = appearance.mode;
  document.documentElement.dataset.echoTheme = appearance.mode;
  document.documentElement.dataset.echoReducedMotion = String(appearance.reducedMotion);
  document.documentElement.lang = value.language;
  dispatchEvent(new CustomEvent('echo-theme-changed', { detail: appearance }));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (revision === appearanceRevision)
        delete document.documentElement.dataset.echoThemeChanging;
    }),
  );
  if ('__TAURI_INTERNALS__' in window)
    void import('@tauri-apps/api/core')
      .then(({ invoke }) =>
        Promise.all([
          invoke('set_language', { language: value.language }),
          invoke('set_appearance', { theme: value.theme ?? 'system' }),
        ]),
      )
      .catch(() => {});
}
export function setPreferences(next: Preferences, local = false) {
  if (local) unsaved = true;
  if (JSON.stringify(value) === JSON.stringify(next)) return;
  value = next;
  try {
    localStorage.setItem('echo.appearance', JSON.stringify(next));
  } catch {}
  apply();
  for (const notify of listeners) notify();
}
systemAppearance.addEventListener('change', () => {
  if (!value.theme || value.theme === 'system') apply();
});
export function applySavedPreferences(next: Preferences) {
  if (!unsaved) setPreferences(next);
}
export function markPreferencesSaved() {
  unsaved = false;
}
apply();
