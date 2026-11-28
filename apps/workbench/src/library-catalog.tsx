import { AppTime } from './message-time.tsx';
import { CatalogBodySearch } from './catalog-body-search.tsx';
import { CatalogDocuments } from './catalog-documents.tsx';
import { useEffect, useMemo, useState } from 'react';
import type { FrontendPageEntry } from '../../../packages/contracts/frontend.ts';
import { catalogResult, type CatalogResult } from '../../../packages/contracts/library-catalog.ts';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { collectionPaths, KnowledgeTree } from './knowledge-tree.tsx';
import { Button } from './ui.tsx';
import './library-catalog.css';

type View = Extract<FrontendPageEntry['view'], { type: 'catalog' }>;
const limit = 25;
export function LibraryCatalog({
  page,
  data,
  perform,
  view,
  navigate,
}: {
  page: FrontendPageEntry;
  data: any;
  perform: (fn: () => Promise<any>, message?: string) => Promise<any>;
  view: View;
  navigate?: (page: string, selected?: string, selection?: any) => void;
}) {
  const [query, setQuery] = useState(''),
    [scope, setScope] = useState(''),
    [group, setGroup] = useState(''),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [result, setResult] = useState<CatalogResult>(),
    [busy, setBusy] = useState(true),
    [issue, setIssue] = useState(''),
    [open, setOpen] = useState(''),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    [showTree, setShowTree] = useState(true);
  const [mode, setMode] = useState<'catalog' | 'body'>('catalog');
  const [loadedPage, setLoadedPage] = useState('');
  const pageKey = JSON.stringify([page.id, scope, group, mode, offset]);
  const [force, setForce] = useState(false);
  const refresh = () => {
    setForce(true);
    setRevision((n) => n + 1);
  };
  useEffect(() => {
    let current = true;
    setBusy(true);
    setIssue('');
    const timer = setTimeout(
      () => {
        void rpc('frontend.invoke', {
          pageId: page.id,
          operation: view.load,
          input: {
            query: mode === 'body' ? '' : query,
            documentsOnly: mode === 'body' || undefined,
            scope: scope || undefined,
            group: group || undefined,
            offset,
            limit,
            refresh: force,
          },
        })
          .then((raw) => {
            if (!current) return;
            const next = catalogResult.parse(raw);
            if (offset && offset >= next.total) {
              setOffset(Math.max(0, Math.floor((next.total - 1) / limit) * limit));
              return;
            }
            setResult(next);
            setLoadedPage(pageKey);
            if (group && !next.groups.some((g) => g.id === group)) setGroup('');
          })
          .catch((e) => {
            if (current) setIssue(e.message);
          })
          .finally(() => {
            if (current) setBusy(false);
          });
      },
      query ? 180 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [page.id, view.load, query, scope, group, offset, revision, mode]);
  useEffect(() => {
    if (!result?.sync?.pending) return;
    const timer = setTimeout(() => {
      setForce(false);
      setRevision((n) => n + 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [result]);
  const catalogSync = !!result?.sync;
  useEffect(() => {
    if (!catalogSync) return;
    const update = () => {
      if (document.visibilityState === 'visible') {
        setForce(false);
        setRevision((n) => n + 1);
      }
    };
    const interval = setInterval(update, 65000);
    const onJob = (e: Event) => {
      if ((e as CustomEvent).detail?.type === 'knowledge.updated') update();
    };
    window.addEventListener('echo-event', onJob);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(interval);
      window.removeEventListener('echo-event', onJob);
      window.removeEventListener('focus', update);
    };
  }, [catalogSync]);
  const tree = useMemo(() => collectionPaths(result?.groups ?? []), [result?.groups]);
  const folder = [...tree].find(([, n]) => n.id === group)?.[0] ?? '';
  const row = mode === 'catalog' && result?.rows.find((r) => r.id === open);
  const choose = () => {
    setForce(false);
    setOffset(0);
    setOpen('');
    setNotice('');
  };
  const act = async (input: Record<string, unknown>) => {
    if (!view.action || pending) return;
    setPending(true);
    setIssue('');
    setNotice('');
    try {
      await rpc('frontend.invoke', { pageId: page.id, operation: view.action, input });
      setNotice(t('请求已处理'));
      refresh();
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    } finally {
      setPending(false);
    }
  };
  const cell = (column: View['columns'][number], value: string) =>
    column.localized
      ? value
          .split(' / ')
          .map((x) => t(x))
          .join(' / ')
      : value;
  const paging = (
    <div className="row between catalog-paging">
      <b>
        {t('条目')} · {result?.total ?? 0}
      </b>
      <div className="row">
        <button
          className="text-button"
          disabled={!offset}
          onClick={() => {
            setForce(false);
            setOffset((x) => Math.max(0, x - limit));
          }}
        >
          {t('上一页')}
        </button>
        <span>
          {result?.total ? Math.floor(offset / limit) + 1 : 0} /{' '}
          {Math.ceil((result?.total ?? 0) / limit)}
        </span>
        <button
          className="text-button"
          disabled={offset + limit >= (result?.total ?? 0)}
          onClick={() => {
            setForce(false);
            setOffset((x) => x + limit);
          }}
        >
          {t('下一页')}
        </button>
      </div>
    </div>
  );
  return (
    <section className="knowledge-page library-catalog" data-plugin-page={page.id}>
      <div className="page-title page-title-actions">
        <h1>{t(page.title)}</h1>
        <Button secondary onClick={refresh} disabled={busy}>
          {t('刷新')}
        </Button>
      </div>
      <div className="library-toolbar">
        {view.scopeLabel && (
          <label className="inline-toggle">
            {t(view.scopeLabel)}{' '}
            <select
              value={scope || result?.scope || ''}
              onChange={(e) => {
                choose();
                setGroup('');
                setScope(e.target.value);
              }}
            >
              {result?.scopes?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {result?.knowledgeScopes && (
          <div className="row" role="group" aria-label={t('检索范围')}>
            <Button
              secondary={mode !== 'catalog'}
              aria-pressed={mode === 'catalog'}
              onClick={() => {
                setForce(false);
                setOffset(0);
                setMode('catalog');
              }}
            >
              {t('题录')}
            </Button>
            <Button
              secondary={mode !== 'body'}
              aria-pressed={mode === 'body'}
              onClick={() => {
                setForce(false);
                setOffset(0);
                setMode('body');
              }}
            >
              {t('正文')}
            </Button>
          </div>
        )}
        {mode === 'catalog' && (
          <input
            type="search"
            className="catalog-search"
            aria-label={t('搜索当前知识库…')}
            placeholder={t('搜索当前知识库…')}
            value={query}
            onChange={(e) => {
              choose();
              setQuery(e.target.value);
            }}
          />
        )}
        <button className="text-button" onClick={() => setShowTree((x) => !x)}>
          {t(showTree ? '隐藏目录树' : '显示目录树')}
        </button>
      </div>
      {result?.sync && (
        <p className="muted" role="status">
          {result.sync.updatedAt
            ? <>{t('上次同步')} <AppTime at={result.sync.updatedAt}/></>
            : t('尚未同步完整题录')}
          {result.sync.pending
            ? ' · ' + t('正在同步…')
            : result.sync.issue
              ? ' · ' + t(result.sync.issue)
              : ''}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {issue && (
        <p role="alert" className="error">
          {issue}
        </p>
      )}
      <div
        className={'catalog-layout' + (showTree ? ' with-tree' : '') + (row ? ' with-reader' : '')}
      >
        {showTree && (
          <aside className="folder-tree catalog-tree">
            <select
              className="catalog-compact"
              aria-label={t('知识分组')}
              value={group}
              onChange={(event) => {
                choose();
                setGroup(event.target.value);
              }}
            >
              <option value="">{t('全部条目')}</option>
              {[...tree].map(([path, node]) => (
                <option key={node.id} value={node.id}>
                  {path
                    .split('/')
                    .map((_, index, parts) => tree.get(parts.slice(0, index + 1).join('/'))?.title)
                    .join(' / ')}
                </option>
              ))}
            </select>
            <KnowledgeTree
              vault={page.id + (scope || result?.scope || '')}
              folders={[...tree.keys()]}
              selected={folder}
              grouped
              rootLabel={t('全部条目')}
              label={(p) => tree.get(p)?.title ?? p}
              leafLabel={(p) => tree.get(p)?.title ?? p}
              onSelect={(p) => {
                choose();
                setGroup(tree.get(p)?.id ?? '');
              }}
            />
          </aside>
        )}
        {mode === 'body' ? (
          <CatalogBodySearch
            key={JSON.stringify([page.id, scope, group])}
            data={data}
            perform={perform}
            navigate={navigate}
            scopes={loadedPage === pageKey ? result?.knowledgeScopes : undefined}
            rows={loadedPage === pageKey ? result?.rows : undefined}
            paging={paging}
            open={open}
            onOpen={setOpen}
          />
        ) : (
          <div className="catalog-main" aria-busy={busy}>
            {busy && !result ? (
              <p role="status">{t('正在加载…')}</p>
            ) : issue && !result ? null : (
              <>
                {paging}
                {result?.rows.length ? (
                  <div className="catalog-scroll">
                    <table>
                      <thead>
                        <tr>
                          {view.columns.map((c) => (
                            <th scope="col" key={c.key}>
                              {t(c.label)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((r) => (
                          <tr key={r.id} className={open === r.id ? 'selected' : ''}>
                            {view.columns.map((c, i) => (
                              <td key={c.key} title={r.cells[c.key]}>
                                {i === 0 ? (
                                  <button
                                    className="text-button"
                                    aria-expanded={open === r.id}
                                    onClick={() => setOpen(open === r.id ? '' : r.id)}
                                  >
                                    {r.cells[c.key] || '—'}
                                  </button>
                                ) : (
                                  <span>{cell(c, r.cells[c.key] ?? '') || '—'}</span>
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>{t('没有匹配条目')}</p>
                )}
              </>
            )}
          </div>
        )}
        {row && (
          <aside className="catalog-detail" key={row.id}>
            <div className="row between">
              <h3>{row.cells[view.columns[0].key]}</h3>
              <button className="text-button" onClick={() => setOpen('')}>
                {t('关闭')}
              </button>
            </div>
            {!!row.files?.length && (
              <section className="catalog-attachments">
                <h4>{t('附件')}</h4>
                {row.files?.map((f) => (
                  <div className="row wrap" key={f.id}>
                    <span>{f.title}</span>
                    {f.status && (
                      <small>
                        {t(f.status)}
                        {f.index && ' · ' + t(f.index)}
                      </small>
                    )}
                    {f.action && view.action && (
                      <Button
                        secondary
                        disabled={pending}
                        onClick={() => void act(f.action!.input)}
                      >
                        {t(f.action.label)}
                      </Button>
                    )}
                  </div>
                ))}
                {result?.importDestination && row.files.some((f) => f.action) && (
                  <small>
                    {t('新 PDF 入库位置')} · {t(result.importDestination)}
                  </small>
                )}
              </section>
            )}
            {!!row.documents?.length && (
              <CatalogDocuments
                key={JSON.stringify(row.documents)}
                documents={row.documents}
                navigate={navigate}
              />
            )}
            <details open={row.documents?.length ? undefined : true}>
              <summary>{t('条目信息')}</summary>
              <dl>
                {view.columns
                  .slice(1)
                  .filter(
                    (c) => row.cells[c.key] && !(c.key === 'attachments' && row.files?.length),
                  )
                  .map((c) => (
                    <div key={c.key}>
                      <dt>{t(c.label)}</dt>
                      <dd>{cell(c, row.cells[c.key])}</dd>
                    </div>
                  ))}
              </dl>
            </details>
          </aside>
        )}
      </div>
    </section>
  );
}
