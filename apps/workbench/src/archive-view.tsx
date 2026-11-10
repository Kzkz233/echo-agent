import { libraryLabel } from './library-label.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc, mediaURL } from './client.ts';
import { t, locale } from './i18n.ts';
import {
  Button,
  EmptyState,
  Icon,
  PathInput,
  requestNavigation,
  useUnsavedChanges,
  sameData,
} from './ui.tsx';
export function ArchiveView({ page, data, act }: any) {
  const assets = page === 'assets',
    [items, setItems] = useState<any[]>([]),
    [files, setFiles] = useState<any[]>([]),
    [vault, setVault] = useState(data.vaults[0]?.id ?? ''),
    [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0),
    [includeDerived, setIncludeDerived] = useState(false),
    [draft, setDraft] = useState<any>(),
    [preview, setPreview] = useState<any>(),
    [issue, setIssue] = useState(''),
    [loading, setLoading] = useState(true),
    [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const imageDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (preview) imageDialog.current?.showModal();
  }, [preview]);
  useEffect(() => {
    if (!vault && data.vaults[0]) setVault(data.vaults[0].id);
  }, [data.vaults, vault]);
  const dialog = useRef<HTMLDialogElement>(null),
    baseline = useRef<any>(undefined),
    version = useRef(0),
    imageVersion = useRef(0);
  useUnsavedChanges(
    Boolean(draft && !sameData(draft, baseline.current)),
    assets ? '素材导入' : '原件导入',
  );
  const load = useCallback(async () => {
    const v = ++version.current;
    setLoading(true);
    try {
      const result = assets
        ? await rpc('assets.list', { vaultId: vault || undefined, query })
        : await rpc('files.list', {
            vaultId: vault || undefined,
            query,
            offset,
            limit: 50,
            kind: includeDerived ? 'all' : 'source',
          });
      const f = assets ? result.map((a: any) => a.file) : result.items,
        a = assets ? result : result.items;
      if (v === version.current) {
        setFiles(f);
        setItems(a);
        setTotal(assets ? a.length : result.total);
        setIssue('');
      }
    } catch (e) {
      if (v === version.current) setIssue((e as Error).message);
    } finally {
      if (v === version.current) setLoading(false);
    }
  }, [assets, vault, query, offset, includeDerived]);
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout>;
    const update = (e: any) => {
      if (
        ['files.updated', 'assets.updated', 'files.roots.changed', 'connection.ready'].includes(
          e.detail.type,
        )
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 100);
      }
    };
    window.addEventListener('echo-event', update);
    return () => {
      version.current++;
      clearTimeout(timer);
      window.removeEventListener('echo-event', update);
    };
  }, [load]);
  const filtered = items.filter(
      (i) =>
        (!assets || files.some((f) => f.id === i.fileId)) &&
        (i.name + ' ' + (i.tags ?? []).join(' ')).toLowerCase().includes(query.toLowerCase()),
    ),
    visible = assets ? filtered.slice(offset, offset + 24) : filtered;
  useEffect(() => {
    if (!assets) return;
    const v = ++imageVersion.current;
    const queue = [...visible];
    let stopped = false;
    const work = async () => {
      while (queue.length && !stopped) {
        const item = queue.shift()!;
        if (thumbnails[item.id]) continue;
        try {
          const result = await rpc('assets.preview', { id: item.id, size: 192 });
          if (!stopped && v === imageVersion.current)
            setThumbnails((old) =>
              Object.fromEntries([...Object.entries(old).slice(-95), [item.id, result.data]]),
            );
        } catch {}
      }
    };
    void Promise.all([work(), work()]);
    return () => {
      stopped = true;
      imageVersion.current++;
    };
  }, [assets, items, query, offset, vault]);
  const begin = (kind = 'import') => {
    const initial = { kind, source: '', name: '', tags: '', path: '', vaultId: vault };
    baseline.current = initial;
    setDraft(initial);
    dialog.current?.showModal();
  };
  const open = async (item: any) => {
    if (assets) {
      const image = await act(() => rpc('assets.preview', { id: item.id }), '');
      if (image) setPreview(image);
    } else {
      const url = await act(() => mediaURL(item.vaultId, item.hash), '');
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = item.name;
        a.click();
      }
    }
  };
  return (
    <div className="archive-workspace">
      <div className="page-title page-title-actions">
        <h1>{t(assets ? '图片与表情素材' : '文件管理')}</h1>
        <div className="row">
          {!assets && (
            <Button secondary onClick={() => begin('root')}>
              {t('添加知识库')}
            </Button>
          )}
          <Button
            disabled={
              !data.vaults.length || Boolean(data.vaults.find((v: any) => v.id === vault)?.owner)
            }
            onClick={() => begin()}
          >
            <Icon name="plus" size={15} />
            {t(assets ? '导入素材' : '导入原件')}
          </Button>
        </div>
      </div>
      {!assets && (
        <p className="archive-description">
          {t('文件管理保存 PDF、Office、图片等来源文件；知识库保存整理后的正文，并关联这些原件。')}
        </p>
      )}
      <div className="content-toolbar">
        <label className="search-control">
          <Icon name="search" size={16} />
          <input
            aria-label={t(assets ? '查找素材' : '查找原件')}
            placeholder={t(assets ? '名称或标签' : '文件名称')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <select
          aria-label={t('当前知识库')}
          value={vault}
          onChange={(e) => {
            setVault(e.target.value);
            setOffset(0);
            setThumbnails({});
          }}
        >
          {data.vaults.map((v: any) => (
            <option key={v.id} value={v.id}>
              {libraryLabel(v, data.plugins)}
            </option>
          ))}
        </select>
        {!assets && (
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={includeDerived}
              onChange={(e) => {
                setIncludeDerived(e.target.checked);
                setOffset(0);
              }}
            />
            {t('显示派生文件')}
          </label>
        )}
      </div>
      {issue && (
        <div className="error" role="alert">
          {issue}
        </div>
      )}
      {assets ? (
        <div className="asset-gallery">
          {visible.map((item) => (
            <button className="asset-tile" key={item.id} onClick={() => void open(item)}>
              <div className="asset-thumbnail">
                {thumbnails[item.id] ? (
                  <img src={thumbnails[item.id]} alt="" loading="lazy" />
                ) : (
                  <Icon name="assets" size={28} />
                )}
              </div>
              <b>{item.name}</b>
              {item.tags.length > 0 && <small>{item.tags.join(' · ')}</small>}
            </button>
          ))}
        </div>
      ) : (
        <div className="data-table-scroll">
          <table className="archive-table">
            <thead>
              <tr>
                <th>{t('文件名称')}</th>
                <th>{t('类型')}</th>
                <th>{t('大小')}</th>
                <th>{t('保存时间')}</th>
                <th>
                  <span className="sr-only">{t('操作')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Icon name="files" size={17} />
                    <b>{item.name}</b>
                  </td>
                  <td>
                    {item.name.includes('.')
                      ? item.name.split('.').at(-1)?.toUpperCase()
                      : t('文件')}
                  </td>
                  <td>
                    {item.bytes >= 1048576
                      ? (item.bytes / 1048576).toFixed(1) + ' MB'
                      : Math.ceil(item.bytes / 1024) + ' KB'}
                  </td>
                  <td>{new Date(item.updatedAt).toLocaleDateString(locale())}</td>
                  <td>
                    <button className="text-button" onClick={() => void open(item)}>
                      {t('下载原件')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!filtered.length && !loading && (
        <EmptyState
          title={t(assets ? '还没有素材' : '还没有原件')}
          icon={assets ? 'assets' : 'files'}
        >
          {t(
            assets
              ? '导入图片，使用标签查找和预览。'
              : '导入的文件会保留原件，供知识与其他功能引用。',
          )}
        </EmptyState>
      )}
      {total > (assets ? 24 : 50) && (
        <div className="table-pagination">
          <Button
            secondary
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - (assets ? 24 : 50)))}
          >
            {t('上一页')}
          </Button>
          <span>
            {total} {t('项')}
          </span>
          <Button
            secondary
            disabled={offset + (assets ? 24 : 50) >= total}
            onClick={() => setOffset(offset + (assets ? 24 : 50))}
          >
            {t('下一页')}
          </Button>
        </div>
      )}
      <dialog
        className="workspace-drawer"
        ref={dialog}
        onClose={() => setDraft(undefined)}
        onCancel={(e) => {
          e.preventDefault();
          requestNavigation(() => dialog.current?.close());
        }}
      >
        <div className="drawer-heading">
          <h2>{t(draft?.kind === 'root' ? '添加知识库' : assets ? '导入素材' : '导入原件')}</h2>
          <button
            className="icon-button"
            aria-label={t('关闭')}
            onClick={() => requestNavigation(() => dialog.current?.close())}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        {draft && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await act(async () => {
                if (draft.kind === 'root')
                  return rpc('files.register', {
                    id: crypto.randomUUID(),
                    name: draft.name,
                    path: draft.path,
                  });
                return rpc(assets ? 'assets.import' : 'files.import', {
                  vaultId: draft.vaultId,
                  source: draft.source,
                  name: draft.name || undefined,
                  tags: draft.tags
                    .split(/[,，]/)
                    .map((s: string) => s.trim())
                    .filter(Boolean),
                });
              }, t('已保存'));
              if (result) {
                dialog.current?.close();
                await load();
              }
            }}
          >
            {draft.kind === 'root' ? (
              <>
                <label className="field">
                  <span>{t('知识库名称')}</span>
                  <input
                    value={draft.name}
                    required
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <PathInput
                  label={t('知识库目录')}
                  value={draft.path}
                  onChange={(path: string) => setDraft({ ...draft, path })}
                  directory
                />
              </>
            ) : (
              <>
                <label className="field">
                  <span>{t('当前知识库')}</span>
                  <select
                    value={draft.vaultId}
                    onChange={(e) => setDraft({ ...draft, vaultId: e.target.value })}
                  >
                    {data.vaults
                      .filter((v: any) => v.writePolicy !== 'plugin')
                      .map((v: any) => (
                        <option key={v.id} value={v.id}>
                          {libraryLabel(v, data.plugins)}
                        </option>
                      ))}
                  </select>
                </label>
                <PathInput
                  label={t('原件路径')}
                  value={draft.source}
                  onChange={(source: string) => setDraft({ ...draft, source })}
                />
                {assets && (
                  <>
                    <label className="field">
                      <span>{t('素材名称')}</span>
                      <input
                        value={draft.name}
                        placeholder={t('留空使用文件名')}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>{t('标签，逗号分隔')}</span>
                      <input
                        value={draft.tags}
                        onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                      />
                    </label>
                  </>
                )}
              </>
            )}
            <div className="form-actions">
              <Button
                type="submit"
                disabled={draft.kind === 'root' ? !draft.name || !draft.path : !draft.source}
              >
                {t('保存')}
              </Button>
              <Button secondary onClick={() => requestNavigation(() => dialog.current?.close())}>
                {t('取消')}
              </Button>
            </div>
          </form>
        )}
      </dialog>
      <dialog
        className="asset-preview-dialog"
        ref={imageDialog}
        onClose={() => setPreview(undefined)}
        onClick={(e) => {
          if (e.currentTarget === e.target) imageDialog.current?.close();
        }}
        aria-label={preview?.name ?? t('素材预览')}
      >
        <div className="drawer-heading">
          <h2>{preview?.name}</h2>
          <button
            className="icon-button"
            aria-label={t('关闭预览')}
            onClick={() => imageDialog.current?.close()}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        {preview && <img src={preview.data} alt={preview.name} />}
      </dialog>
    </div>
  );
}
