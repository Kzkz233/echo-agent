import { Fragment, lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { FrontendPageEntry } from '../../../packages/contracts/frontend.ts';
import { catalogResult, type CatalogResult } from '../../../packages/contracts/library-catalog.ts';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { collectionPaths, KnowledgeTree } from './knowledge-tree.tsx';
import { Button } from './ui.tsx';
import './library-catalog.css';

type View = Extract<FrontendPageEntry['view'], { type: 'catalog' }>;
const limit = 25;
const KnowledgeBody = lazy(() => import('./knowledge-body.tsx'));
type DocumentRef = { vaultId: string; documentId: string };

function CatalogDocuments({
  documents,
  navigate,
}: {
  documents: DocumentRef[];
  navigate?: (page: string, selected?: string, selection?: any) => void;
}) {
  const [selected, setSelected] = useState<DocumentRef>();
  const [offset, setOffset] = useState(0),
    [document, setDocument] = useState<any>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (!selected) return;
    setBusy(true);
    setError('');
    void rpc('knowledge.read', { id: selected.documentId, vaultId: selected.vaultId, offset })
      .then((next) => {
        if (active)
          setDocument((old: any) =>
            offset && old?.version === next.version
              ? { ...next, content: old.content + next.content }
              : next,
          );
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [selected, offset]);
  return (
    <>
      {documents.map((doc, i) => (
        <Button
          key={JSON.stringify(doc)}
          secondary
          onClick={() => {
            setDocument(undefined);
            setOffset(0);
            setSelected({ ...doc });
          }}
        >
          {t('打开知识条目')}
          {documents.length > 1 ? ' ' + (i + 1) : ''}
        </Button>
      ))}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{t('正在加载…')}</p>}
      {document && (
        <article className="document-reader">
          <h3>{document.title}</h3>
          <Suspense fallback={<p>{t('正在排版…')}</p>}>
            <KnowledgeBody
              document={document}
              onOpenEntry={(d: DocumentRef) => navigate?.('knowledge', undefined, d)}
            />
          </Suspense>
          {document.nextOffset != null && (
            <Button secondary disabled={busy} onClick={() => setOffset(document.nextOffset)}>
              {t('继续读取')}
            </Button>
          )}
        </article>
      )}
    </>
  );
}
export function LibraryCatalog({
  page,
  view,
  navigate,
}: {
  page: FrontendPageEntry;
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
  const [force, setForce] = useState(false);
  const refresh = () => {
    setForce(true);
    setRevision((n) => n + 1);
  };
  useEffect(() => {
    let current = true;
    setBusy(true);
    setIssue('');
    setOpen('');
    const timer = setTimeout(
      () => {
        void rpc('frontend.invoke', {
          pageId: page.id,
          operation: view.load,
          input: {
            query,
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
  }, [page.id, view.load, query, scope, group, offset, revision]);
  const tree = useMemo(() => collectionPaths(result?.groups ?? []), [result?.groups]);
  const folder = [...tree].find(([, n]) => n.id === group)?.[0] ?? '';
  const row = result?.rows.find((r) => r.id === open);
  const choose = () => {
    setForce(false);
    setOffset(0);
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
        <button className="text-button" onClick={() => setShowTree((x) => !x)}>
          {t(showTree ? '隐藏目录树' : '显示目录树')}
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {issue && (
        <p role="alert" className="error">
          {issue}
        </p>
      )}
      <div className={'catalog-layout' + (showTree ? ' with-tree' : '')}>
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
        <div className="catalog-main" aria-busy={busy}>
          {busy ? (
            <p role="status">{t('正在加载…')}</p>
          ) : issue ? null : (
            <>
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
                        <Fragment key={r.id}>
                          <tr className={open === r.id ? 'selected' : ''}>
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
                          {row?.id === r.id && (
                            <tr>
                              <td colSpan={view.columns.length}>
                                <section className="catalog-detail">
                                  <h3>{row.cells[view.columns[0].key]}</h3>
                                  <dl>
                                    {view.columns
                                      .slice(1)
                                      .filter((c) => row.cells[c.key])
                                      .map((c) => (
                                        <div key={c.key}>
                                          <dt>{t(c.label)}</dt>
                                          <dd>{cell(c, row.cells[c.key])}</dd>
                                        </div>
                                      ))}
                                  </dl>
                                  {row.files?.map(
                                    (f) =>
                                      f.action &&
                                      view.action && (
                                        <div className="row" key={f.id}>
                                          <span>{f.title}</span>
                                          <Button
                                            secondary
                                            disabled={pending}
                                            onClick={() => void act(f.action!.input)}
                                          >
                                            {t(f.action.label)}
                                          </Button>
                                        </div>
                                      ),
                                  )}
                                  {row.documents?.length ? (
                                    <CatalogDocuments
                                      documents={row.documents}
                                      navigate={navigate}
                                    />
                                  ) : null}
                                </section>
                              </td>
                            </tr>
                          )}
                        </Fragment>
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
      </div>
    </section>
  );
}
