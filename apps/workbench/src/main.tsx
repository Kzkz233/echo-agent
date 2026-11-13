import { StarterCharacters } from './starter-characters.tsx';
import { CharacterPortrait } from './character-portrait.tsx';
import { inferenceTasks } from '../../../packages/contracts/inference.ts';
import { CharacterLibrary } from './character-library.tsx';
import { ReviewResume } from './review-resume.tsx';
import { StorageSettings, PluginPackageInstaller } from './core-settings.tsx';
import { UpdatesView, confirmDesktopReady } from './updates-view.tsx';
import { type ObservationConfig } from '../../../packages/contracts/index.ts';
import { statusText } from './i18n.ts';
import { locale } from './i18n.ts';
import { t } from './i18n.ts';
import {
  Fragment,
  useState,
  useEffect,
  useCallback,
  useRef,
  createContext,
  useContext,
  lazy,
  Suspense,
} from 'react';
import { createRoot } from 'react-dom/client';
import { connect, setConnection, rpc, events } from './client.ts';
import { type Persona, type Memory } from '../../../packages/contracts/index.ts';
import type { Field } from '../../../packages/kernel/registry.ts';
import './style.css';
import {
  Button,
  Icon,
  EmptyState,
  PathInput,
  UiProvider,
  useConfirm,
  useUnsavedChanges,
  requestNavigation,
  sameData,
} from './ui.tsx';
import { AutomationView } from './automation-view.tsx';
import { ChatView } from './chat-view.tsx';
import { CharacterWizard } from './character-wizard.tsx';
import { CharacterHome, GroupView } from './character-workspace.tsx';
import { TaskWorkspace } from './task-workspace.tsx';
import { ModelChoice } from './model-choice.tsx';
import { PluginInferenceRoutes } from './plugin-inference-routes.tsx';
import { ExternalMcpView } from './external-mcp-view.tsx';
import './character-style.css';
import { Appearance } from './appearance.tsx';
import {
  navigationSections,
  coreViews,
  viewSection as findViewSection,
  workspaceSections as baseWorkspaceSections,
  settingsSections as baseSettingsSections,
  isSettingsPage as settingsPage,
  isWorkspacePage as workspacePage,
} from './navigation.ts';
import { usePreferences, applySavedPreferences } from './i18n.ts';

