import { useEffect, useRef, useState } from 'react';
import { rpc } from './client.ts';
import { t, statusText } from './i18n.ts';
import { Button, useConfirm } from './ui.tsx';

export function KnowledgeSearch({
  data,
  scope,
  query,
  options,
  onChange,
  act,
  kinds,
  setPage,
  grouped,
}: any) {
  const [open, setOpen] = useState(false),
    [indexOpen, setIndexOpen] = useState(false),
    [status, setStatus] = useState<any>();
  const confirm = useConfirm(),
    version = useRef(0);
  const scopeKey = JSON.stringify(scope),
    activeScope = useRef(scopeKey);
  activeScope.current = scopeKey;
  const available = data.plugins.some((p: any) => p.id === 'semantic' && p.enabled);
  useEffect(() => {
    if (!available && (options.strategy !== 'keyword' || options.rerank))
      onChange({ ...options, strategy: 'keyword', rerank: false });
  }, [available, options.strategy, options.rerank]);
  const load = async (full = true) => {
    const n = ++version.current;
    if (!available) return;
    const result = await rpc('semantic.status', full ? { filter: scope } : {});
    if (n === version.current)
      setStatus((old: any) => ({ ...result, index: result.index ?? old?.index }));
    return result;
  };
  useEffect(() => {
    setStatus(undefined);
    version.current++;
    if (indexOpen) void load().catch(() => {});
    return () => {
      version.current++;
    };
  }, [JSON.stringify(scope), available, indexOpen]);
  useEffect(() => {
    if (!indexOpen) return;
    let timer: ReturnType<typeof setTimeout>;
    const listener = (e: any) => {
      if (e.detail.type === 'semantic.updated') {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            void load(false)
              .then((result) => {
                if (result && !result.jobs.some((j: any) => j.state === 'running')) return load();
              })
              .catch(() => {}),
          500,
        );
      }
    };
    window.addEventListener('echo-event', listener);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('echo-event', listener);
    };
  }, [indexOpen, JSON.stringify(scope), available]);
  const jobs = (status?.jobs ?? []).filter((j: any) => j.filter.vaultId === scope.vaultId),
    running = jobs.find((j: any) => j.state === 'running');
  const change = (patch: any) => onChange({ ...options, ...patch });
  return (
    <div className="knowledge-search-tools">
      <div className="row wrap">
        <button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('高级搜索')}
        </button>
        <button
          className="text-button"
          aria-expanded={indexOpen}
          onClick={() => setIndexOpen(!indexOpen)}
        >
          {t('向量索引')}
        </button>
      </div>
      {open && (
        <div className="card operation-panel advanced-search">
          <div className="form-grid">
            <label className="field">
              <span>{t('检索策略')}</span>
              <select
                aria-label={t('检索策略')}
                value={options.strategy}
                onChange={(e) => change({ strategy: e.target.value })}
              >
                <option value="keyword">{t('关键词')}</option>
                <option value="semantic" disabled={!available}>
                  {t('语义')}
                </option>
                <option value="hybrid" disabled={!available}>
                  {t('混合检索')}
                </option>
              </select>
            </label>
            <label className="field">
              <span>{t('内容类型')}</span>
              <select value={options.kind ?? ''} onChange={(e) => change({ kind: e.target.value })}>
                <option value="">{t('全部内容类型')}</option>
                {Object.entries(kinds).map(([id, label]) => (
                  <option key={id} value={id}>
                    {t(label as string)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('语义权重')}</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={options.semanticWeight}
                disabled={options.strategy !== 'hybrid'}
                onChange={(e) => change({ semanticWeight: Number(e.target.value) })}
              />
            </label>
            {!grouped && (
              <label className="inline-toggle">
                <input
                  type="checkbox"
                  checked={options.folderExact ?? false}
                  onChange={(e) => change({ folderExact: e.target.checked })}
                />
                {t('仅当前目录')}
              </label>
            )}
            <label className="inline-toggle">
              <input
                type="checkbox"
                disabled={!available}
                checked={options.rerank ?? false}
                onChange={(e) => change({ rerank: e.target.checked })}
              />
              {t('模型重排')}
            </label>
          </div>
          <div className="search-query-heading">
            <strong>{t('多检索词融合')}</strong>
            <Button
              secondary
              disabled={!query.trim() || !available}
              onClick={() =>
                act(async () => {
                  const requestedScope = scopeKey;
                  const keys = await rpc('semantic.expand', { query });
                  if (activeScope.current !== requestedScope) return;
                  change({ queries: keys.map((text: string) => ({ text, weight: 1 })) });
                }, t('检索词已生成'))
              }
            >
              {t('模型扩展检索词')}
            </Button>
            <Button
              secondary
              onClick={() =>
                change({ queries: [...(options.queries ?? []), { text: '', weight: 1 }] })
              }
              disabled={options.queries?.length >= 8}
            >
              {t('添加检索词')}
            </Button>
          </div>
          {(options.queries ?? []).map((q: any, n: number) => (
            <div className="search-query-row" key={n}>
              <input
                aria-label={t('检索词') + ' ' + (n + 1)}
                value={q.text}
                onChange={(e) =>
                  change({
                    queries: options.queries.map((v: any, i: number) =>
                      i === n ? { ...v, text: e.target.value } : v,
                    ),
                  })
                }
              />
              <label>
                {t('权重')}
                <input
                  aria-label={t('检索词权重') + ' ' + (n + 1)}
                  type="number"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={q.weight}
                  onChange={(e) =>
                    change({
                      queries: options.queries.map((v: any, i: number) =>
                        i === n ? { ...v, weight: Number(e.target.value) } : v,
                      ),
                    })
                  }
                />
              </label>
              <button
                className="text-button"
                onClick={() =>
                  change({ queries: options.queries.filter((_: any, i: number) => i !== n) })
                }
              >
                {t('移除')}
              </button>
            </div>
          ))}
          {!grouped && (
            <div className="form-grid">
              <label className="field">
                <span>{t('优先目录')}</span>
                <input
                  value={options.boostFolder ?? ''}
                  placeholder={t('可选，相对于当前库')}
                  onChange={(e) => change({ boostFolder: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t('目录权重')}</span>
                <input
                  type="number"
                  min="0.1"
                  max="3"
                  step="0.1"
                  value={options.boostWeight ?? 1}
                  onChange={(e) => change({ boostWeight: Number(e.target.value) })}
                />
              </label>
            </div>
          )}
          {options.rerank && (
            <p className="muted">
              {t('重排会额外调用“检索词构造”任务配置的模型，仅在执行搜索时调用。')}
            </p>
          )}
        </div>
      )}
      {indexOpen && (
        <div className="card operation-panel index-panel">
          <div className="row between">
            <h2>{t('当前库的向量索引')}</h2>
            <button className="text-button" onClick={() => void act(() => load(), t('已刷新'))}>
              {t('刷新状态')}
            </button>
          </div>
          {!available ? (
            <p>{t('启用语义检索增强后，可在这里建立和维护向量索引。')}</p>
          ) : (
            <>
              <div className="index-summary">
                <span>
                  {t('已建片段')} <strong>{status?.index?.indexed ?? '—'}</strong>
                </span>
                <span>
                  {t('缺失片段')} <strong>{status?.index?.missing ?? '—'}</strong>
                </span>
                {!!status?.index?.migratedNodes && (
                  <span>
                    {t('已迁移结构向量')} <strong>{status.index.migratedNodes}</strong> ·{' '}
                    {status.index.migratedDocuments} {t('篇知识')}
                  </span>
                )}
                <span>
                  {t('向量模型')} · {status?.embeddingModel?.name ?? t('未配置')}
                </span>
              </div>
              {status?.issue && <p className="warning">{status.issue}</p>}
              <div className="row wrap">
                <Button
                  disabled={Boolean(running) || !status?.index?.missing}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: t('建立当前范围的向量索引？'),
                        description: ['cloud', 'remote'].includes(
                          status?.embeddingModel?.deployment,
                        )
                          ? t('所选文本片段将发送到向量 API，可能产生费用。')
                          : t('仅计算缺失片段，使用所选模型执行；可以暂停并继续。'),
                        confirmLabel: t('开始向量化'),
                      })
                    )
                      await act(async () => {
                        await rpc('semantic.index', {
                          filter: scope,
                          requestId: crypto.randomUUID(),
                        });
                        await load(false);
                      }, t('向量任务已启动'));
                  }}
                >
                  {t('建立向量索引')}
                </Button>
                {running && (
                  <Button
                    secondary
                    onClick={() => act(() => rpc('semantic.cancel'), t('已请求暂停'))}
                  >
                    {t('暂停向量化')}
                  </Button>
                )}
                <button className="text-button" onClick={() => setPage('plugins')}>
                  {t('配置语义检索增强')}
                </button>
              </div>
              {jobs
                .slice(-3)
                .reverse()
                .map((j: any) => (
                  <div className="index-job" key={j.id}>
                    <span>
                      {statusText(j.state)} · {j.completed}/{j.total}
                    </span>
                    <progress max={j.total || 1} value={j.completed} />
                    {j.error && <span className="warning">{j.error}</span>}
                  </div>
                ))}
              {status?.lastIssue && <p className="warning">{status.lastIssue.message}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
