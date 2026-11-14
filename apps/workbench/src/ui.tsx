import { t } from './i18n.ts';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  chat: (
    <>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3H12" />
      <path d="M8 10h7M8 14h5M17 3v6m-3-3h6" />
    </>
  ),
  personas: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  memory: (
    <>
      <path d="m12 3 9 9-9 9-9-9z" />
      <path d="m8 12 4 4 4-4-4-4z" />
    </>
  ),
  observation: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  knowledge: (
    <>
      <path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1v15" />
    </>
  ),
  files: <path d="M3 7V4h6l2 3h10v13H3V7Z" />,
  assets: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 17 6-6 4 4 3-3 5 5" />
    </>
  ),
  research: (
    <>
      <path d="M8 3h8M10 3v6L4 19a1.5 1.5 0 0 0 1.5 2h13a1.5 1.5 0 0 0 1.5-2L14 9V3M8 14h8" />
    </>
  ),
  review: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5 7a8 8 0 0 1 13-2l2 2M4 17l2 2a8 8 0 0 0 13-2" />
    </>
  ),
  avatar: (
    <>
      <path d="M7 4 4 8v8l3 4h10l3-4V8l-3-4-3 3h-4z" />
      <circle cx="9" cy="12" r=".5" />
      <circle cx="15" cy="12" r=".5" />
      <path d="M10 16h4" />
    </>
  ),
  backends: (
    <>
      <rect x="2" y="3" width="7" height="7" rx="2" />
      <rect x="15" y="14" width="7" height="7" rx="2" />
      <path d="M9 6h6a4 4 0 0 1 4 4v4M15 18H9a4 4 0 0 1-4-4v-4" />
    </>
  ),
  plugins: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 17.5h7m-3.5-3.5v7" />
    </>
  ),
  diagnostics: (
    <>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </>
  ),
  speed: <path d="M5 19a9 9 0 1 1 14 0M12 14l4-5M12 14h.01" />,
  tokens: <path d="M21 6c0 2.2-4 4-9 4S3 8.2 3 6s4-4 9-4 9 1.8 9 4ZM3 6v12c0 2.2 4 4 9 4s9-1.8 9-4V6M3 12c0 2.2 4 4 9 4s9-1.8 9-4" />,
  agenda: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4m10-4v4M3 11h18M8 15h2m4 0h2" />
    </>
  ),
  care: (
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 6 9 7 9-7" />
    </>
  ),
  scheduler: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  backup: (
    <>
      <path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6" />
    </>
  ),
  notifications: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </>
  ),
  approvals: (
    <>
      <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  channels: (
    <>
      <circle cx="5" cy="12" r="3" />
      <circle cx="19" cy="5" r="3" />
      <circle cx="19" cy="19" r="3" />
      <path d="m8 11 8-5M8 13l8 5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  reasoning: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" /><path d="M19 2v4m-2-2h4" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" fill="white" />
      <circle cx="15" cy="17" r="3" fill="white" />
    </>
  ),
};
export function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={'ui-icon ' + className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.plugins}
    </svg>
  );
}
const UiContext = createContext<{
  busy: boolean;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  guard: (key: symbol, label?: string) => void;
}>({ busy: false, confirm: async () => false, guard: () => {} });
type ConfirmOptions = {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
};
export const useConfirm = () => useContext(UiContext).confirm;
export function sameData(a: unknown, b: unknown): boolean {
  const sort = (value: any): any =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .filter((key) => value[key] !== undefined)
              .map((key) => [key, sort(value[key])]),
          )
        : value;
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b));
}
export function requestNavigation(action: () => void) {
  window.dispatchEvent(new CustomEvent('echo:navigate', { detail: action }));
}
export function useUnsavedChanges(dirty: boolean, label: string) {
  const { guard } = useContext(UiContext);
  const key = useRef(Symbol(label));
  useEffect(() => {
    guard(key.current, dirty ? label : undefined);
    return () => guard(key.current);
  }, [guard, dirty, label]);
}
export function UiProvider({ busy, children }: { busy: boolean; children: ReactNode }) {
  const [dialog, setDialog] = useState<ConfirmOptions>();
  const resolver = useRef<((value: boolean) => void) | undefined>(undefined);
  const element = useRef<HTMLDialogElement>(null);
  const guards = useRef(new Map<symbol, string>());
  const guard = useRef((key: symbol, label?: string) => {
    if (label) guards.current.set(key, label);
    else guards.current.delete(key);
    void (window as any).Echo?.host?.('dirty', { dirty: guards.current.size > 0 }).catch(() => {});
    if ('__TAURI_INTERNALS__' in window)
      void import('@tauri-apps/api/core').then(({ invoke }) => invoke('report_dirty', { dirty: guards.current.size > 0 })).catch(() => {});
  }).current;
  const finish = (answer: boolean) => {
    resolver.current?.(answer);
    resolver.current = undefined;
    setDialog(undefined);
  };
  const confirm = (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      setDialog(options);
    });
  useEffect(() => {
    if (dialog) element.current?.showModal();
  }, [dialog]);
  useEffect(() => () => resolver.current?.(false), []);
  useEffect(() => {
    const navigate = async (event: Event) => {
      const action = (event as CustomEvent<() => void>).detail;
      if (
        !guards.current.size ||
        (await confirm({
          title: t('离开前放弃修改？'),
          description: t('此页有尚未保存的修改。'),
          confirmLabel: t('放弃修改并离开'),
        }))
      )
        action();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (guards.current.size) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('echo:navigate', navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('echo:navigate', navigate);
      window.removeEventListener('beforeunload', unload);
    };
  }, []);
  return (
    <UiContext.Provider value={{ busy, confirm, guard }}>
      {children}
      {dialog && (
        <dialog
          ref={element}
          className="confirm-dialog"
          onCancel={() => finish(false)}
          onClick={(e) => {
            if (e.target === e.currentTarget) finish(false);
          }}
          aria-labelledby="confirm-title"
        >
          <div className={'dialog-mark ' + (dialog.danger ? 'danger' : '')}>
            <Icon name={dialog.danger ? 'trash' : 'approvals'} size={24} />
          </div>
          <h2 id="confirm-title">{dialog.title}</h2>
          <div className="dialog-description">{dialog.description}</div>
          <div className="dialog-actions">
            <button autoFocus className="secondary" onClick={() => finish(false)}>
              {t('取消')}
            </button>
            <button
              className={dialog.danger ? 'danger-button' : 'primary'}
              onClick={() => finish(true)}
            >
              {dialog.confirmLabel ?? t('确认')}
            </button>
          </div>
        </dialog>
      )}
    </UiContext.Provider>
  );
}
export function Button({
  children,
  onClick,
  secondary = false,
  danger = false,
  disabled = false,
  ...props
}: any) {
  const { busy } = useContext(UiContext);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={danger ? 'danger-button' : secondary ? 'secondary' : 'primary'}
      disabled={disabled || busy || pending}
      onClick={async (event) => {
        if (lock.current) return;
        lock.current = true;
        try {
          const result = onClick?.(event);
          if (result?.then) {
            setPending(true);
            await result;
          }
        } finally {
          lock.current = false;
          setPending(false);
        }
      }}
    >
      {pending && <span className="spinner" />}
      {children}
    </button>
  );
}
export function EmptyState({
  title,
  children,
  icon = 'files',
}: {
  title?: string;
  children?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Icon name={icon} size={25} />
      </div>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}
export function PathInput({
  value,
  onChange,
  directory = false,
  save = false,
  label,
  placeholder,
  ...props
}: any) {
  const [issue, setIssue] = useState('');
  const desktop = '__TAURI_INTERNALS__' in window || Boolean((window as any).Echo?.host);
  return (
    <div className="path-input-wrap">
      <div className="path-input">
        <input
          {...props}
          aria-label={label ?? props['aria-label']}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            placeholder ?? (directory ? t('选择或粘贴目录路径') : t('选择或粘贴文件路径'))
          }
        />
        {desktop && (
          <button
            type="button"
            className="secondary"
            aria-label={t('浏览') + (label ?? '')}
            onClick={async () => {
              try {
                const bridge = (window as any).Echo;
                const dialog = bridge ? undefined : await import('@tauri-apps/plugin-dialog');
                const path = bridge ? await bridge.host('pickPath', { label, value, save, directory }) : save
                  ? await dialog!.save({ title: label, defaultPath: value || undefined })
                  : await dialog!.open({
                      directory,
                      multiple: false,
                      title: label,
                      defaultPath: value || undefined,
                    });
                if (typeof path === 'string') {
                  onChange(path);
                  setIssue('');
                }
              } catch (e) {
                setIssue((e as Error).message);
              }
            }}
          >
            <Icon name="files" size={15} />
            {t('浏览')}
          </button>
        )}
      </div>
      {issue && (
        <small className="danger" role="alert">
          {issue}
        </small>
      )}
    </div>
  );
}