const ArchiveView = lazy(() =>
  import('./archive-view.tsx').then((m) => ({ default: m.ArchiveView })),
);
const ReflectionsView = lazy(() =>
  import('./persona-state-view.tsx').then((m) => ({ default: m.ReflectionsView })),
);
const FeaturePage = lazy(() =>
  import('./feature-views.tsx').then((m) => ({ default: m.FeaturePage })),
);
const AgendaCalendar = lazy(() =>
  import('./agenda-views.tsx').then((m) => ({ default: m.AgendaCalendar })),
);
const KnowledgeView = lazy(() =>
  import('./knowledge-view.tsx').then((m) => ({ default: m.KnowledgeView })),
);
const ChatStickView = lazy(() =>
  import('./chatstick-view.tsx').then((m) => ({ default: m.ChatStickView })),
);
const BackendsView = lazy(() => import('./backends-view.tsx'));
const DocumentProcessing = lazy(() => import('./document-processing.tsx'));
const PluginPage = lazy(() =>
  import('./plugin-page.tsx').then((module) => ({ default: module.PluginPage })),
);
const Context = createContext<any>(null);
const useApp = () => useContext(Context);
const navigationGroups = [...new Set(navigationSections().map((section) => section.group))];
const navigationHints: Record<string, string> = {
  chat: '对话 聊天',
  personas: '人格 角色',
  memory: '记忆 召回',
  observation: '观察 视觉',
  avatar: '桌宠 气泡',
  care: '主动 交流',
  knowledge: '知识库',
  files: '文件',
  assets: '素材',
  reflections: '在意 关心 话题',
  agenda: '日历 日程',
  mail: '邮件',
  approvals: '审批',
  notifications: '通知',
  backends: '后端 推理 路由 模型',
  review: '整理',
  scheduler: '调度 定时任务',
  channels: '通道 QQ',
  backup: '备份 恢复',
  plugins: '插件 设置',
  diagnostics: '诊断 日志 MCP',
};
function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: any;
  onChange: (v: any) => void;
}) {
  const app = useApp();
  const [expandedRow, setExpandedRow] = useState<number>();
  if (field.type === 'records') {
    const rows = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
    const update = (index: number, next: Record<string, unknown>) =>
      onChange(rows.map((row, i) => i === index ? next : row));
    const move = (index: number, offset: number) => {
      const next = [...rows];
      const target = index + offset;
      [next[index], next[target]] = [next[target], next[index]];
      if (expandedRow === index) setExpandedRow(target);
      else if (expandedRow === target) setExpandedRow(index);
      onChange(next);
    };
    const remove = (index: number) => {
      if (expandedRow === index) setExpandedRow(undefined);
      else if (expandedRow !== undefined && expandedRow > index) setExpandedRow(expandedRow - 1);
      onChange(rows.filter((_row, i) => i !== index));
    };
    return (
      <fieldset className="field">
        <legend>{t(field.label)}</legend>
        {field.description && <p className="muted">{t(field.description)}</p>}
        {rows.map((row, index) => {
          const fields = (
            <>
              {(field.rowFields ?? []).map((child) => (
                <FieldInput
                  key={child.key}
                  field={child}
                  value={row[child.key]}
                  onChange={(next) => update(index, { ...row, [child.key]: next })}
                />
              ))}
              <div className="row wrap">
                <Button secondary disabled={index === 0} onClick={() => move(index, -1)}>
                  {t('上移')}
                </Button>
                <Button secondary disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
                  {t('下移')}
                </Button>
                <Button secondary onClick={() => remove(index)}>
                  {t(field.removeLabel ?? '移除')}
                </Button>
              </div>
            </>
          );
          if (!field.rowTitleKey) return <div className="card" key={index}>{fields}</div>;
          const title = String(row[field.rowTitleKey] ?? '').trim();
          return (
            <details className="card record-settings-row" key={index} open={expandedRow === index}>
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  setExpandedRow(expandedRow === index ? undefined : index);
                }}
              >
                {title || t('未命名规则')}
              </summary>
              <div className="record-settings-fields">{fields}</div>
            </details>
          );
        })}
        <Button
          secondary
          disabled={rows.length >= 100}
          onClick={() => {
            if (field.rowTitleKey) setExpandedRow(rows.length);
            onChange([...rows, { ...field.defaults }]);
          }}
        >
          {t(field.addLabel ?? '添加')}
        </Button>
      </fieldset>
    );
  }
  if (field.resource === 'executor' || field.resource === 'model')
    return (
      <ModelChoice
        data={app.data}
        label={field.label}
        value={value}
        executor={field.resource === 'executor'}
        taskId={field.inferenceTask}
        backendKinds={field.backendKinds}
        inheritLabel="未选择"
        onChange={onChange}
      />
    );
  const resources = field.resource
    ? ((
        {
          conversation: app?.data.conversations,
          persona: app?.data.personas,
          vault: app?.data.vaults,
        } as any
      )[field.resource] ?? [])
    : [];
  return (
    <label className={field.type === 'boolean' ? 'toggle-field' : 'field'}>
      <span>{t(field.label)}</span>
      {field.resource ? (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('未选择')}</option>
          {resources.map((r: any) => (
            <option value={r.id} key={r.id}>
              {r.title ?? r.name}
            </option>
          ))}
          {value && !resources.some((r: any) => r.id === value) && (
            <option value={value}>{t('目标暂不可用')}</option>
          )}
        </select>
      ) : field.type === 'boolean' ? (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : field.type === 'path' ? (
        <PathInput
          label={t(field.label)}
          value={value}
          onChange={onChange}
          directory={field.pathMode === 'directory'}
          save={field.pathMode === 'save'}
        />
      ) : field.type === 'textarea' ? (
        <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={5} />
      ) : field.type === 'select' ? (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {t(
                (
                  field.optionLabels?.[o] ?? ({
                    reasoning: {
                      inherit: '跟随后端默认',
                      off: '关闭思考',
                      minimal: '极低',
                      low: '低',
                      medium: '中',
                      high: '高',
                      xhigh: '极高',
                    },
                    reasoningStyle: { none: '不附加参数' },
                    kind: { api: '模型 API', pi: '模型 API' },
                    strategy: { keyword: '关键词', semantic: '语义', hybrid: '混合检索' },
                    mode: {
                      local: '本地模型',
                      api: '在线 / 本机 API',
                      keyword: '关键词',
                      daily: '每日',
                      turns: '按轮数',
                      both: '两者结合',
                    },
                    corner: { left: '左下角', right: '右下角' },
                  } as any)[field.key]?.[o] ?? o
                ),
              )}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          step="any"
          min={field.min}
          max={field.max}
          value={value ?? ''}
          onChange={(e) =>
            onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)
          }
        />
      )}
      {field.description && <small>{t(field.description)}</small>}
    </label>
  );
}
function App() {
  usePreferences();
  const settingsWindow = new URLSearchParams(location.search).get('window') === 'settings';
  const extensionWindow = new URLSearchParams(location.search).get('window') === 'extension';
  const [data, setData] = useState<any>(),
    [workspaceScope, setWorkspaceScope] = useState(() =>
      workspacePage(new URLSearchParams(location.search).get('page') ?? 'character'),
    ),
    [page, setPage] = useState(
      () =>
        new URLSearchParams(location.search).get('page') ??
        (settingsWindow ? 'plugins' : 'character'),
    ),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [connection, changeConnection] = useState({ url: 'http://127.0.0.1:0', token: '' }),
    [pending, setPending] = useState(0),
    [connected, setConnected] = useState(false),
    [connectionRevision, setConnectionRevision] = useState(0),
    [roleSelection, setRoleSelection] = useState(
      () =>
        new URLSearchParams(location.search).get('persona') ??
        sessionStorage.getItem('echo.role') ??
        '',
    ),
    [newRole, setNewRole] = useState<Persona>(),
    [taskRevision, setTaskRevision] = useState(0),
    [groupSelection, setGroupSelection] = useState(''),
    [wizardRole, setWizardRole] = useState<string | undefined>(),
    [wizardTaskId, setWizardTaskId] = useState<string | undefined>(),
    [wizardStep, setWizardStep] = useState(0),
    [navSearch, setNavSearch] = useState(''),
    [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const initialLanding = useRef(false);
  useEffect(() => {
    if (!data || initialLanding.current) return;
    initialLanding.current = true;
    const params = new URLSearchParams(location.search);
    if (!settingsWindow && !params.has('page') && !params.has('persona') && !sessionStorage.getItem('echo.role') && !data.characters?.length) setPage('personas');
  }, [data]);
  const pages = data?.frontend?.pages ?? [];
  const extensionPage = pages.find((entry: any) => entry.id === page);
  useEffect(() => {
    if (extensionPage) setWorkspaceScope(extensionPage.placement !== 'character');
  }, [extensionPage?.id, extensionPage?.placement]);
  const sections = navigationSections(pages);
  const viewSection = (id: string) => findViewSection(id, pages);
  const isSettingsPage = (id: string) => settingsPage(id, pages);
  const isWorkspacePage = (id: string) => workspacePage(id, pages);
  const workspaceSections = new Set([
    ...baseWorkspaceSections,
    ...sections
      .filter((section) =>
        section.views.some((view) =>
          pages.some((entry: any) => entry.id === view.id && entry.placement === 'workspace'),
        ),
      )
      .map((section) => section.id),
  ]);
  const settingsSections = new Set([
    ...baseSettingsSections,
    ...sections
      .filter((section) =>
        section.views.some((view) =>
          pages.some((entry: any) => entry.id === view.id && entry.placement === 'settings'),
        ),
      )
      .map((section) => section.id),
  ]);
  const role: Persona | undefined =
    newRole ?? data?.personas.find((p: Persona) => p.id === roleSelection) ?? data?.personas[0];
  const roleSection =
    !settingsWindow &&
    !(extensionPage ? extensionPage.placement !== 'character' : workspaceScope) &&
    !['groups', 'character-wizard', 'chat', 'personas'].includes(page);
  const popoutPlugin = async () => {
    if (!extensionPage) return;
    const personaId = extensionPage.placement === 'character' ? role?.id : undefined;
    if ('__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_extension_window', { page, personaId });
    } else
      window.open(
        connection.url +
          '/?window=extension&page=' +
          encodeURIComponent(page) +
          (personaId ? '&persona=' + encodeURIComponent(personaId) : '') +
          '#token=' +
          encodeURIComponent(connection.token),
        'echo-extension-' + page + '-' + (personaId ?? ''),
      );
  };
  const openRole = (selected?: Persona) =>
    requestNavigation(() => {
      setWorkspaceScope(false);
      if (!selected) {
        setWizardRole(undefined);
        setWizardTaskId(undefined);
        setWizardStep(0);
        setPage('character-wizard');
        return;
      }
      setRoleSelection(selected.id);
      sessionStorage.setItem('echo.role', selected.id);
      setPage('character');
    });
  const editRole = (selected?: Persona, step = 0, taskId?: string) =>
    requestNavigation(() => {
      setWorkspaceScope(false);
      setWizardRole(selected?.id);
      setWizardTaskId(taskId);
      setWizardStep(step);
      setPage('character-wizard');
    });
  const openSettings = async (target = 'plugins', pluginId?: string) => {
    try {
      localStorage.setItem(
        'echo.settings-navigation',
        JSON.stringify({ page: target, pluginId, at: Date.now() }),
      );
      if (!isSettingsPage(target)) {
        await openWorkbench(target);
        return;
      }
      if ('__TAURI_INTERNALS__' in window) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_settings', { page: target });
      } else {
        window.open(
          connection.url +
            '/?window=settings&page=' +
            encodeURIComponent(target) +
            '#token=' +
            encodeURIComponent(connection.token),
          'echo-settings',
        );
      }
    } catch (cause) {
      setError(
        t('无法打开设置窗口：{reason}', {
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  };
  const openWorkbench = async (target: string, detail: Record<string, unknown> = {}) => {
    if (!settingsWindow) {
      goPage(target, detail.pluginId as string, detail.selection as any, detail.task as any, {
        workspace: isWorkspacePage(target),
        roleId: detail.roleId as string,
        conversationId: detail.conversationId as string,
      });
      return;
    }
    localStorage.setItem(
      'echo.workbench-navigation',
      JSON.stringify({ page: target, ...detail, at: Date.now() }),
    );
    if ('__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_workbench');
    } else if (window.opener && !window.opener.closed) window.opener.focus();
    else
      window.open(
        connection.url + '/#token=' + encodeURIComponent(connection.token),
        'echo-workbench',
      );
  };
  const savedRole = (selected: Persona) => {
    setRoleSelection(selected.id);
    sessionStorage.setItem('echo.role', selected.id);
    setNewRole(undefined);
  };
  const navSearchInput = useRef<HTMLInputElement>(null);
  const goPage = (
    target: string,
    pluginId?: string,
    selection?: { documentId?: string; vaultId?: string; collectionId?: string },
    task?: { type: string; id: string; mode?: 'status' | 'edit' },
    context?: { workspace?: boolean; roleId?: string; conversationId?: string },
  ) => {
    if (!extensionWindow && settingsWindow && !isSettingsPage(target)) {
      void openWorkbench(target, { pluginId, selection, task });
      return;
    }
    if (!extensionWindow && !settingsWindow && isSettingsPage(target)) {
      void openSettings(target, pluginId);
      return;
    }
    if (target === page && !pluginId && !selection && !task && !context) return;
    requestNavigation(() => {
      if (context?.workspace !== undefined) setWorkspaceScope(context.workspace);
      else if (!isWorkspacePage(target)) setWorkspaceScope(false);
      if (context?.roleId) {
        setRoleSelection(context.roleId);
        setWorkspaceScope(false);
      }
      if (context?.conversationId) sessionStorage.setItem('echo.chat', context.conversationId);
      if (pluginId) sessionStorage.setItem('echo.plugin', pluginId);
      if (selection) sessionStorage.setItem('echo.knowledge.open', JSON.stringify(selection));
      if (task) {
        sessionStorage.setItem('echo.automation.open', JSON.stringify(task));
        setTaskRevision((r) => r + 1);
      }
      if (target === 'personas') setNewRole(undefined);
      setPage(target);
      if (target === page)
        window.dispatchEvent(
          new CustomEvent('echo:selection', { detail: { pluginId, selection } }),
        );
    });
  };
  const openTask = (target: string, type: string, id: string, mode: 'status' | 'edit' = 'edit') =>
    goPage(target, undefined, undefined, { type, id, mode });
  useEffect(() => {
    if (!connected) return;
    if (settingsWindow) {
      const receiveSettings = () => {
        const raw = localStorage.getItem('echo.settings-navigation');
        if (!raw) return;
        localStorage.removeItem('echo.settings-navigation');
        try {
          const next = JSON.parse(raw);
          if (Date.now() - next.at > 60000 || !isSettingsPage(next.page)) return;
          requestNavigation(() => {
            if (next.pluginId) sessionStorage.setItem('echo.plugin', next.pluginId);
            setPage(next.page);
            window.dispatchEvent(new Event('echo:selection'));
          });
        } catch {}
      };
      receiveSettings();
      const settingsStorage = (event: StorageEvent) => {
        if (event.key === 'echo.settings-navigation') receiveSettings();
      };
      window.addEventListener('storage', settingsStorage);
      if (!isSettingsPage(page)) {
        void openWorkbench(page);
        setPage('plugins');
      }
      return () => window.removeEventListener('storage', settingsStorage);
    }
    const receive = () => {
      const raw = localStorage.getItem('echo.workbench-navigation');
      if (!raw) return;
      localStorage.removeItem('echo.workbench-navigation');
      try {
        const next = JSON.parse(raw);
        if (Date.now() - next.at > 60000) return;
        goPage(next.page, next.pluginId, next.selection, next.task, {
          workspace: isWorkspacePage(next.page),
          roleId: next.roleId,
          conversationId: next.conversationId,
        });
      } catch {}
    };
    receive();
    const storage = (event: StorageEvent) => {
      if (event.key === 'echo.workbench-navigation') receive();
    };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, [settingsWindow, page, connected]);
  useEffect(() => {
    const handler = (event: Event) => goPage((event as CustomEvent).detail);
    window.addEventListener('echo:settings-page', handler);
    return () => window.removeEventListener('echo:settings-page', handler);
  }, [page]);
  const refreshRevision = useRef(0);
  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    const result = await rpc('system.bootstrap');
    if (revision === refreshRevision.current) setData(result);
  }, []);
  const act = useCallback(
    async (fn: () => Promise<any>, message = '已保存') => {
      try {
        setPending((n) => n + 1);
        setError('');
        const result = await fn();
        await refresh().catch(() => setError(t('操作已完成，但页面刷新失败。请刷新后查看结果。')));
        setNotice(message);
        return result ?? true;
      } catch (e) {
        setError(e instanceof Error ? e.message : t('操作失败。'));
      } finally {
        setPending((n) => Math.max(0, n - 1));
      }
    },
    [refresh],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    connect()
      .then((c) => {
        changeConnection(c);
        return refresh().then(() => setConnected(true));
      })
      .then(() => confirmDesktopReady())
      .then(() =>
        events((event) => {
          if (event.type === 'connection.ready') setConnected(true);
          if (event.type === 'connection.issue') setConnected(false);
          if (event.type === 'request.failed') setError(event.data.message);
          if (
            [
              'run.completed',
              'characters.updated',
              'personas.updated',
              'groups.updated',
              'delegation.updated',
              'work.updated',
              'interaction.changed',
              'review.updated',
              'settings.changed',
              'observation.tasks.changed',
              'automation.changed',
              'files.roots.changed',
              'plugins.changed',
              'inference.changed',
              'frontend.changed',
              'externalMcp.changed',
              'connections.changed',
              'models.changed',
              'routes.changed',
              'binding.changed',
              'connection.ready',
              'message.posted',
              'conversation.created',
              'conversation.updated',
              'conversation.deleted',
              'preferences.changed',
            ].includes(event.type)
          ) {
            clearTimeout(timer);
            timer = setTimeout(() => void refresh().catch(() => {}), 100);
          }
          window.dispatchEvent(new CustomEvent('echo-event', { detail: event }));
        }, controller.signal),
      )
      .catch((e) => {
        setConnected(false);
        setError(e.message);
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh, connectionRevision]);
  useEffect(() => {
    sessionStorage.setItem('echo.page', page);
    const section = viewSection(page);
    if (section) sessionStorage.setItem('echo.sheet.' + section.id, page);
  }, [page]);
  useEffect(() => {
    if (data?.preferences) applySavedPreferences(data.preferences);
  }, [data?.preferences]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        navSearchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (
      data &&
      !extensionWindow &&
      !coreViews.has(page) &&
      !pages.some((entry: any) => entry.id === page) &&
      !data.plugins.some((p: any) => p.enabled && p.views?.includes(page))
    )
      setPage(
        viewSection(page)?.views.find(
          (v) =>
            coreViews.has(v.id) ||
            data.plugins.some((p: any) => p.enabled && p.views?.includes(v.id)),
        )?.id ?? 'plugins',
      );
  }, [data, page]);
  if (!data)
    return (
      <div className="connect-page">
        <div className="brand-mark">{t('e')}</div>
        <h1>Echo</h1>
        <p>{t('你的上下文，自己的节奏。')}</p>
        {error && <div className="error">{error}</div>}
        <div className="card">
          <h2>{t('连接本机 Echo')}</h2>
          <label className="field">
            {' '}
            {t('本机地址')}{' '}
            <input
              value={connection.url}
              onChange={(e) => changeConnection({ ...connection, url: e.target.value })}
            />
          </label>
          <label className="field">
            {' '}
            {t('连接令牌')}{' '}
            <input
              type="password"
              value={connection.token}
              onChange={(e) => changeConnection({ ...connection, token: e.target.value })}
            />
          </label>
          <Button
            onClick={() => {
              setConnection(connection);
              setConnectionRevision((n) => n + 1);
            }}
          >
            {' '}
            {t('连接')}{' '}
          </Button>
          <p className="muted">{t('桌面客户端会自动连接。命令行用户可运行启动器打开浏览器。')}</p>
        </div>
      </div>
    );
  const enabled = new Set([
    ...data.plugins.filter((p: any) => p.enabled).flatMap((p: any) => p.views ?? []),
    ...pages.map((entry: any) => entry.id),
  ]);
  return (
    <UiProvider busy={pending > 0}>
      <Context.Provider
        value={{
          data,
          refresh,
          act,
          setPage: goPage,
          openTask,
          role: workspaceScope || settingsWindow ? undefined : role,
          savedRole,
          openSettings,
          editRole,
        }}
      >
        <div className={'workbench' + (extensionWindow ? ' extension-window' : '')}>
          <aside className="sidebar">
            <div className="wordmark">
              <span className="brand-mark">{t('e')}</span>
              <strong>Echo</strong>
              <span className="version">{data.version}</span>
            </div>
            {settingsWindow && (
              <div className="nav-search">
                <Icon name="search" size={16} />
                <input
                  ref={navSearchInput}
                  aria-label={t('查找页面')}
                  placeholder={t('查找功能…')}
                  value={navSearch}
                  onChange={(e) => setNavSearch(e.target.value)}
                />
                <kbd>{t('⌃ K')}</kbd>
              </div>
            )}
            {settingsWindow ? (
              <nav aria-label={t('主导航')}>
                {navigationGroups.map((group) => {
                  const entries = sections
                    .filter(
                      (section) => section.group === group && settingsSections.has(section.id),
                    )
                    .map((section) => {
                      const views = section.views.filter(
                        (v) => isSettingsPage(v.id) && (coreViews.has(v.id) || enabled.has(v.id)),
                      );
                      const query = navSearch.toLowerCase();
                      const matches = views.filter((v) =>
                        (t(v.text) + ' ' + v.text + ' ' + navigationHints[v.id])
                          .toLowerCase()
                          .includes(query),
                      );
                      const rootMatch = (t(section.text) + ' ' + section.text)
                        .toLowerCase()
                        .includes(query);
                      return {
                        ...section,
                        views,
                        target: navSearch ? matches[0]?.id : undefined,
                        visible:
                          views.length > 0 && (!navSearch || rootMatch || matches.length > 0),
                      };
                    })
                    .filter((section) => section.visible);
                  if (!entries.length) return null;
                  const closed = collapsed[group] && !navSearch;
                  return (
                    <div className="nav-group" key={group}>
                      <button
                        className="nav-group-label"
                        aria-expanded={!closed}
                        onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
                      >
                        {t(group)}
                        <Icon name="chevron" size={12} className={closed ? '' : 'expanded'} />
                      </button>
                      {!closed &&
                        entries.map((section) => {
                          const active = section.views.some((v) => v.id === page),
                            remembered = sessionStorage.getItem('echo.sheet.' + section.id);
                          const target =
                            section.id === 'personas' && enabled.has('personas')
                              ? 'personas'
                              : section.id === 'automation' && !navSearch
                                ? 'automation'
                                : (section.target ??
                                  (active
                                    ? page
                                    : (section.views.find((v) => v.id === remembered)?.id ??
                                      section.views[0].id)));
                          return (
                            <button
                              key={section.id}
                              data-section={section.id}
                              aria-label={t(section.text)}
                              title={t(section.text)}
                              aria-current={active ? 'page' : undefined}
                              className={active ? 'nav-item selected' : 'nav-item'}
                              onClick={() => {
                                goPage(target);
                                setNavSearch('');
                              }}
                            >
                              <Icon name={section.icon} />
                              <span className="nav-label">{t(section.text)}</span>
                              {active && <span className="nav-active-dot" />}
                            </button>
                          );
                        })}
                    </div>
                  );
                })}
              </nav>
            ) : (
              <nav aria-label={t('角色与群聊')} className="character-navigation">
                <div className="nav-group-label">
                  <button className="text-button" onClick={() => goPage('personas')}>{t('角色')}</button>
                  <button
                    className="icon-button"
                    aria-label={t('创建角色')}
                    onClick={() => editRole()}
                  >
                    <Icon name="plus" size={16} />
                  </button>
                </div>
                {data.personas.map((persona: Persona) => (
                  <button
                    key={persona.id}
                    className={
                      'nav-item ' +
                      (!workspaceScope && role?.id === persona.id && page !== 'groups'
                        ? 'selected'
                        : '')
                    }
                    onClick={() => openRole(persona)}
                  >
                    <CharacterPortrait className="role-initial" persona={persona} />
                    <span>{persona.name}</span>
                    {data.characterActivities?.[persona.id]?.enabled === false && <small>{t('已停用')}</small>}
                  </button>
                ))}
                {enabled.has('groups') && (
                  <>
                    <div className="nav-group-label">
                      <span>{t('群聊')}</span>
                      <button
                        className="icon-button"
                        aria-label={t('创建群聊')}
                        onClick={() => {
                          setWorkspaceScope(false);
                          setGroupSelection('');
                          setPage('groups');
                        }}
                      >
                        <Icon name="plus" size={16} />
                      </button>
                    </div>
                    {(data.groups ?? []).map((group: any) => (
                      <button
                        key={group.id}
                        className={
                          'nav-item ' +
                          (page === 'groups' && groupSelection === group.id ? 'selected' : '')
                        }
                        onClick={() => {
                          setWorkspaceScope(false);
                          setGroupSelection(group.id);
                          setPage('groups');
                        }}
                      >
                        <Icon name="chat" />
                        {group.name}
                      </button>
                    ))}
                  </>
                )}
                <div className="nav-group-label">
                  <span>{t('工作台')}</span>
                </div>
                {sections
                  .filter((section) => workspaceSections.has(section.id))
                  .map((section) => {
                    const views = section.views.filter(
                      (view) => coreViews.has(view.id) || enabled.has(view.id),
                    );
                    if (!views.length) return null;
                    const active = workspaceScope && views.some((view) => view.id === page);
                    return (
                      <button
                        key={section.id}
                        data-section={section.id}
                        className={'nav-item ' + (active ? 'selected' : '')}
                        onClick={() =>
                          goPage(views[0].id, undefined, undefined, undefined, { workspace: true })
                        }
                      >
                        <Icon name={section.icon} />
                        <span>{t(section.text)}</span>
                      </button>
                    );
                  })}
                <div className="sidebar-settings">
                  <button className="nav-item" onClick={() => void openSettings()}>
                    <Icon name="settings" />
                    {t('设置')}
                  </button>
                </div>
              </nav>
            )}
            <div className="sidebar-bottom">
              <span className={'status-dot ' + (connected ? '' : 'offline')} />
              {connected ? t('已连接本机') : t('正在重新连接')}
              <span className="footer-version">
                {t('v')}
                {data.version}
              </span>
            </div>
          </aside>
          <main>
            <header className="topbar">
              <div>
                <span className="breadcrumb">{t(viewSection(page)?.group ?? 'Echo')}</span>
                <Icon name="chevron" size={13} />
                <strong>
                  {t(
                    settingsWindow || workspaceScope || page === 'personas'
                      ? (viewSection(page)?.text ?? '设置')
                      : page === 'groups'
                        ? '群聊'
                        : (role?.name ?? 'Echo'),
                  )}
                </strong>
              </div>
              <div className="topbar-actions">
                <Appearance />
                {data.pendingInteractions?.length > 0 && (
                  <Button
                    secondary
                    onClick={() => {
                      sessionStorage.setItem(
                        'echo.chat',
                        data.pendingInteractions[0].conversationId,
                      );
                      if (settingsWindow)
                        void openWorkbench('chat', {
                          conversationId: data.pendingInteractions[0].conversationId,
                        });
                      else goPage('chat', undefined, undefined, undefined, { workspace: false });
                    }}
                  >
                    {t('待确认')} · {data.pendingInteractions.length}
                  </Button>
                )}
                {pending > 0 && (
                  <span className="saving-indicator">
                    <span className="spinner" />
                    {t('正在处理')}
                  </span>
                )}
                <span className="local-badge">
                  <span className={'status-dot ' + (connected ? '' : 'offline')} />
                  {connected ? t('本机已连接') : t('连接中')}
                </span>
                <button
                  className="icon-button"
                  title={t('刷新页面数据')}
                  aria-label={t('刷新页面数据')}
                  disabled={pending > 0}
                  onClick={() => act(refresh, t('已刷新'))}
                >
                  <Icon name="review" size={16} />
                </button>
              </div>
            </header>
            {roleSection && !['personas', 'character', 'character-session'].includes(page) && role && (
              <div className="role-heading">
                <button className="text-button" onClick={() => goPage('personas')}>
                  {t('所有角色')}
                </button>
                <Icon name="chevron" size={13} />
                <strong>{role.name}</strong>
              </div>
            )}
            {!extensionWindow && !settingsWindow && roleSection && role && (
              <div className="page-sheets" role="tablist" aria-label={t('角色能力')}>
                {[
                  { id: 'character', text: '聊天', owner: 'persona' },
                  { id: 'character-session', text: '后台工作会话', owner: 'persona' },
                  { id: 'memory', text: '角色资料', owner: 'persona' },
                  { id: 'automation', text: '任务', owner: 'persona' },
                  ...pages
                    .filter((entry: any) => entry.placement === 'character')
                    .map((entry: any) => ({ id: entry.id, text: entry.title, owner: entry.owner })),
                ]
                  .filter(
                    (view) =>
                      (view.id !== 'reflections' ||
                        !data.plugins.some(
                          (p: any) =>
                            p.id === 'memory' &&
                            p.enabled &&
                            (!data.characters.find((r: any) => r.id === role.id) ||
                              data.characters
                                .find((r: any) => r.id === role.id)
                                .features.includes('memory')),
                        )) &&
                      (view.owner === 'persona' ||
                        pages.some((entry: any) => entry.id === view.id) ||
                        view.id === 'automation' ||
                        (view.id === 'channels' && enabled.has('channels')) ||
                        (data.plugins.some((p: any) => p.id === view.owner && p.enabled) &&
                          (!data.characters.find((r: any) => r.id === role.id) ||
                            data.characters
                              .find((r: any) => r.id === role.id)
                              .features.includes(view.owner)))),
                  )
                  .map((view) => (
                    <button
                      key={view.id}
                      role="tab"
                      aria-selected={page === view.id}
                      onClick={() => goPage(view.id)}
                    >
                      {t(view.text)}
                    </button>
                  ))}
              </div>
            )}
            {!extensionWindow &&
              (settingsWindow || workspaceScope) &&
              (() => {
                const views =
                  viewSection(page)?.views.filter(
                    (v) =>
                      (coreViews.has(v.id) || enabled.has(v.id)) &&
                      (!settingsWindow || isSettingsPage(v.id)) &&
                      (!roleSection ||
                        (page !== 'personas' &&
                          v.id !== 'personas' &&
                          (!newRole || v.id === 'persona-settings'))),
                  ) ?? [];
                return (
                  views.length > 1 && (
                    <div
                      className="page-sheets"
                      role="tablist"
                      aria-label={t(viewSection(page)?.text ?? '')}
                      onKeyDown={(event) => {
                        if (['ArrowRight', 'ArrowLeft'].includes(event.key)) {
                          event.preventDefault();
                          const index = views.findIndex((v) => v.id === page);
                          const next =
                            views[
                              (index + (event.key === 'ArrowRight' ? 1 : views.length - 1)) %
                                views.length
                            ];
                          goPage(next.id);
                          requestAnimationFrame(() =>
                            document.getElementById('sheet-' + next.id)?.focus(),
                          );
                        }
                      }}
                    >
                      {views.map((view) => (
                        <button
                          key={view.id}
                          id={'sheet-' + view.id}
                          data-view={view.id}
                          role="tab"
                          tabIndex={page === view.id ? 0 : -1}
                          aria-selected={page === view.id}
                          aria-controls={'view-' + view.id}
                          onClick={() => goPage(view.id)}
                        >
                          {t(view.text)}
                        </button>
                      ))}
                    </div>
                  )
                );
              })()}
            <div
              id={'view-' + page}
              className={
                'page-content ' + (['chat', 'character', 'character-session'].includes(page) ? 'chat-page' : '')
              }
              key={(roleSection ? (page === 'character-session' ? 'character' : page) + ':' + (role?.id ?? '') : page) + ':' + taskRevision}
            >
              {error && (
                <div className="error" role="alert">
                  {error}
                  <button
                    className="icon-button"
                    aria-label={t('关闭错误提示')}
                    onClick={() => setError('')}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              )}
              <Suspense
                fallback={
                  <div className="chat-loading">
                    <span className="spinner" />
                    {t('正在打开…')}
                  </div>
                }
              >
                {extensionPage ? (
                  <PluginPage
                    key={
                      page + ':' + (extensionPage.placement === 'character' ? (role?.id ?? '') : '')
                    }
                    page={extensionPage}
                    navigate={setPage}
                    personaId={extensionPage.placement === 'character' ? role?.id : undefined}
                    act={act}
                    popout={() => void popoutPlugin().catch((error) => setError(error.message))}
                  />
                ) : extensionWindow ? (
                  <EmptyState>{t('插件页面当前不可用。')}</EmptyState>
                ) : page === 'character-wizard' ? (
                  <CharacterWizard
                    {...{ data, act, openSettings, openTask }}
                    initialStep={wizardStep}
                    initialTaskId={wizardTaskId}
                    personaId={wizardRole}
                    onClose={() => setPage('character')}
                    onComplete={(value: any) => {
                      savedRole(value.persona);
                      setPage('character');
                    }}
                  />
                ) : page === 'character' || page === 'character-session' ? (
                  role ? (
                    <CharacterHome
                      key={role.id}
                      {...{ role, data, act, openTask }}
                      edit={editRole}
                      setPage={goPage}
                      backstage={page === 'character-session'}
                    />
                  ) : (
                    <Button onClick={() => editRole()}>{t('创建角色')}</Button>
                  )
                ) : page === 'groups' ? (
                  <GroupView
                    {...{ data, act }}
                    groupId={groupSelection}
                    onSelect={setGroupSelection}
                    setPage={goPage}
                  />
                ) : (page === 'delegation' || (page === 'automation' && roleSection)) && role ? (
                  <TaskWorkspace
                    {...{ data, act, openTask }}
                    personaId={role.id}
                    setPage={goPage}
                    configureRole={(taskId?: string) => editRole(role, 4, taskId)}
                  />
                ) : ['files', 'assets'].includes(page) ? (
                  <ArchiveView {...{ page, data, act }} />
                ) : page === 'reflections' ? (
                  <Memories initialCategory="concerns" />
                ) : page === 'automation' || page === 'care' ? (
                  <AutomationView
                    act={act}
                    openTask={openTask}
                    only={page === 'care' ? 'care.rules' : undefined}
                    personaId={roleSection ? role?.id : undefined}
                    configureRole={
                      roleSection && role
                        ? (taskId?: string) => editRole(role, 4, taskId)
                        : undefined
                    }
                    roleTasks={
                      roleSection
                        ? data.characters.find((record: any) => record.id === role?.id)?.taskIds
                        : undefined
                    }
                  />
                ) : page === 'chat' ? (
                  <Chat />
                ) : page === 'personas' ? (
                  <RoleList {...{ data, openRole, act, openSettings }} />
                ) : page === 'persona-settings' ? (
                  <Personas />
                ) : page === 'memory' ? (
                  <Memories />
                ) : page === 'backends' ? (
                  <Backends />
                ) : page === 'plugins' ? (
                  <ExtensionSettings />
                ) : page === 'updates' ? (
                  <UpdatesView />
                ) : page === 'observation' ? (
                  <Observation />
                ) : page === 'knowledge' ? (
                  <Knowledge />
                ) : page === 'review' ? (
                  <Review />
                ) : page === 'avatar' ? (
                  <AvatarSettings />
                ) : page === 'channels' && role ? (
                  <ChannelSettings />
                ) : page === 'chatstick' && role ? (
                  <ChatStickView key={role.id} personaId={role.id} />
                ) : page === 'agenda' ? (
                  <AgendaCalendar data={data} act={act} />
                ) : [
                    'files',
                    'assets',
                    'agenda',
                    'mail',
                    'scheduler',
                    'backup',
                    'notifications',
                    'approvals',
                    'channels',
                    'channel-connections',
                  ].includes(page) ? (
                  <FeaturePage
                    key={page + ':' + (roleSection ? role?.id : 'global')}
                    page={page}
                    data={data}
                    act={act}
                    setPage={goPage}
                    personaId={roleSection ? role?.id : undefined}
                  />
                ) : (
                  <Diagnostics />
                )}
              </Suspense>
            </div>
            {notice && (
              <div className="toast" role="status">
                <span className="toast-check">
                  <Icon name="check" size={15} />
                </span>
                {t(notice)}
                <button
                  className="icon-button"
                  aria-label={t('关闭通知')}
                  onClick={() => setNotice('')}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
          </main>
        </div>
      </Context.Provider>
    </UiProvider>
  );
}
function Title({ title }: any) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
    </div>
  );
}
function Empty({ children }: any) {
  return <EmptyState>{children}</EmptyState>;
}
function Chat() {
  return <ChatView {...useApp()} />;
}
function RoleList({ data, openRole, act, openSettings }: any) {
  return (
    <>
      <div className="page-title page-title-actions">
        <h1>{t('角色')}</h1>
        <Button onClick={() => openRole()}>{t('＋ 新角色')}</Button>
      </div>
      <StarterCharacters {...{data, act, openRole, openSettings}} />
      <div className="role-grid">
        {data.personas.map((role: Persona) => (
          <button key={role.id} className="card role-tile" onClick={() => openRole(role)}>
            <CharacterPortrait className="brand-mark" persona={role} />
            <strong>{role.name}</strong>
            {data.characterActivities?.[role.id]?.enabled === false && <small>{t('已停用')}</small>}
            <Icon name="chevron" size={16} />
          </button>
        ))}
      </div>
    </>
  );
}
function Personas() {
  const { data, act, role, savedRole, setPage, openSettings } = useApp();
  return (
    <CharacterWizard
      {...{ data, act, openSettings }}
      personaId={role?.id}
      onClose={() => setPage('character')}
      onComplete={(value: any) => {
        savedRole(value.persona);
        setPage('character');
      }}
    />
  );
}

function Memories({ initialCategory }: any = {}) {
  const { act, role, data } = useApp();
  const features = data.characters.find((entry: any) => entry.id === role.id)?.features;
  const available = (id: string) =>
    data.plugins.some((plugin: any) => plugin.id === id && plugin.enabled) &&
    (!features || features.includes(id));
  const hasMemory = available('memory'),
    hasConcerns = available('reflections');
  const personaId = role.id;
  const confirmAction = useConfirm();
  const [items, setItems] = useState<Memory[]>([]),
    [query, setQuery] = useState(''),
    [matches, setMatches] = useState<any[]>([]),
    [editing, setEditing] = useState<any>(),
    [category, setCategory] = useState<string>(
      initialCategory ?? (hasMemory ? 'core' : hasConcerns ? 'concerns' : 'archives'),
    );
  const loadVersion = useRef(0),
    baseline = useRef<any>(undefined);
  useUnsavedChanges(Boolean(editing && !sameData(editing, baseline.current)), '角色记忆');
  const editMemory = (value: any) => {
    baseline.current = value;
    setEditing(value);
  };
  const load = useCallback(async () => {
    if (!hasMemory) return;
    const v = ++loadVersion.current,
      rows = await rpc<Memory[]>('memory.list', { personaId });
    if (v === loadVersion.current) setItems(rows);
  }, [personaId, hasMemory]);
  useEffect(() => {
    if (category === 'concerns' && !hasConcerns) setCategory('core');
    if (!hasMemory && ['core', 'other'].includes(category))
      setCategory(hasConcerns ? 'concerns' : 'archives');
  }, [hasMemory, hasConcerns, category]);
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load]);
  const visible = items.filter((m) => m.core === (category === 'core'));
  return (
    <>
      <Title title={t('角色资料')} />
      {['core', 'other'].includes(category) && (
        <div className="row wrap toolbar">
          <Button
            onClick={() =>
              requestNavigation(() =>
                editMemory({
                  personaId,
                  title: '',
                  text: '',
                  core: category === 'core',
                  tags: [],
                  sources: [],
                }),
              )
            }
          >
            {' '}
            {t('＋ 添加记忆')}{' '}
          </Button>
          <input
            aria-label={t('记忆检索')}
            placeholder={t('试着检索一件事…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            secondary
            onClick={() =>
              act(
                async () => setMatches(await rpc('memory.recall', { personaId, text: query })),
                t('检索完成'),
              )
            }
          >
            {' '}
            {t('检索预览')}{' '}
          </Button>
        </div>
      )}
      <div className="inference-tabs memory-tabs" role="tablist" aria-label={t('记忆分类')}>
        {[
          ...(hasMemory ? ['core', 'other'] : []),
          ...(hasConcerns ? ['concerns'] : []),
          'archives',
        ].map((key) => (
          <button
            key={key}
            data-memory-kind={key}
            role="tab"
            aria-selected={category === key}
            onClick={() =>
              requestNavigation(() => {
                setCategory(key);
                setEditing(undefined);
                setMatches([]);
              })
            }
          >
            {t(
              key === 'core'
                ? '核心记忆'
                : key === 'other'
                  ? '召回记忆'
                  : key === 'concerns'
                    ? '角色关切'
                    : '设定与档案',
            )}{' '}
            {['core', 'other'].includes(key) && (
              <span className="count">
                {items.filter((m) => m.core === (key === 'core')).length}
              </span>
            )}
          </button>
        ))}
      </div>
      {category === 'archives' ? (
        <CharacterLibrary personaId={personaId} plugins={data.plugins} />
      ) : category === 'concerns' ? (
        <ReflectionsView {...{ personaId, act }} embedded />
      ) : (
        <>
          {matches.length > 0 && (
            <div className="card">
              <h2>{t('召回结果')}</h2>
              {matches.map((m) => (
                <p key={m.memory.id}>
                  <b>{m.memory.title}</b> · {m.score.toFixed(3)}
                  <br />
                  {m.memory.text}
                </p>
              ))}
            </div>
          )}
          {editing && (
            <div className="card">
              <h2>{editing.id ? t('编辑记忆') : t('添加记忆')}</h2>
              <FieldInput
                field={{ key: 'title', label: t('标题'), type: 'text' }}
                value={editing.title}
                onChange={(title) => setEditing({ ...editing, title })}
              />
              <FieldInput
                field={{ key: 'text', label: t('内容'), type: 'textarea' }}
                value={editing.text}
                onChange={(text) => setEditing({ ...editing, text })}
              />
              <FieldInput
                field={{ key: 'core', label: t('作为核心记忆固定注入'), type: 'boolean' }}
                value={editing.core}
                onChange={(core) => setEditing({ ...editing, core })}
              />
              <div className="row">
                <Button
                  onClick={() =>
                    act(async () => {
                      const coreChange =
                        editing.core || items.find((m) => m.id === editing.id)?.core;
                      if (
                        coreChange &&
                        !(await confirmAction({
                          title: t('修改核心记忆？'),
                          description: t('核心记忆会固定注入后续对话，请确认内容准确。'),
                          confirmLabel: t('确认保存'),
                        }))
                      )
                        return;
                      await rpc(coreChange ? 'memory.saveCore' : 'memory.save', {
                        ...editing,
                        ...(coreChange ? { approved: true } : {}),
                      });
                      setCategory(editing.core ? 'core' : 'other');
                      setEditing(undefined);
                      await load();
                    })
                  }
                >
                  {' '}
                  {t('保存记忆')}{' '}
                </Button>
                <Button secondary onClick={() => setEditing(undefined)}>
                  {' '}
                  {t('取消')}{' '}
                </Button>
              </div>
            </div>
          )}
          <div className="card-grid">
            {visible.map((memory) => (
              <div className="card memory-card" key={memory.id}>
                <div className="row between">
                  <span className="tag">{memory.core ? t('核心') : t('可召回')}</span>
                  <button
                    className="text-button"
                    onClick={() => requestNavigation(() => editMemory(memory))}
                  >
                    {' '}
                    {t('编辑')}{' '}
                  </button>
                </div>
                <h2>{memory.title}</h2>
                <p>{memory.text}</p>
                <div className="row between">
                  <small>{new Date(memory.updatedAt).toLocaleDateString(locale())}</small>
                  <button
                    className="text-button danger"
                    onClick={async () => {
                      if (
                        await confirmAction({
                          title: t('移除这条记忆？'),
                          description: '从召回记忆中移除“' + memory.title + '”。知识库原文会保留。',
                          danger: true,
                          confirmLabel: t('移除记忆'),
                        })
                      )
                        return act(async () => {
                          await rpc('memory.delete', { id: memory.id, approved: true });
                          await load();
                        });
                    }}
                  >
                    {' '}
                    {t('移除')}{' '}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {!visible.length && (
            <Empty>{t(category === 'core' ? '暂无核心记忆' : '暂无其他记忆')}</Empty>
          )}
        </>
      )}
    </>
  );
}
function Backends() {
  const { data, act } = useApp();
  return (
    <Suspense fallback={null}>
      <BackendsView data={data} act={act} />
    </Suspense>
  );
}
function ExtensionSettings() {
  const { data, act } = useApp();
  const [section, setSection] = useState<'plugins' | 'mcp'>('plugins');
  useEffect(() => {
    const selectPlugin = () => setSection('plugins');
    window.addEventListener('echo:selection', selectPlugin);
    return () => window.removeEventListener('echo:selection', selectPlugin);
  }, []);
  return <>
    <Title title={t('扩展')} />
    <div className="inference-tabs" role="tablist" aria-label={t('扩展')}>
      <button type="button" role="tab" aria-selected={section === 'plugins'} className={section === 'plugins' ? 'active' : ''}
        onClick={() => requestNavigation(() => setSection('plugins'))}>{t('组件与插件')}</button>
      <button type="button" role="tab" aria-selected={section === 'mcp'} className={section === 'mcp' ? 'active' : ''}
        onClick={() => requestNavigation(() => setSection('mcp'))}>{t('外部 MCP')}</button>
    </div>
    {section === 'plugins' ? <Plugins /> : <ExternalMcpView servers={data.externalMcpServers ?? []} act={act} />}
  </>;
}
function Plugins() {
  const { data, act } = useApp();
  const confirmAction = useConfirm();
  const plugins = data.plugins
    .filter((p: any) => !p.internalComponent)
    .sort((a: any, b: any) => a.loadOrder - b.loadOrder);
  const initial =
    plugins.find((p: any) => p.id === sessionStorage.getItem('echo.plugin'))?.id ??
    plugins[0]?.id ??
    '';
  const [selected, setSelected] = useState(() => initial),
    [settings, setSettings] = useState<any>(() => {
      return data[initial + 'Config'] ?? data.pluginSettings?.[initial] ?? {};
    }),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [sortMode, setSortMode] = useState('category'),
    [directory, setDirectory] = useState('');
  useEffect(() => {
    const listener = () => {
      const id = sessionStorage.getItem('echo.plugin');
      if (id) select(id);
    };
    window.addEventListener('echo:selection', listener);
    return () => window.removeEventListener('echo:selection', listener);
  }, [data]);
  const plugin = plugins.find((p: any) => p.id === selected);
  const hasModuleRoutes = data.inference.tasks.some(
    (task: any) => task.scope !== 'character' && task.owner === selected,
  );
  useUnsavedChanges(
    !sameData(settings, data[selected + 'Config'] ?? data.pluginSettings?.[selected] ?? {}),
    '插件设置',
  );
  const select = (id: string) =>
    requestNavigation(() => {
      if (!plugins.some((p: any) => p.id === id)) return;
      sessionStorage.setItem('echo.plugin', id);
      setSelected(id);
      setSettings(data[id + 'Config'] ?? data.pluginSettings?.[id] ?? {});
    });
  return (
    <>
      <div className="plugin-layout">
        <div>
          <div className="plugin-list-tools">
            <label className="search-control">
              <Icon name="search" size={15} />
              <input
                aria-label={t('搜索插件')}
                placeholder={t('搜索插件…')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label={t('插件状态筛选')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">
                {t('全部')} {plugins.length}
              </option>
              <option value="active">{t('已启用')}</option>
              <option value="disabled">{t('未启用')}</option>
            </select>
          </div>
          <label className="plugin-sort">
            <span>{t('插件排序')}</span>
            <select
              aria-label={t('插件排序')}
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value)}
            >
              <option value="category">{t('按功能分类')}</option>
              <option value="dependency">{t('按加载依赖')}</option>
            </select>
          </label>
          {[...plugins]
            .sort((a: any, b: any) =>
              sortMode === 'category'
                ? (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1) ||
                  (a.category ?? '').localeCompare(b.category ?? '') ||
                  a.loadOrder - b.loadOrder
                : a.loadOrder - b.loadOrder,
            )
            .filter(
              (p: any) =>
                (filter === 'all' || (filter === 'active' ? p.enabled : !p.enabled)) &&
                (t(p.name) + ' ' + p.name + ' ' + p.id + ' ' + t(p.description))
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map((p: any, index: number, all: any[]) => (
              <Fragment key={p.id}>
                {sortMode === 'category' &&
                  (index === 0 || all[index - 1].category !== p.category) && (
                    <h3 className="plugin-category">{t(p.category ?? 'Other extensions')}</h3>
                  )}
                <button
                  className={'plugin-row ' + (selected === p.id ? 'selected' : '')}
                  data-plugin={p.id}
                  key={p.id}
                  onClick={() => select(p.id)}
                >
                  <span className="plugin-icon">
                    <Icon name={p.views?.[0] ?? p.id} size={20} />
                  </span>
                  <span>
                    <strong>{t(p.name)}</strong>
                    {p.optionalDependencies?.some(
                      (id: string) => !data.plugins.find((base: any) => base.id === id)?.builtin,
                    ) && (
                      <span className="plugin-enhances">
                        {t('可选依赖：')}
                        {p.optionalDependencies
                          .map((id: string) =>
                            t(data.plugins.find((base: any) => base.id === id)?.name ?? id),
                          )
                          .join(' · ')}
                      </span>
                    )}
                    <small>{t(p.description)}</small>
                  </span>
                  <span className={'state-pill ' + (p.enabled ? 'on' : '')}>
                    {statusText(p.state)}
                  </span>
                </button>
              </Fragment>
            ))}
          <PluginPackageInstaller act={act} />
          <details className="card">
            <summary>{t('开发者：加载目录')}</summary>
            <h3>{t('加载本地扩展')}</h3>
            <PathInput label={t('扩展目录')} value={directory} onChange={setDirectory} directory />
            <p className="muted">{t('本地扩展可运行本机代码，仅加载信任的目录。')}</p>
            <Button
              secondary
              onClick={async () => {
                if (
                  await confirmAction({
                    title: t('加载本地扩展？'),
                    description: (
                      <>
                        {t('此扩展可以运行本机代码，请仅加载你信任的目录。')}
                        <code>{directory}</code>
                      </>
                    ),
                    confirmLabel: t('信任并登记'),
                  })
                )
                  return act(
                    () => rpc('plugins.install', { directory, confirmed: true }),
                    t('扩展已登记，可在列表中启用'),
                  );
              }}
            >
              {' '}
              {t('登记扩展')}{' '}
            </Button>
          </details>
        </div>
        {plugin && (
          <div className="card plugin-details">
            <div className="row between">
              <h2>{t(plugin.name)}</h2>
              {!plugin.builtin && (
                <Button
                  secondary
                  onClick={() =>
                    act(
                      () =>
                        rpc('plugins.enable', {
                          id: plugin.id,
                          enabled: !(plugin.enabled || plugin.requested),
                        }),
                      plugin.enabled ? '插件已停用' : '插件已启用',
                    )
                  }
                >
                  {plugin.enabled || plugin.requested ? t('停用') : t('启用')}
                </Button>
              )}
            </div>
            <p>{t(plugin.description)}</p>
            {plugin.distribution === 'local' && <div className="form-actions"><Button secondary onClick={async () => {
              if (await confirmAction({ title: t('卸载此扩展？'), description: t('扩展接口和页面将移除，配置与数据保留。'), confirmLabel: t('卸载扩展') }))
                await act(() => rpc('plugins.package.uninstall', { id: selected, confirmed: true }), t('扩展已卸载，数据已保留'));
            }}>{t('卸载扩展')}</Button></div>}
            {data.extensionPackages?.find((entry: any) => entry.id === selected)
              ?.rollbackVersion && (
              <div className="form-actions">
                <Button
                  secondary
                  onClick={async () => {
                    if (
                      await confirmAction({
                        title: t('回退插件版本？'),
                        description: t('完整重启后使用上一安装版本，插件配置保留。'),
                        confirmLabel: t('登记回退'),
                      })
                    )
                      await act(
                        () => rpc('plugins.package.rollback', { id: selected, confirmed: true }),
                        t('已登记插件回退，完整重启后生效'),
                      );
                  }}
                >
                  {t('回退到上一版本')}
                </Button>
              </div>
            )}

            {plugin.optionalDependencies?.some(
              (id: string) => !data.plugins.find((base: any) => base.id === id)?.builtin,
            ) && (
              <div className="plugin-relationship">
                <span>{t('可选依赖')}</span>
                {plugin.optionalDependencies
                  .filter(
                    (id: string) => !data.plugins.find((base: any) => base.id === id)?.builtin,
                  )
                  .map((id: string) =>
                    plugins.some((p: any) => p.id === id) ? (
                      <button key={id} className="text-button" onClick={() => select(id)}>
                        {t(data.plugins.find((p: any) => p.id === id)?.name ?? id)} ↗
                      </button>
                    ) : (
                      <span key={id}>
                        {t(data.plugins.find((p: any) => p.id === id)?.name ?? id)}
                      </span>
                    ),
                  )}
              </div>
            )}
            {plugin.error && (
              <p className="warning">
                {statusText(plugin.state)}：{plugin.error}
              </p>
            )}
            <details className="metadata-details">
              <summary>{t('版本、权限与依赖')}</summary>
              <div className="metadata">
                {' '}
                {t('版本')} {plugin.version}
                <br />
                {plugin.package} · {plugin.distribution}
                <br /> {t('依赖：')}
                {plugin.dependencies
                  .filter((id: string) => !data.plugins.find((p: any) => p.id === id)?.builtin)
                  .map((id: string) => t(data.plugins.find((p: any) => p.id === id)?.name ?? id))
                  .join('、') || t('无')}
                <br /> {t('能力：')}
                {plugin.permissions.join('、') || t('无')}
              </div>
            </details>
            {plugin.settings
              .filter((f: Field) => selected !== 'qq' || !['appId', 'secretRef'].includes(f.key))
              .map((f: Field) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={settings[f.key]}
                  onChange={(v) => setSettings({ ...settings, [f.key]: v })}
                />
              ))}
            {plugin.enabled && (
              <Suspense fallback={<p>{t('正在打开…')}</p>}>
                {data.inference.adapters.some((adapter: any) => adapter.owner === selected) && (
                  <BackendsView key={selected} data={data} act={act} owner={selected} embedded />
                )}
                {['embeddings', 'semantic'].includes(selected) && (
                  <p className="muted">{t('模型在「模型服务」中统一登记，再在下方选择用途。')}</p>
                )}
                {selected === 'storage' && <StorageSettings act={act} />}
                {selected === 'knowledge' && <DocumentProcessing data={data} act={act} />}
                {selected === 'qq' && (
                  <FeaturePage page="channel-connections" data={data} act={act} />
                )}
                {(data.frontend?.pages ?? [])
                  .filter(
                    (page: any) => page.owner === selected && page.placement === 'plugin-settings',
                  )
                  .map((page: any) => (
                    <PluginPage key={page.id} page={page} act={act} embedded />
                  ))}
              </Suspense>
            )}
            <PluginInferenceRoutes pluginId={selected} data={data} act={act} />
            {plugin.settings.length > 0 && (
              <Button
                onClick={() =>
                  act(async () => {
                    setSettings(
                      await rpc('settings.save', { pluginId: selected, value: settings }),
                    );
                  })
                }
              >
                {' '}
                {t('保存设置')}{' '}
              </Button>
            )}
            {plugin.settings.length === 0 &&
              !hasModuleRoutes &&
              !['knowledge', 'qq', 'models', 'storage', 'clock'].includes(selected) &&
              !data.inference.adapters.some((adapter: any) => adapter.owner === selected) && (
                <p className="muted">
                  {t(
                    plugin.characterConfigurable
                      ? '在角色的「配置角色」中调整此能力。'
                      : '此插件的常用功能位于左侧专用页面。',
                  )}
                </p>
              )}
          </div>
        )}
      </div>
    </>
  );
}
function observationState(
  enabled: boolean,
  status?: { allowed: boolean; samplingReason?: string },
) {
  if (!enabled) return t('采集已关闭');
  if (status?.allowed) return t('正在观察获准内容');
  return status?.samplingReason && status.samplingReason !== '没有可见的白名单内容'
    ? t('采样暂缓')
    : t('等待可见白名单内容');
}
function Observation() {
  const { data } = useApp();
  const tasks: ObservationConfig[] = data.observationTasks;
  const [selectedId, setSelectedId] = useState(() => {
    const pending = sessionStorage.getItem('echo.automation.open');
    const target = pending ? JSON.parse(pending) : undefined;
    if (target?.type === 'observation.tasks') {
      return target.id as string;
    }
    return sessionStorage.getItem('echo.observation.task') ?? '';
  });
  const value = tasks.find((task) => task.id === selectedId) ?? tasks[0];
  useEffect(() => {
    const pending = sessionStorage.getItem('echo.automation.open');
    if (pending && JSON.parse(pending).type === 'observation.tasks')
      sessionStorage.removeItem('echo.automation.open');
  }, []);
  const [statuses, setStatuses] = useState<any[]>([]);
  const revision = useRef(0);
  const load = async () => {
    const ticket = ++revision.current;
    const result = await rpc<any>('observation.status');
    if (ticket === revision.current) setStatuses(result.tasks);
  };
  useEffect(() => {
    const refresh = () => void load().catch(() => {});
    refresh();
    const fn = (e: any) => {
      if (e.detail.type.startsWith('observation.')) refresh();
    };
    window.addEventListener('echo-event', fn);
    return () => {
      revision.current++;
      window.removeEventListener('echo-event', fn);
    };
  }, []);
  const status = statuses.find((entry) => entry.id === value?.id)?.status;
  const recent = statuses.find((entry) => entry.id === value?.id)?.recent ?? [];
  const select = (task: ObservationConfig) => {
    sessionStorage.setItem('echo.observation.task', task.id);
    setSelectedId(task.id);
  };
  return (
    <>
      <div className="page-title page-title-actions">
        <h1>{t('实时观察')}</h1>
        <span className="muted">{t('任务配置统一在角色配置中管理')}</span>
      </div>
      <div className="observation-task-list" aria-label={t('观察任务')}>
        {tasks.map((task) => {
          const current = statuses.find((entry) => entry.id === task.id)?.status;
          return (
            <button
              key={task.id}
              className="card observation-task"
              aria-pressed={value?.id === task.id}
              onClick={() => task.id !== value?.id && requestNavigation(() => select(task))}
            >
              <strong>{task.name}</strong>
              <span>
                {data.personas.find((p: Persona) => p.id === task.personaId)?.name ??
                  task.personaId}
              </span>
              <span className={'state-pill ' + (task.enabled && current?.allowed ? 'on' : '')}>
                {observationState(task.enabled, current)}
              </span>
            </button>
          );
        })}
      </div>
      {!value ? (
        <Empty>{t('还没有观察任务。')}</Empty>
      ) : (
        <>
          <div className="observation-status-view">
            <div className="row wrap toolbar">
              <span className={'state-pill ' + (status?.enabled && status.allowed ? 'on' : '')}>
                {observationState(value.enabled, status)}
              </span>
              <span className="muted">
                {t('5 秒选帧 · {frames} 张组图 · {history} 轮上文 · JPEG {quality}', {
                  frames: value.frameCount,
                  quality: value.quality,
                  history: value.historyRounds,
                })}
              </span>
            </div>
            <div className="two-column">
              <div className="card">
                <h2>{t('本次进程')}</h2>
                <div className="metric-grid">
                  {[
                    ['采样检查', status?.probes ?? 0],
                    ['选中帧', status?.selected ?? 0],
                    ['完成拼图', status?.batches ?? 0],
                    ['当前组图', `${status?.bufferedFrames ?? 0} / ${value.frameCount}`],
                    ['超时丢弃组数', status?.expiredBatches ?? 0],
                    ['图像上传', ((status?.uploadedBytes ?? 0) / 1048576).toFixed(2) + t(' MB')],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <b>{value}</b>
                      <small>{t(label)}</small>
                    </div>
                  ))}
                </div>
                {status?.lastError && <p className="warning">{status.lastError}</p>}
                {status?.interactionOutcome && (
                  <p
                    className={
                      status.interactionOutcome === 'empty' ||
                      status.interactionOutcome === 'failed'
                        ? 'warning'
                        : 'muted'
                    }
                  >
                    {status.interactionOutcome === 'reply'
                      ? t('上次互动已生成回复。')
                      : status.interactionOutcome === 'skip'
                        ? t('上次互动由角色主动跳过。')
                        : status.interactionOutcome === 'empty'
                          ? t('上次互动的模型返回为空，没有生成气泡。')
                          : t('上次互动未完成，请查看运行诊断。')}
                  </p>
                )}
                {status?.enabled && status?.samplingReason && (
                  <p className="muted" role="status">
                    {/被无法确认透明区域的叠层遮挡|被其他窗口遮挡/.test(status.samplingReason)
                      ? t(
                          '白名单内容当前被窗口遮挡；如需忽略该窗口，可在任务设置中按进程名或标题添加规则。',
                        )
                      : t(status.samplingReason)}
                  </p>
                )}
                {status?.lastVisibility && (
                  <p className="muted" role="status">
                    {t('画面诊断：可见区域 {visible}% · 内容信号 {content}% · {backend}', {
                      visible: status.lastVisibility.visiblePercent,
                      content:
                        status.lastVisibility.contentPercent ?? status.lastVisibility.litPercent,
                      backend:
                        status.captureBackend === 'dxgi'
                          ? 'DXGI'
                          : status.captureBackend === 'wgc'
                            ? 'Windows Graphics Capture'
                            : status.captureBackend === 'printwindow'
                              ? 'PrintWindow'
                              : 'GDI',
                    })}
                    {status.lastVisibility.visiblePercent > 2 &&
                      status.lastVisibility.contentPercent === 0 &&
                      status.lastVisibility.litPercent === 0 &&
                      status.captureBackend === 'gdi' && (
                        <span> {t('GDI 没读到像素内容；无边框全屏可能触发显卡合成回退。')}</span>
                      )}
                  </p>
                )}
                <p className="muted">{t('图片上传量按 base64 估算，不含文本、TLS 和协议开销。')}</p>
              </div>
              <div className="card">
                <h2>{t('近期观察')}</h2>
                {recent
                  .slice(-12)
                  .reverse()
                  .map((o: any) => (
                    <div className="observation-row" key={o.id}>
                      <time>{new Date(o.timestamp).toLocaleTimeString(locale())}</time>
                      <p>{o.summary}</p>
                      <small>{o.sources.join(' · ')}</small>
                      {o.interesting && <span className="tag">{t('值得聊聊')}</span>}
                    </div>
                  ))}
                {!recent.length && <Empty>{t('还没有完成的观察。')}</Empty>}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
function Knowledge() {
  return <KnowledgeView {...useApp()} />;
}
function Review() {
  const { act, openTask, data } = useApp();
  const [jobs, setJobs] = useState<any[]>([]);
  const [resumeModels, setResumeModels] = useState<Record<string, string>>({});
  const load = () => rpc('review.list', {}).then(setJobs);
  useEffect(() => {
    void load();
    const listener = (e: any) => {
      if (e.detail.type === 'review.updated') void load();
    };
    window.addEventListener('echo-event', listener);
    return () => window.removeEventListener('echo-event', listener);
  }, []);
  return (
    <>
      <AutomationView act={act} openTask={openTask} only="review.policies" compact />
      <h2>{t('整理记录')}</h2>
      {jobs.map((job) => (
        <div className="card" key={job.id}>
          <div className="row between">
            <h2>
              {new Date(job.createdAt).toLocaleString(locale())} · {job.personaId}
            </h2>
            <span className={'state-pill ' + (job.state === 'completed' ? 'on' : '')}>
              {statusText(job.state)}
            </span>
          </div>
          <p>
            {job.materialCount} {t('条材料 · 已检查')} {job.nextPacket} / {job.totalPackets}{' '}
            {t('段')}{' '}
          </p>
          <progress value={job.nextPacket} max={Math.max(1, job.totalPackets)} />
          {job.error && <p className="warning">{job.error}</p>}
          <p className="review-notes">{job.notes}</p>
          {job.drafts.length > 0 && (
            <details>
              <summary>
                {job.drafts.length} {t('条记忆建议')}
              </summary>
              {job.drafts.map((d: any, i: number) => (
                <p key={i}>
                  <b>{d.title}</b>
                  <br />
                  {d.text}
                </p>
              ))}
            </details>
          )}
          {job.actions?.length > 0 && (
            <details className="review-actions">
              <summary>
                {t('插件整理建议')} · {job.actions.length}
              </summary>
              {job.actions.map((a: any, n: number) => (
                <article key={n}>
                  <strong>{a.title}</strong>
                  <p>{a.text}</p>
                  <small>
                    {a.target === 'reflections.state' ? t('角色关切') : a.target} ·{' '}
                    {t(
                      (
                        {
                          add: '新增',
                          update: '修订',
                          forget: '淡出关注',
                          resolve: '解决',
                          archive: '归档',
                        } as any
                      )[a.operation ?? 'add'],
                    )}
                  </small>
                </article>
              ))}
            </details>
          )}
          <div className="row">
            {job.state === 'paused' && (
              <ModelChoice
                data={data}
                label="续跑模型"
                taskId={inferenceTasks.review}
                value={resumeModels[job.id] ?? job.profileId ?? ''}
                inheritLabel="沿用任务模型"
                inheritValue={job.profileId}
                personaId={job.personaId}
                onChange={(value) => setResumeModels({ ...resumeModels, [job.id]: value })}
              />
            )}
            {job.state === 'paused' && (
              <ReviewResume run={job} profileId={resumeModels[job.id] || job.profileId || undefined} act={act} />
            )}
            {job.state === 'completed' &&
              !job.applied &&
              (job.drafts.length > 0 || job.actions?.length > 0) && (
                <Button
                  onClick={() =>
                    act(async () => {
                      await rpc('review.apply', { id: job.id, confirmed: true });
                      await load();
                    }, t('记忆已纳入'))
                  }
                >
                  {' '}
                  {t('应用整理建议')}{' '}
                </Button>
              )}
          </div>
        </div>
      ))}
      {!jobs.length && (
        <Empty>{t('还没有整理记录。请在角色的自动化任务中配置并运行记忆整理。')}</Empty>
      )}
    </>
  );
}
function ChannelSettings() {
  const { role, editRole } = useApp();
  useEffect(() => {
    if (role) editRole(role, 7);
  }, [role?.id]);
  return null;
}
function AvatarSettings() {
  const { role, editRole } = useApp();
  useEffect(() => {
    if (role) editRole(role, 6);
  }, [role?.id]);
  return null;
}
function Diagnostics() {
  const { data, act } = useApp();
  const confirmAction = useConfirm();
  const [status, setStatus] = useState<any>(),
    [runs, setRuns] = useState<any[]>([]),
    [permissions, setPermissions] = useState<string[]>(data.mcpPermissions);
  const load = async () => {
    setStatus(await rpc('system.status'));
    setRuns(await rpc('runs.list'));
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <Title title={t('运行诊断')} />
      <div className="row toolbar">
        <Button secondary onClick={() => act(load, t('已刷新'))}>
          {' '}
          {t('刷新状态')}{' '}
        </Button>
      </div>
      <div className="metric-grid card">
        {[
          ['核心内存 RSS', ((status?.resources?.rss ?? 0) / 1048576).toFixed(1) + t(' MB')],
          ['JS 堆使用', ((status?.resources?.heapUsed ?? 0) / 1048576).toFixed(1) + t(' MB')],
          ['活动运行', status?.activeRuns ?? 0],
          ['事件订阅', status?.listeners ?? 0],
        ].map(([key, v]) => (
          <div key={String(key)}>
            <b>{v}</b>
            <small>{key}</small>
          </div>
        ))}
      </div>
      {status?.memoryIssue && (
        <div className="card">
          <h2>{t('最近的检索回退')}</h2>
          <p>{status.memoryIssue.message}</p>
          <small>{status.memoryIssue.at}</small>
        </div>
      )}
      <div className="card">
        <h2>{t('内建模块')}</h2>
        <div className="row wrap">
          {(status?.plugins ?? data.plugins)
            .filter((module: any) => module.builtin)
            .map((module: any) => (
              <div className="state-pill" key={module.id}>
                {t(module.name)} · {statusText(module.state)}
              </div>
            ))}
        </div>
      </div>
      <div className="card">
        <h2>{t('MCP 对外能力')}</h2>
        <p>{t('本机其他应用可通过 MCP 调用勾选的读取工具。由角色委派的子任务按任务单独授权。')}</p>
        <div className="row wrap mcp-permission-options">
          {[...new Set<string>([...(data.mcpAvailablePermissions ?? []), ...permissions])]
            .filter((permission) => permission.endsWith('.read'))
            .sort()
            .map((permission) => (
              <label className="inline-toggle" key={permission}>
                <input
                  type="checkbox"
                  checked={permissions.includes(permission)}
                  onChange={(e) =>
                    setPermissions(
                      e.target.checked
                        ? [...permissions, permission]
                        : permissions.filter((p) => p !== permission),
                    )
                  }
                />
                <span>{permission}</span>
              </label>
            ))}
        </div>
        <div className="panel-actions">
          <Button
            secondary
            onClick={() =>
              act(() => rpc('settings.save', {
                pluginId: 'mcp', value: { permissions: permissions.filter((permission) => permission.endsWith('.read')) },
              }))
            }
          >
            {' '}
            {t('保存开放范围')}{' '}
          </Button>
        </div>
      </div>
      <div className="card">
        <h2>{t('最近运行')}</h2>
        <details>
          <summary>{t('Extension points and providers')}</summary>
          {status?.extensionPoints?.map((p: any) => (
            <p key={p.id}>
              <b>{p.id}</b> · {p.owner} · {p.cardinality}
            </p>
          ))}
          {status?.providers?.map((p: any) => (
            <p key={p.point + p.id}>
              {p.id} → {p.point} · {p.state}
            </p>
          ))}
        </details>
        {runs.map((run) => (
          <div className="run-row" key={run.id}>
            <div>
              <b>
                {run.source} · {statusText(run.state)}
              </b>
              <small>{new Date(run.createdAt).toLocaleString(locale())}</small>
              {run.error && <p className="warning">{run.error}</p>}
            </div>
            {run.state === 'unknown' && (
              <div className="row wrap">
                <Button
                  secondary
                  onClick={() =>
                    act(async () => {
                      await rpc('runs.reconcile', { id: run.id });
                      await load();
                    }, t('核对完成'))
                  }
                >
                  {' '}
                  {t('核对后端')}{' '}
                </Button>
                <Button
                  secondary
                  onClick={async () => {
                    if (
                      await confirmAction({
                        title: t('确认已核对外部结果？'),
                        description: t('结束这条未知运行，不会重新投递或重发消息。'),
                        confirmLabel: t('确认处理'),
                      })
                    )
                      void act(async () => {
                        await rpc('runs.resolve', { id: run.id, confirmed: true });
                        await load();
                      });
                  }}
                >
                  {' '}
                  {t('人工确认处理')}{' '}
                </Button>
              </div>
            )}
          </div>
        ))}
        {!runs.length && <Empty>{t('还没有模型运行。')}</Empty>}
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
