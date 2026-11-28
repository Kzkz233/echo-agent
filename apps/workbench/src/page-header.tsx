import type { ReactNode, KeyboardEvent } from 'react';
import { Icon } from './ui.tsx';
import { t } from './i18n.ts';
import { BrandMark, BrandWordmark } from './brand.tsx';
import { WindowControls, nativeWindowChrome } from './window-chrome.tsx';

export type PageTab = { id: string; text: string; badge?: ReactNode };

/** Status changes use a reserved slot in every navigation scope. */
export function HeaderStatus({
  working,
  interactions,
  openPending,
}: {
  working: boolean;
  interactions: number;
  openPending: () => void;
}) {
  return (
    <span className="header-status-slot">
      {interactions > 0 ? (
        <button
          className="icon-button"
          onClick={openPending}
          title={t('待确认') + ' · ' + interactions}
          aria-label={t('待确认') + ' · ' + interactions}
        >
          <Icon name="approvals" size={17} />
          <span className="unread-dot" aria-hidden="true" />
        </button>
      ) : working ? (
        <span role="status" aria-label={t('正在处理')}>
          <span className="spinner" />
        </span>
      ) : null}
    </span>
  );
}
export function RoleHeaderActions({ configure }: { configure: () => void }) {
  return (
    <>
      <button
        className="icon-button"
        title={t('配置伙伴')}
        aria-label={t('配置伙伴')}
        onClick={configure}
      >
        <Icon name="settings" size={17} />
      </button>
    </>
  );
}

/** Parent navigation owns its geometry; selecting a child only changes its state. */
export function PageTabs({
  items,
  selected,
  label,
  onSelect,
  prefix = 'sheet',
  controls,
}: {
  items: PageTab[];
  selected: string;
  label: string;
  onSelect: (id: string) => void;
  prefix?: string;
  controls?: string;
}) {
  const keyDown = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(
      0,
      items.findIndex((item) => item.id === selected),
    );
    const next =
      items[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length
      ];
    if (!next) return;
    onSelect(next.id);
    requestAnimationFrame(() => document.getElementById(prefix + '-' + next.id)?.focus());
  };
  return (
    <div className="page-sheets" role="tablist" aria-label={t(label)} onKeyDown={keyDown}>
      {items.map((item) => (
        <button
          key={item.id}
          id={prefix + '-' + item.id}
          data-view={item.id}
          role="tab"
          tabIndex={selected === item.id ? 0 : -1}
          aria-selected={selected === item.id}
          aria-controls={controls ?? 'view-' + item.id}
          onClick={() => onSelect(item.id)}
        >
          <span className="tab-label" data-label={t(item.text)}>
            <span>{t(item.text)}</span>
          </span>
          {item.badge}
        </button>
      ))}
    </div>
  );
}

/** This header stays outside the child outlet and contains no child page title. */
export function PageHeader({
  scope,
  title,
  role = false,
  tabs,
  actions,
  brand = false,
  status,
}: {
  scope: string;
  title: string;
  role?: boolean;
  tabs?: ReactNode;
  actions: ReactNode;
  brand?: boolean;
  status?: ReactNode;
}) {
  return (
    <header
      className={'topbar' + (role ? ' role-topbar' : '')}
      data-tauri-drag-region={nativeWindowChrome ? 'deep' : undefined}
    >
      {brand && nativeWindowChrome && (
        <div className="window-brand">
          <BrandMark />
          <BrandWordmark />
        </div>
      )}
      <div className="header-identity">
        <span className="breadcrumb">{t(scope)}</span>
        <Icon name="chevron" size={13} />
        <strong title={t(title)}>{t(title)}</strong>
        {status}
      </div>
      {tabs}
      <div className="topbar-actions">{actions}</div>
      <WindowControls />
    </header>
  );
}
