import { libraryLabel } from './library-label.ts';
import { locale } from './i18n.ts';
import { t } from './i18n.ts';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { KnowledgeCollection } from '../../../packages/contracts/knowledge-collections.ts';
import { rpc } from './client.ts';
import { collectionPaths, KnowledgeTree } from './knowledge-tree.tsx';
import { KnowledgeSearch } from './knowledge-search.tsx';
import {
  Button,
  EmptyState,
  Icon,
  PathInput,
  sameData,
  useUnsavedChanges,
  requestNavigation,
  useConfirm,
} from './ui.tsx';
const Body = lazy(() => import('./knowledge-body.tsx'));
const kinds: Record<string, string> = {
  knowledge: '知识',
  persona: '人格',
  memory: '记忆',
  observation: '观察',
  review: '记忆整理',
};
export type KnowledgeSelection = { vaultId?: string; documentId?: string; collectionId?: string };

export function KnowledgeView({
  data,
  act,
  setPage,
  fixedSelection,
}: {
  data: any;
  act: any;
  setPage: any;
  fixedSelection?: KnowledgeSelection;
}) {
  const confirm = useConfirm();
  const [items, setItems] = useState<any[]>([]),
    [vault, setVault] = useState(
      fixedSelection?.vaultId ?? data.vaults.find((v: any) => !v.owner)?.id ?? '',
    ),
    [panel, setPanel] = useState(''),
    [source, setSource] = useState(''),
    [importMode, setImportMode] = useState('parse'),
    [importParser, setImportParser] = useState(''),
    [importFolder, setImportFolder] = useState(''),
    [path, setPath] = useState(''),
    [query, setQuery] = useState(''),
    [kind, setKind] = useState(''),
    [hits, setHits] = useState<any[] | undefined>(),
    [selected, setSelected] = useState<any>(),
    [reading, setReading] = useState(false),
    [draft, setDraft] = useState<any>(),
    [exportPath, setExportPath] = useState(''),
    [exportMode, setExportMode] = useState('bundle'),
    [folder, setFolder] = useState(''),
    [initialCollection, setInitialCollection] = useState(fixedSelection?.collectionId),
    [catalog, setCatalog] = useState<{ vault: string; nodes: KnowledgeCollection[] }>(),
    [members, setMembers] = useState<{
      vault: string;
      collectionId: string;
      documentIds: string[];
    }>(),
    [collectionRevision, refreshCollections] = useState(0),
    [showFolders, setShowFolders] = useState(true),
    [searchOptions, setSearchOptions] = useState<any>({
      strategy:
        fixedSelection && data.plugins.some((p: any) => p.id === 'semantic' && p.enabled)
          ? 'semantic'
          : (data.pluginSettings.knowledge?.strategy ?? 'keyword'),
      semanticWeight: 0.7,
      queries: [],
      kind: '',
    }),
    [archive, setArchive] = useState(false),
    [checked, setChecked] = useState<string[]>([]),
    [destination, setDestination] = useState(''),
    [jobs, setJobs] = useState<any[]>([]),
    [sourceState, setSourceState] = useState<any>(),
    [revisions, setRevisions] = useState<any[]>([]),
    [repair, setRepair] = useState(''),
    [issue, setIssue] = useState(''),
    [listPage, setListPage] = useState(0);
  useEffect(() => {
    if (!vault) setVault(data.vaults.find((v: any) => !v.owner)?.id ?? '');
  }, [data.vaults, vault]);
  const baseline = useRef<any>(undefined),
    readVersion = useRef(0),
    searchVersion = useRef(0);
  const activeVault = data.vaults.find((v: any) => v.id === vault),
    editable = !activeVault?.owner;
  const collectionTree = useMemo(
    () => collectionPaths(catalog?.vault === vault ? catalog!.nodes : []),
    [catalog, vault],
  );
  useEffect(() => {
    if (!initialCollection || catalog?.vault !== vault) return;
    const path = [...collectionTree].find(([, node]) => node.id === initialCollection)?.[0];
    if (path) setFolder(path);
    setInitialCollection(undefined);
  }, [initialCollection, catalog, vault, collectionTree]);
  const grouped = collectionTree.size > 0;
  const collectionId = initialCollection ?? collectionTree.get(folder)?.id;
  const memberIds = collectionId
    ? new Set(
        members && members.vault === vault && members.collectionId === collectionId
          ? members.documentIds
          : [],
      )
    : undefined;
  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    void rpc('knowledge.collections', { vaultId: vault })
      .then((result) => {
        if (!cancelled) setCatalog({ vault, nodes: result.nodes });
      })
      .catch((error) => {
        if (!cancelled) setIssue(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [vault, collectionRevision]);
  useEffect(() => {
    if (!collectionId) return;
    let cancelled = false;
    void rpc('knowledge.collections', { vaultId: vault, collectionId })
      .then((result) => {
        if (!cancelled) setMembers({ vault, collectionId, documentIds: result.documentIds ?? [] });
      })
      .catch((error) => {
        if (!cancelled) setIssue(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [vault, collectionId, collectionRevision]);
  useEffect(() => {
    if (grouped && folder && !collectionId) setFolder('');
  }, [grouped, folder, collectionId]);
  useEffect(() => {
    const update = (event: any) => {
      const type = event.detail.type;
      if (
        !['knowledge.collections.updated', 'knowledge.updated', 'connection.ready'].includes(type)
      )
        return;
      if (event.detail.data?.vaultId && event.detail.data.vaultId !== vault) return;
      if (type === 'knowledge.collections.updated') {
        searchVersion.current++;
        setHits(undefined);
      }
      refreshCollections((n) => n + 1);
    };
    window.addEventListener('echo-event', update);
    return () => window.removeEventListener('echo-event', update);
  }, [vault]);
  const parsers = data.providers.filter(
    (p: any) => p.point === 'files.extract@1' && p.state === 'active',
  );
  const scope = {
    vaultId: vault,
    kind: kind || 'all',
    collectionId,
    folder: grouped ? undefined : folder || undefined,
    folderExact: !grouped && (searchOptions.folderExact ?? false),
    archived: archive,
  };
  useEffect(() => {
    searchVersion.current++;
    setHits(undefined);
  }, [vault, kind, folder, collectionId, archive, searchOptions.folderExact]);
  const load = async () => {
    const [items, jobs] = await Promise.all([rpc('knowledge.list', {}), rpc('knowledge.jobs', {})]);
    setItems(items);
    setJobs(jobs);
  };
  useEffect(() => {
    void load().catch((e) => setIssue(e.message));
  }, []);
  const working = jobs.some((j) => ['running', 'queued'].includes(j.state));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = (e: any) => {
      if (['knowledge.updated', 'connection.ready'].includes(e.detail.type)) {
        clearTimeout(timer);
        timer = setTimeout(() => void load().catch((e) => setIssue(e.message)), 100);
      }
    };
    window.addEventListener('echo-event', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('echo-event', update);
    };
  }, []);
  useUnsavedChanges(Boolean(draft && !sameData(draft, baseline.current)), '知识正文');
  const read = async (item: any) => {
    const version = ++readVersion.current;
    setReading(true);
    const result = await act(
      () =>
        rpc('knowledge.read', {
          id: item.documentId ?? item.id,
          vaultId: item.vaultId ?? vault,
          offset: item.offset ?? 0,
        }),
      '',
    );
    if (version === readVersion.current) {
      if (result) setSelected(result);
      setReading(false);
    }
  };
  const openPanel = (next: string) =>
    requestNavigation(() => {
      setDraft(undefined);
      if (next === 'import') setImportFolder(folder);
      setPanel(next);
    });
  useEffect(() => {
    if (fixedSelection) {
      if (fixedSelection.documentId)
        void read({ id: fixedSelection.documentId, vaultId: fixedSelection.vaultId });
      return;
    }
    const apply = () => {
      const saved = sessionStorage.getItem('echo.knowledge.open');
      if (!saved) return;
      sessionStorage.removeItem('echo.knowledge.open');
      try {
        const selected = JSON.parse(saved);
        if (selected.vaultId) {
          setVault(selected.vaultId);
          setFolder('');
        }
        if (selected.documentId) void read({ id: selected.documentId, vaultId: selected.vaultId });
      } catch {}
    };
    apply();
    window.addEventListener('echo:selection', apply);
    return () => window.removeEventListener('echo:selection', apply);
  }, []);
  const begin = () =>
    requestNavigation(() => {
      const initial = {
        title: '',
        text: '',
        vaultId: vault,
        path: folder ? folder + '/' + crypto.randomUUID() + '.md' : undefined,
      };
      baseline.current = initial;
      setDraft(initial);
      setPanel('edit');
    });
  const filtered = items.filter(
    (item) =>
      (!vault || item.vaultId === vault) &&
      (!kind || item.kind === kind) &&
      Boolean(item.metadata?.archived) === archive &&
      (grouped
        ? !memberIds || memberIds.has(item.id)
        : !folder ||
          (searchOptions.folderExact
            ? (item.logicalPath ?? '').split('/').slice(0, -1).join('/') === folder
            : (item.logicalPath ?? '').startsWith(folder + '/'))),
  );
  const displayPath = (path: string) => {
    if (collectionTree.has(path)) {
      return path
        .split('/')
        .map((_, i, parts) => collectionTree.get(parts.slice(0, i + 1).join('/'))?.title ?? '')
        .join(' / ');
    }
    const parts = path.split('/');
    return parts
      .map((part, n) => {
        if (parts[0] === 'Personas') {
          if (n === 0) return t('角色档案');
          if (n === 1) return data.personas.find((p: any) => p.id === part)?.name ?? t('角色');
          if (part === 'Memory') return t('角色记忆');
          if (part === 'Reviews') return t('记忆整理报告');
        }
        return part;
      })
      .join(' / ');
  };
  const docs = hits ?? filtered;
  useEffect(() => setListPage(0), [vault, kind, folder, archive, hits]);
  const folders = grouped
    ? [...collectionTree.keys()]
    : ([
        ...new Set(
          items
            .filter((i) => i.vaultId === vault && Boolean(i.metadata?.archived) === archive)
            .flatMap((i) => {
              const parts = (i.logicalPath ?? '').split('/').slice(0, -1);
              return parts.map((_: string, n: number) => parts.slice(0, n + 1).join('/'));
            }),
        ),
      ].sort() as string[]);
  const maintain = async (action: string) => {
    if (!checked.length) return;
    if (
      !(await confirm({
        title: action === 'delete' ? t('永久删除所选知识？') : t('更新所选条目？'),
        description:
          action === 'delete'
            ? t('删除正文、历史版本和附件关联。已保存的原件仍保留。')
            : t('将更新所选条目的目录或归档状态。'),
        confirmLabel: action === 'delete' ? t('永久删除') : t('确认'),
        danger: action === 'delete',
      }))
    )
      return;
    const result = await act(
      () =>
        rpc('knowledge.maintain', {
          vaultId: vault,
          items: checked.map((id) => {
            const item = items.find((i) => i.id === id && i.vaultId === vault);
            return { id, revision: item.revision };
          }),
          action,
          folder: destination,
          confirmed: true,
        }),
      t('条目已更新'),
    );
    if (result) {
      setChecked([]);
      setSelected(undefined);
      await load();
    }
  };

  return (
    <div className="knowledge-page">
      {!fixedSelection && (
        <div className="page-title page-title-actions">
          <div>
            <h1>
              {activeVault?.owner ? libraryLabel(activeVault, data.plugins) : t('个人知识库')}
            </h1>
          </div>
          <div className="row">
            <Button secondary onClick={begin} disabled={!vault || !editable}>
              <Icon name="plus" size={15} />
              {t('新建笔记')}
            </Button>
            <Button
              disabled={!vault || !editable}
              onClick={() => openPanel(panel === 'import' ? '' : 'import')}
            >
              <Icon name="files" size={15} />
              {t('导入原件')}
            </Button>
          </div>
        </div>
      )}
      <div className="library-toolbar">
        {!fixedSelection && (
          <select
            aria-label={t('当前知识库')}
            value={vault}
            onChange={(e) => {
              const next = e.target.value;
              requestNavigation(() => {
                readVersion.current++;
                searchVersion.current++;
                setReading(false);
                setVault(next);
                setKind('');
                setArchive(false);
                setPanel('');
                setDraft(undefined);
                setSearchOptions((old: any) => ({
                  ...old,
                  kind: '',
                  queries: [],
                  boostFolder: '',
                }));
                setFolder('');
                setChecked([]);
                setQuery('');
                setHits(undefined);
                setSelected(undefined);
              });
            }}
          >
            {data.vaults
              .filter((v: any) => !v.owner || v.id === vault)
              .map((v: any) => (
                <option key={v.id} value={v.id}>
                  {libraryLabel(v, data.plugins)}
                </option>
              ))}
          </select>
        )}
        <form
          className="search-control"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim() || searchOptions.queries.some((q: any) => q.text.trim()))
              void act(async () => {
                const current = ++searchVersion.current;
                const results = await rpc('knowledge.searchAdvanced', {
                  query: query.trim() || searchOptions.queries.map((q: any) => q.text).join('; '),
                  ...scope,
                  strategy: searchOptions.strategy,
                  semanticWeight: searchOptions.semanticWeight,
                  queries: searchOptions.queries.filter((q: any) => q.text.trim()),
                  rerank: searchOptions.rerank ?? false,
                  directoryBoost:
                    !grouped && searchOptions.boostFolder
                      ? {
                          folder: searchOptions.boostFolder,
                          weight: searchOptions.boostWeight ?? 1,
                        }
                      : undefined,
                });
                if (current === searchVersion.current) setHits(results);
              }, t('检索完成'));
            else setHits(undefined);
          }}
        >
          <Icon name="search" size={16} />
          <input
            aria-label={t('知识检索词')}
            placeholder={t('搜索当前知识库…')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              searchVersion.current++;
              setHits(undefined);
            }}
          />
          <button
            className="text-button"
            type="submit"
            disabled={!query.trim() && !searchOptions.queries.some((q: any) => q.text.trim())}
          >
            {t('检索')}
          </button>
        </form>
        {!fixedSelection && (
          <button
            className="secondary"
            onClick={() => openPanel(panel === 'libraries' ? '' : 'libraries')}
          >
            {t('库管理')}
          </button>
        )}
        <button
          className="secondary"
          onClick={() => openPanel(panel === 'export' ? '' : 'export')}
          disabled={!vault}
        >
          {t('导出')}
        </button>
      </div>
      <KnowledgeSearch
        data={data}
        scope={scope}
        grouped={grouped}
        query={query}
        options={{ ...searchOptions, kind }}
        kinds={kinds}
        act={act}
        setPage={setPage}
        onChange={(next: any) => {
          setSearchOptions(next);
          setKind(next.kind ?? '');
          setHits(undefined);
        }}
      />
      {!fixedSelection && !editable && (
        <div className="managed-library-note">
          <span>{t('此库由插件管理，正文与结构通过所属功能修改。')}</span>
          <Button
            secondary
            onClick={() =>
              setPage(
                (
                  {
                    persona: 'personas',
                    memory: 'memory',
                    observation: 'observation',
                    review: 'review',
                    assets: 'assets',
                  } as any
                )[activeVault.owner] ?? 'plugins',
              )
            }
          >
            {t('打开管理入口')}
          </Button>
        </div>
      )}
      {panel === 'import' && (
        <div className="card operation-panel">
          <div className="row between">
            <h2>{t('导入原件')}</h2>
            <button
              className="icon-button"
              aria-label={t('关闭导入面板')}
              onClick={() => setPanel('')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <p className="muted">
            {t('每份原件对应一个知识包。启用文档解析后可处理 PDF 和 Office。')}
          </p>
          <div className="form-grid">
            <PathInput label={t('材料文件路径')} value={source} onChange={setSource} />
            {importMode === 'parse' && (
              <label className="field">
                <span>{t('目标目录')}</span>
                <input
                  aria-label={t('目标目录')}
                  value={importFolder}
                  onChange={(event) => setImportFolder(event.target.value)}
                  list="knowledge-import-folders"
                  placeholder={t('根目录')}
                />
                <datalist id="knowledge-import-folders">
                  {folders.map((path) => <option key={path} value={path} />)}
                </datalist>
                <small>{libraryLabel(activeVault, data.plugins)} / {importFolder || t('根目录')}</small>
              </label>
            )}
            <label className="field">
              <span>{t('导入方式')}</span>
              <select value={importMode} onChange={(event) => setImportMode(event.target.value)}>
                <option value="parse">{t('保存并解析')}</option>
                <option value="archive">{t('只保存原件')}</option>
              </select>
            </label>
            {importMode === 'parse' && parsers.length > 0 && (
              <label className="field">
                <span>{t('文档解析器')}</span>
                <select
                  value={importParser}
                  onChange={(event) => setImportParser(event.target.value)}
                >
                  <option value="">{t('使用默认解析器')}</option>
                  {parsers.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {t(p.label)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="row">
            <Button
              disabled={!source.trim() || !vault}
              onClick={() =>
                act(
                  async () => {
                    if (importMode === 'archive') {
                      await rpc('files.import', { vaultId: vault, source });
                      setSource('');
                      setPanel('');
                      return;
                    }
                    const item = await rpc('knowledge.import-job', {
                      vaultId: vault,
                      source,
                      requestId: crypto.randomUUID(),
                      parserProvider: importParser || undefined,
                      folder: importFolder,
                    });
                    await load();
                    if (item?.state === 'completed')
                      await read({ id: item.documentId, vaultId: item.vaultId });
                    setSource('');
                    setPanel('');
                  },
                  importMode === 'archive' ? t('原件已保存') : t('解析任务已创建'),
                )
              }
            >
              {t('导入')}
            </Button>
          </div>
        </div>
      )}
      {panel === 'libraries' && (
        <div className="card operation-panel">
          <div className="row between">
            <h2>{t('知识库目录')}</h2>
            <button
              className="icon-button"
              aria-label={t('关闭库管理面板')}
              onClick={() => setPanel('')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="library-roots">
            {data.vaults
              .filter((v: any) => !v.owner)
              .map((v: any) => (
                <div className="vault" key={v.id}>
                  <Icon name="files" size={18} />
                  <div>
                    <b>{v.name}</b>
                    <small>{v.path}</small>
                  </div>
                </div>
              ))}
          </div>
          <div className="inline-form">
            <PathInput label={t('新知识库目录')} value={path} onChange={setPath} directory />
            <Button
              secondary
              disabled={!path.trim()}
              onClick={() =>
                act(async () => {
                  const root = await rpc('files.register', {
                    id: crypto.randomUUID(),
                    name: path.split(/[\\/]/).filter(Boolean).at(-1) || '知识库',
                    path,
                  });
                  setVault(root.id);
                  setPath('');
                  await load();
                }, t('目录已注册'))
              }
            >
              {t('注册目录')}
            </Button>
          </div>
          <details className="library-advanced">
            <summary>{t('解析与检索提供方')}</summary>
            <div className="form-grid">
              {(['retrievalProvider', 'parserProvider'] as const).map((key) => (
                <label className="field" key={key}>
                  <span>{key === 'retrievalProvider' ? t('检索提供方') : t('文档解析器')}</span>
                  <select
                    value={data.pluginSettings.knowledge?.[key] ?? ''}
                    onChange={(e) =>
                      act(() =>
                        rpc('settings.save', {
                          pluginId: 'knowledge',
                          value: { ...data.pluginSettings.knowledge, [key]: e.target.value },
                        }),
                      )
                    }
                  >
                    <option value="">{t('自动选择可用提供方')}</option>
                    {data.providers
                      .filter(
                        (p: any) =>
                          p.point ===
                            (key === 'retrievalProvider'
                              ? 'core.retrieval@1'
                              : 'files.extract@1') && p.state === 'active',
                      )
                      .map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {t(p.label)}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </div>
          </details>
        </div>
      )}
      {panel === 'export' && (
        <div className="card operation-panel">
          <div className="row between">
            <h2>{t('导出知识库')}</h2>
            <button
              className="icon-button"
              aria-label={t('关闭导出面板')}
              onClick={() => setPanel('')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <p className="muted">{t('默认只导出普通知识与附件，不包含人格、记忆和观察档案。')}</p>
          <div className="inline-form">
            <select
              aria-label={t('Knowledge export format')}
              value={exportMode}
              onChange={(e) => setExportMode(e.target.value)}
            >
              <option value="bundle">{t('可独立打开的知识库')}</option>
              <option value="markdown">{t('Markdown 与附件')}</option>
            </select>
            <PathInput
              label={t('Knowledge export ZIP')}
              value={exportPath}
              onChange={setExportPath}
              save
            />
            <Button
              disabled={!exportPath.trim()}
              onClick={() =>
                act(
                  () =>
                    rpc('knowledge.export', {
                      vaultId: vault,
                      destination: exportPath,
                      mode: exportMode,
                    }),
                  t('已导出'),
                )
              }
            >
              {t('Export')}
            </Button>
          </div>
        </div>
      )}
      {panel === 'edit' && draft && (
        <div className="card operation-panel">
          <h2>{draft.id ? t('编辑知识正文') : t('新建笔记')}</h2>
          <label className="field">
            <span>{t('标题')}</span>
            <input
              aria-label={t('知识标题')}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('Markdown 正文')}</span>
            <textarea
              rows={12}
              aria-label={t('知识正文')}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </label>
          <div className="form-actions">
            <Button
              disabled={!draft.title.trim()}
              onClick={async () => {
                const result = await act(() => rpc('knowledge.save', draft), t('知识已保存'));
                if (result) {
                  setDraft(undefined);
                  setPanel('');
                  await load();
                  await read(result);
                }
              }}
            >
              {t('保存正文')}
            </Button>
            <Button
              secondary
              onClick={() => {
                setDraft(undefined);
                setPanel('');
              }}
            >
              {t('取消')}
            </Button>
          </div>
        </div>
      )}
      {issue && (
        <div className="error" role="alert">
          {issue}
        </div>
      )}
      {jobs.some((j) => j.vaultId === vault) && (
        <details className="parse-jobs" open={working}>
          <summary>
            {t('文档解析任务')} {working && <span className="spinner" />}
          </summary>
          {jobs
            .filter((j) => j.vaultId === vault)
            .slice(-10)
            .reverse()
            .map((j) => (
              <div className="row between" key={j.id}>
                <span>
                  {j.original?.name} ·{' '}
                  {t(
                    (
                      {
                        queued: '排队中',
                        running: '解析中',
                        completed: '已完成',
                        paused: '已暂停',
                        failed: '失败',
                      } as any
                    )[j.state],
                  )}
                  {j.error && <small className="warning">{j.error}</small>}
                  {j.state === 'completed' && <small>
                    {t('导入位置')} · {items.find((item) => item.id === j.documentId && item.vaultId === j.vaultId)?.logicalPath?.split('/').slice(0, -1).join(' / ') || t('根目录')}
                  </small>}
                </span>
                {j.state === 'completed' && (
                  <Button secondary onClick={() => {
                    const item = items.find((item) => item.id === j.documentId && item.vaultId === j.vaultId);
                    if (item) {
                      setFolder(item.logicalPath?.split('/').slice(0, -1).join('/') || '');
                      setHits(undefined);
                      setArchive(false);
                    }
                    void read({ id: j.documentId, vaultId: j.vaultId });
                  }}>{t('查看条目')}</Button>
                )}
                {['paused', 'failed'].includes(j.state) && (
                  <Button
                    secondary
                    onClick={() =>
                      act(async () => {
                        await rpc('knowledge.resume', { id: j.id });
                        await load();
                      }, t('已继续解析'))
                    }
                  >
                    {t('继续')}
                  </Button>
                )}
              </div>
            ))}
        </details>
      )}
      {checked.length > 0 && (
        <div className="selection-toolbar">
          <strong>
            {t('已选择')} {checked.length}
          </strong>
          <input
            aria-label={t('移动到目录')}
            placeholder={t('目标目录，斜杠分级')}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
          <Button secondary onClick={() => maintain('move')}>
            {t('移动')}
          </Button>
          <Button secondary onClick={() => maintain(archive ? 'restore' : 'archive')}>
            {archive ? t('恢复') : t('归档')}
          </Button>
          {archive && (
            <Button secondary onClick={() => maintain('delete')}>
              {t('永久删除')}
            </Button>
          )}
        </div>
      )}
      {selected && panel === 'source' && (
        <div className="card operation-panel">
          <div className="row between">
            <h2>{t('来源与历史版本')}</h2>
            <button className="icon-button" aria-label={t('关闭')} onClick={() => setPanel('')}>
              <Icon name="close" />
            </button>
          </div>
          <p className="reader-path">{selected.source || t('独立笔记')}</p>
          <p>
            {sourceState
              ? t(
                  (
                    {
                      current: '原件未变化',
                      changed: '源文件已变化',
                      missing: '源文件已移走',
                      unavailable: '暂不可读取',
                      oversize: '文件超过读取限制',
                      managed: '由来源插件维护',
                      note: '独立笔记',
                    } as any
                  )[sourceState.state],
                )
              : t('正在检查…')}
          </p>
          {sourceState?.sourceChanged && (
            <p className="warning">{t('原库来源已更新，迁移保留了原知识正文和当前原件。')}</p>
          )}
          {sourceState?.state === 'missing' && (
            <div className="inline-form">
              <PathInput label={t('新的原件路径')} value={repair} onChange={setRepair} />
              <Button
                disabled={!repair}
                onClick={() =>
                  act(async () => {
                    await rpc('knowledge.rebind', {
                      vaultId: selected.vaultId,
                      id: selected.id,
                      revision: selected.revision,
                      source: repair,
                    });
                    setPanel('');
                    await load();
                    await read(selected);
                  }, t('来源路径已修复'))
                }
              >
                {t('修复路径')}
              </Button>
            </div>
          )}
          {sourceState?.state === 'changed' && (
            <Button
              onClick={() =>
                act(async () => {
                  await rpc('knowledge.import-job', {
                    vaultId: selected.vaultId,
                    source: selected.source,
                    requestId: crypto.randomUUID(),
                  });
                  await load();
                }, t('解析任务已创建'))
              }
            >
              {t('重新解析原件')}
            </Button>
          )}
          <div className="revision-list">
            {revisions.map((r) => (
              <div className="row between" key={r.revision}>
                <span>
                  v{r.revision} · {new Date(r.updatedAt).toLocaleString(locale())} ·{' '}
                  {r.chars.toLocaleString(locale())} {t('字符')}
                </span>
                {editable && r.revision !== selected.revision && !selected.metadata?.producer && (
                  <button
                    className="text-button"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: t('恢复这个历史版本？'),
                          description: t('将建立一个新版本，当前版本仍会保留。'),
                          confirmLabel: t('恢复'),
                        })
                      )
                        await act(async () => {
                          await rpc('knowledge.restore-revision', {
                            vaultId: selected.vaultId,
                            id: selected.id,
                            revision: selected.revision,
                            targetRevision: r.revision,
                            confirmed: true,
                          });
                          await load();
                          await read(selected);
                          setPanel('');
                        }, t('已恢复'));
                    }}
                  >
                    {t('恢复')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="knowledge-location">
        <button className="text-button" onClick={() => setShowFolders(!showFolders)}>
          {showFolders ? t('隐藏目录树') : t('显示目录树')}
        </button>
        <span>{folder ? displayPath(folder) : t(grouped ? '全部文献' : '全部目录')}</span>
      </div>
      <div className={'library-layout knowledge-browser ' + (!showFolders ? 'folders-hidden' : '')}>
        {showFolders && (
          <aside className="card folder-tree">
            <select
              className="folder-compact"
              aria-label={t(grouped ? '知识分组' : '知识目录')}
              value={folder}
              onChange={(e) => {
                setFolder(e.target.value);
                setHits(undefined);
                setChecked([]);
              }}
            >
              <option value="">{t(grouped ? '全部文献' : '全部目录')}</option>
              {folders.map((path) => (
                <option key={path} value={path}>
                  {displayPath(path)}
                </option>
              ))}
            </select>
            <KnowledgeTree
              folders={folders}
              selected={folder}
              vault={vault}
              label={displayPath}
              grouped={grouped}
              leafLabel={
                grouped
                  ? (path) => {
                      const node = collectionTree.get(path);
                      return (node?.title ?? path) + (node?.snapshot ? ' · ' + t('成员快照') : '');
                    }
                  : undefined
              }
              onSelect={(path) => {
                setFolder(path);
                setHits(undefined);
                setChecked([]);
              }}
            />
            <button
              className={'archive-folder ' + (archive ? 'selected' : '')}
              onClick={() => {
                setArchive(!archive);
                setFolder('');
                setHits(undefined);
                setChecked([]);
              }}
            >
              {archive ? t('返回当前条目') : t('归档条目')}
            </button>
          </aside>
        )}
        <div className="card library-list">
          <div className="list-heading">
            <h2>{hits ? t('检索结果') : t('条目')}</h2>
            <span className="count-badge">{docs.length}</span>
            {hits && (
              <button
                className="text-button"
                onClick={() => {
                  setHits(undefined);
                  setQuery('');
                }}
              >
                {t('返回全部')}
              </button>
            )}
          </div>
          {docs.slice(listPage * 100, (listPage + 1) * 100).map((item: any) => (
            <div className="knowledge-select-row" key={(item.vaultId ?? vault) + ':' + item.id}>
              {!hits && editable && (
                <input
                  type="checkbox"
                  aria-label={t('选择条目') + ' ' + item.title}
                  checked={checked.includes(item.id)}
                  onChange={(e) =>
                    setChecked(
                      e.target.checked
                        ? [...checked, item.id].slice(0, 100)
                        : checked.filter((id) => id !== item.id),
                    )
                  }
                />
              )}
              <button
                className={
                  'document-row ' +
                  (selected?.id === (item.documentId ?? item.id) &&
                  selected?.vaultId === (item.vaultId ?? vault)
                    ? 'selected'
                    : '')
                }
                key={(item.vaultId ?? vault) + ':' + item.id}
                onClick={() =>
                  requestNavigation(() => {
                    setDraft(undefined);
                    setPanel('');
                    void read(item);
                  })
                }
              >
                <span className="document-icon">
                  <Icon
                    name={
                      item.kind === 'observation'
                        ? 'observation'
                        : item.kind === 'memory'
                          ? 'memory'
                          : 'knowledge'
                    }
                    size={20}
                  />
                </span>
                <div>
                  <b>
                    {item.title ??
                      items.find((d) => d.id === item.documentId)?.title ??
                      t('知识片段')}
                  </b>
                  <small>
                    {item.logicalPath
                      ? displayPath(item.logicalPath.split('/').slice(0, -1).join('/')) ||
                        t(kinds[item.kind] ?? '知识')
                      : t(kinds[item.kind] ?? '检索结果')}
                    {item.revision ? t(' · v') + item.revision : ''}
                    {item.method ? ' · ' + item.method + ' · ' + Number(item.score).toFixed(3) : ''}
                  </small>
                  {hits && <p>{item.text?.slice(0, 140)}</p>}
                </div>
                <Icon name="chevron" size={13} />
              </button>
            </div>
          ))}
          {docs.length > 100 && (
            <div className="table-pagination">
              <Button secondary disabled={listPage === 0} onClick={() => setListPage(listPage - 1)}>
                {t('上一页')}
              </Button>
              <span>
                {listPage + 1} / {Math.ceil(docs.length / 100)}
              </span>
              <Button
                secondary
                disabled={(listPage + 1) * 100 >= docs.length}
                onClick={() => setListPage(listPage + 1)}
              >
                {t('下一页')}
              </Button>
            </div>
          )}
          {!docs.length && (
            <EmptyState title={hits ? t('没有找到相关内容') : t('这里还没有条目')} icon="knowledge">
              {hits ? t('换个检索词，或检查检索提供方配置。') : t('导入一份原件，或创建一篇笔记。')}
            </EmptyState>
          )}
        </div>
        <div className="card document-reader">
          {reading ? (
            <div className="chat-loading">
              <span className="spinner" />
              {t('正在读取正文')}
            </div>
          ) : selected ? (
            <>
              <div className="reader-title">
                <div>
                  <span className="eyebrow">
                    {t(kinds[selected.kind] ?? selected.kind)} {t('· v')}
                    {selected.revision}
                  </span>
                  <h2>{selected.title}</h2>
                </div>
                <div className="row">
                  <button
                    className="text-button"
                    onClick={() =>
                      act(async () => {
                        const [state, revisions] = await Promise.all([
                          rpc('knowledge.source', { vaultId: selected.vaultId, id: selected.id }),
                          rpc('knowledge.revisions', {
                            vaultId: selected.vaultId,
                            id: selected.id,
                          }),
                        ]);
                        setSourceState(state);
                        setRevisions(revisions);
                        setRepair('');
                        setPanel('source');
                      }, '')
                    }
                  >
                    {t('来源与版本')}
                  </button>
                  {editable && selected.kind === 'knowledge' && !selected.metadata?.producer && (
                    <button
                      className="text-button"
                      disabled={
                        selected.content.length !== selected.totalChars ||
                        selected.totalChars > 1000000
                      }
                      title={
                        selected.content.length !== selected.totalChars
                          ? t('先读取完整正文后再编辑')
                          : ''
                      }
                      onClick={() => {
                        const initial = {
                          id: selected.id,
                          vaultId: selected.vaultId,
                          revision: selected.revision,
                          title: selected.title,
                          text: selected.content,
                        };
                        baseline.current = initial;
                        setDraft(initial);
                        setPanel('edit');
                      }}
                    >
                      {t('编辑')}
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={t('关闭知识正文')}
                    onClick={() => setSelected(undefined)}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              </div>
              <small className="reader-path">
                {selected.logicalPath
                  ? displayPath(selected.logicalPath.split('/').slice(0, -1).join('/'))
                  : (selected.source ?? '')}
              </small>
              <Suspense fallback={<p>{t('正在排版…')}</p>}>
                <Body
                  document={selected}
                  onOpenEntry={(entry: KnowledgeSelection) =>
                    setPage('knowledge', undefined, entry)
                  }
                />
              </Suspense>
              {selected.nextOffset !== null && (
                <div className="reader-footer">
                  <small>
                    {t('已读取')} {selected.content.length.toLocaleString(locale())} /{' '}
                    {selected.totalChars.toLocaleString(locale())} {t('字符')}
                  </small>
                  <Button
                    secondary
                    onClick={() =>
                      act(async () => {
                        const next = await rpc('knowledge.read', {
                          id: selected.id,
                          vaultId: selected.vaultId,
                          offset: selected.nextOffset,
                        });
                        setSelected({
                          ...next,
                          offset: 0,
                          content: selected.content + next.content,
                        });
                      }, t('已读取下一段'))
                    }
                  >
                    {t('继续读取')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState title={t('选择一个条目阅读')} icon="knowledge">
              {t('Markdown 正文与附件会显示在这里。')}
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
