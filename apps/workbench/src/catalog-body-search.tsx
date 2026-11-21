import { useEffect, useRef, useState } from 'react';
import type { CatalogResult } from '../../../packages/contracts/library-catalog.ts';
import { KnowledgeQuery, searchKnowledge } from './knowledge-query.tsx';
import { KnowledgeSearch } from './knowledge-search.tsx';
import { CatalogDocuments } from './catalog-documents.tsx';
import { t } from './i18n.ts';

export function CatalogBodySearch({
  data,
  perform,
  navigate,
  scopes,
  rows,
  paging,
  open,
  onOpen,
}: {
  data: any;
  perform: (fn: () => Promise<any>, message?: string) => Promise<any>;
  navigate?: (page: string, selected?: string, selection?: any) => void;
  scopes: CatalogResult['knowledgeScopes'];
  rows?: CatalogResult['rows'];
  paging: React.ReactNode;
  open: string;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [hits, setHits] = useState<any[]>(),
    [chosen, setChosen] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [options, setOptions] = useState<any>({
    strategy: data.pluginSettings.knowledge?.strategy ?? 'keyword',
    queries: [],
    semanticWeight: 0.7,
    kind: '',
  });
  const version = useRef(0);
  const scopeKey = JSON.stringify(scopes);
  function reset() {
    ++version.current;
    setHits(undefined);
    setChosen(undefined);
    setBusy(false);
    setError('');
  }
  useEffect(() => {
    reset();
    return () => {
      ++version.current;
    };
  }, [scopeKey]);
  async function submit() {
    if (!scopes?.length) return;
    reset();
    const run = version.current;
    setBusy(true);
    try {
      const rows = await searchKnowledge(
        query,
        options,
        {
          collectionScopes: scopes.map(({ vaultId, collectionId }) => ({ vaultId, collectionId })),
          kind: options.kind || 'all',
        },
        true,
      );
      if (run === version.current) setHits(rows);
    } catch (e) {
      if (run === version.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (run === version.current) setBusy(false);
    }
  }
  const browsing = hits === undefined && !query.trim() && !busy && !error;
  const selected = browsing ? rows?.find((r) => r.id === open) : undefined;
  const reading = chosen || selected?.documents?.length;
  return (
    <div className="catalog-main">
      <KnowledgeQuery
        query={query}
        options={options}
        disabled={busy || !scopes?.length}
        onChange={(v) => {
          reset();
          setQuery(v);
        }}
        onSearch={() => void submit()}
      />
      <KnowledgeSearch
        data={data}
        options={options}
        scope={{}}
        query={query}
        kinds={{ knowledge: '知识' }}
        grouped
        managing={false}
        act={perform}
        setPage={navigate}
        onChange={(v: any) => {
          reset();
          setOptions(v);
        }}
      />
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite">
        {busy
          ? t('正在加载…')
          : !scopes
            ? t('正在加载…')
            : !scopes.length
              ? t('当前分组没有可检索的正文')
              : browsing
                ? null
                : hits
                  ? t('检索结果') + ' · ' + hits.length
                  : t('输入检索词搜索当前分组的正文')}
      </div>
      {browsing && rows && paging}
      <div className={'catalog-body-results' + (reading ? ' reading' : '')}>
        <div>
          {browsing &&
            rows?.map((r) => (
              <button
                key={r.id}
                className="document-row"
                aria-pressed={r.id === open}
                onClick={() => onOpen(r.id)}
              >
                <span>{r.cells.title || r.documents?.[0]?.title}</span>
              </button>
            ))}
          {browsing && rows?.length === 0 && <p>{t('没有匹配条目')}</p>}
          {hits?.map((hit) => (
            <button
              key={hit.id}
              className="document-row"
              aria-pressed={hit === chosen}
              onClick={() => setChosen(hit)}
            >
              <div>
                <b>{hit.title || t('知识片段')}</b>
                <p>{hit.text?.slice(0, 140)}</p>
              </div>
            </button>
          ))}
        </div>
        {reading ? (
          <aside className="catalog-detail">
            <div className="row between">
              <h3>{chosen?.title ?? selected?.cells.title}</h3>
              <button
                className="text-button"
                onClick={() => {
                  setChosen(undefined);
                  onOpen('');
                }}
              >
                {t('关闭')}
              </button>
            </div>
            <CatalogDocuments
              key={chosen?.id ?? selected?.id}
              start={chosen}
              documents={
                chosen
                  ? [{ vaultId: chosen.vaultId, documentId: chosen.documentId }]
                  : selected!.documents!
              }
              navigate={navigate}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
