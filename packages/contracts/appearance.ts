import type { Preferences } from './index.ts';

export const defaultAccent = '#1f647a';
export type AppearanceMode = 'light' | 'dark';
export type AppearanceSnapshot = {
  version: 1;
  mode: AppearanceMode;
  reducedMotion: boolean;
  tokens: Record<string, string>;
};

const light = {
  background: '#fafafb',
  panel: '#ffffff',
  sidebar: '#f1f2f4',
  soft: '#f0f1f4',
  hover: '#e6e9ef',
  selected: '#e5e8ed',
  text: '#20242c',
  muted: '#59616d',
  faint: '#646b76',
  line: '#d7dae0',
  softline: '#e8eaee',
  strong: '#acb3c0',
  primary: '#242931',
  primaryOn: '#ffffff',
  primaryHover: '#363d48',
  outgoing: '#e2e6eb',
  success: '#386048',
  successSoft: '#edf3ef',
  warning: '#765724',
  warningSoft: '#eee8da',
  danger: '#a14646',
  dangerSoft: '#f8eeee',
  scrim: '#171c2740',
  shadow: '#151c2818',
  contextSystem: '#697381',
  contextTools: '#817296',
  contextTurn: '#46766b',
  periodMorning: '#805b16',
  periodMorningSoft: '#fff1d5',
  periodAfternoon: '#176b84',
  periodAfternoonSoft: '#dff1f7',
  periodEvening: '#7c4c91',
  periodEveningSoft: '#f0e6f5',
  periodNight: '#505788',
  periodNightSoft: '#e8eafa',
};
const dark: typeof light = {
  background: '#1b1d22',
  panel: '#24272d',
  sidebar: '#16181d',
  soft: '#272c35',
  hover: '#2b303a',
  selected: '#2d333e',
  text: '#ebedf1',
  muted: '#b1b7c2',
  faint: '#a2aab7',
  line: '#3a3f4a',
  softline: '#2d313a',
  strong: '#727f94',
  primary: '#e4e9f1',
  primaryOn: '#1a1d24',
  primaryHover: '#cbd3df',
  outgoing: '#343c49',
  success: '#b8cdbf',
  successSoft: '#26392e',
  warning: '#e5c991',
  warningSoft: '#3c3428',
  danger: '#f0b0b0',
  dangerSoft: '#3d292d',
  scrim: '#00000080',
  shadow: '#00000055',
  contextSystem: '#a2aab7',
  contextTools: '#baa9d0',
  contextTurn: '#a1c6b8',
  periodMorning: '#efd19b',
  periodMorningSoft: '#3b3224',
  periodAfternoon: '#a0d2e3',
  periodAfternoonSoft: '#233540',
  periodEvening: '#d1b5e3',
  periodEveningSoft: '#352b40',
  periodNight: '#bac1ed',
  periodNightSoft: '#2d3045',
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (channels: number[]) =>
  '#' + channels.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function luminance(color: string) {
  const c = rgb(color)
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
export function colorContrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function readableAccent(color: string, surfaces: string[], mode: AppearanceMode) {
  let value = color;
  const target = mode === 'dark' ? 255 : 0;
  for (let n = 0; n < 100 && surfaces.some((bg) => colorContrast(value, bg) < 4.55); n++)
    value = hex(rgb(value).map((v) => v * 0.94 + target * 0.06));
  return value;
}

/** The same versioned visual tokens are consumed by the workbench and sandboxed pages.
 * No role, library, credential, or authority information belongs in this snapshot. */
export function appearanceSnapshot(
  preferences: Partial<Preferences> = {},
  systemDark = false,
): AppearanceSnapshot {
  const mode =
    preferences.theme === 'dark' || (preferences.theme !== 'light' && systemDark)
      ? 'dark'
      : 'light';
  const p = mode === 'dark' ? dark : light;
  const color = /^#[0-9a-f]{6}$/i.test(preferences.accent ?? '')
    ? preferences.accent!
    : defaultAccent;
  const accent = readableAccent(
    color,
    [p.background, p.panel, p.soft, p.selected, p.outgoing],
    mode,
  );
  const uiFont = Math.min(16, Math.max(14, preferences.uiFontSize ?? 14));
  const tokens: Record<string, string> = {
    '--background': p.background,
    '--panel': p.panel,
    '--surface': p.panel,
    '--card': p.panel,
    '--sidebar': p.sidebar,
    '--surface-soft': p.soft,
    '--hover': p.hover,
    '--selected': p.selected,
    '--text': p.text,
    '--muted': p.muted,
    '--faint': p.faint,
    '--line': p.line,
    '--border': p.line,
    '--line-soft': p.softline,
    '--line-strong': p.strong,
    '--primary': p.primary,
    '--primary-on': p.primaryOn,
    '--primary-hover': p.primaryHover,
    '--outgoing': p.outgoing,
    '--accent': accent,
    '--accent-text': accent,
    '--accent-soft': p.selected,
    '--accent-line': p.strong,
    '--accent-on': colorContrast(color, '#ffffff') >= 4.5 ? '#ffffff' : '#20283a',
    '--accent-hover': accent,
    '--focus-ring': p.text + '18',
    '--focus': p.text,
    '--success': p.success,
    '--success-soft': p.successSoft,
    '--warning': p.warning,
    '--warning-soft': p.warningSoft,
    '--danger': p.danger,
    '--danger-soft': p.dangerSoft,
    '--scrim': p.scrim,
    '--shadow': p.shadow,
    '--context-system': p.contextSystem,
    '--context-tools': p.contextTools,
    '--context-turn': p.contextTurn,
    '--period-morning': p.periodMorning,
    '--period-morning-soft': p.periodMorningSoft,
    '--period-afternoon': p.periodAfternoon,
    '--period-afternoon-soft': p.periodAfternoonSoft,
    '--period-evening': p.periodEvening,
    '--period-evening-soft': p.periodEveningSoft,
    '--period-night': p.periodNight,
    '--period-night-soft': p.periodNightSoft,
    '--font-body': uiFont + 'px',
    '--font-caption': uiFont - 2 + 'px',
    '--font-reading': uiFont + 1 + 'px',
    '--font-section': uiFont + 2 + 'px',
    '--font-dialog-title': uiFont + 4 + 'px',
    '--font-page-title': uiFont + 8 + 'px',
    '--chat-font-size':
      Math.min(18, Math.max(14, preferences.chatFontSize ?? Math.max(15, uiFont))) + 'px',
    '--radius-control': '5px',
    '--radius-panel': '8px',
    '--sample-light': light.background,
    '--sample-light-sidebar': light.sidebar,
    '--sample-dark': dark.panel,
    '--sample-dark-sidebar': dark.sidebar,
    '--sample-line': '#c4cad4',
  };
  if (preferences.highContrast) tokens['--line'] = tokens['--border'] = p.strong;
  return { version: 1, mode, reducedMotion: preferences.reducedMotion === true, tokens };
}

/** Small opt-in vocabulary for extension authors. Layout stays owned by the extension. */
export const extensionBaseStyles = `
:root{font-family:"Segoe UI Variable","Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei UI",sans-serif;font-size:var(--font-body);font-synthesis:none;color:var(--text);background:var(--background)}
*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit;color:inherit}
button,.echo-button{border:1px solid var(--line);border-radius:var(--radius-control);background:var(--panel);color:var(--text);padding:7px 11px;cursor:pointer}
button:hover,.echo-button:hover{background:var(--hover)}button:disabled{opacity:.5;cursor:default}
button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
input,textarea,select{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-control);padding:8px 10px;max-width:100%}
input[type=checkbox],input[type=radio]{accent-color:var(--primary)}a{color:var(--accent-text);text-underline-offset:3px}
.echo-primary{background:var(--primary);color:var(--primary-on);border-color:transparent}.echo-primary:hover{background:var(--primary-hover)}
.echo-panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-panel);padding:20px}
.echo-muted{color:var(--muted)}.echo-selected{background:var(--selected);color:var(--text);box-shadow:inset 2px 0 var(--text)}
[data-echo-reduced-motion=true] *,[data-echo-reduced-motion=true] *::before,[data-echo-reduced-motion=true] *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
[data-echo-theme-changing=true] *,[data-echo-theme-changing=true] *::before,[data-echo-theme-changing=true] *::after{transition:none!important}
`;
