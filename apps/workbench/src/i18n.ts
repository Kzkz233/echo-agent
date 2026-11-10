import { useSyncExternalStore } from 'react';
import catalog from './locales.json';
import type { Preferences } from '../../../packages/contracts/index.ts';
export type { Preferences };
export const defaults: Preferences = { language: 'zh-CN', accent: '#5969c9' };
let value: Preferences = defaults;
let unsaved = false;
const listeners = new Set<() => void>();
try {
  const saved = JSON.parse(localStorage.getItem('echo.appearance') ?? 'null');
  if (saved && ['zh-CN', 'en'].includes(saved.language) && /^#[0-9a-f]{6}$/i.test(saved.accent))
    value = saved;
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
const mix = (rgb: number[], other: number[], ratio: number) =>
  rgb.map((v, i) => Math.round(v * (1 - ratio) + other[i] * ratio));
const hex = (rgb: number[]) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
function contrast(rgb: number[]) {
  const c = rgb
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 1.05 / (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722 + 0.05);
}
function apply() {
  const rgb = [1, 3, 5].map((i) => parseInt(value.accent.slice(i, i + 2), 16));
  let ink = [...rgb];
  while (contrast(ink) < 4.55) ink = mix(ink, [0, 0, 0], 0.04);
  const tokens: Record<string, string> = {
    '--accent': value.accent,
    '--accent-text': hex(ink),
    '--accent-on': contrast(rgb) >= 4.5 ? '#ffffff' : '#20283a',
    '--accent-hover': hex(mix(rgb, [0, 0, 0], 0.12)),
    '--accent-soft': hex(mix(ink, [255, 255, 255], 0.92)),
    '--accent-line': hex(mix(ink, [255, 255, 255], 0.73)),
    '--focus-ring': hex(ink) + '18',
  };
  for (const [key, color] of Object.entries(tokens))
    document.documentElement.style.setProperty(key, color);
  document.documentElement.lang = value.language;
  if ('__TAURI_INTERNALS__' in window)
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('set_language', { language: value.language }))
      .catch(() => {});
}
export function setPreferences(next: Preferences, local = false) {
  if (local) unsaved = true;
  if (value.language === next.language && value.accent === next.accent) return;
  value = next;
  try {
    localStorage.setItem('echo.appearance', JSON.stringify(next));
  } catch {}
  apply();
  for (const notify of listeners) notify();
}
export function applySavedPreferences(next: Preferences) {
  if (!unsaved) setPreferences(next);
}
export function markPreferencesSaved() {
  unsaved = false;
}
apply();
