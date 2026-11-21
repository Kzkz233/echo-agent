import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Icon } from './ui.tsx';

export function searchKnowledge(query: string, options: any, scope: object, grouped: boolean) {
  const queries = options.queries.filter((q: { text: string }) => q.text.trim());
  return rpc<any[]>('knowledge.searchAdvanced', {
    ...scope,
    query: query.trim() || queries.map((q: { text: string }) => q.text).join('; '),
    strategy: options.strategy,
    semanticWeight: options.semanticWeight,
    queries,
    rerank: options.rerank ?? false,
    directoryBoost:
      !grouped && options.boostFolder
        ? { folder: options.boostFolder, weight: options.boostWeight ?? 1 }
        : undefined,
  });
}
export function KnowledgeQuery({
  query,
  options,
  onChange,
  onSearch,
  disabled = false,
}: {
  query: string;
  options: any;
  onChange: (q: string) => void;
  onSearch: () => void;
  disabled?: boolean;
}) {
  const canSearch =
    !disabled && (query.trim() || options.queries.some((q: { text: string }) => q.text.trim()));
  return (
    <form
      className="search-control"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSearch) onSearch();
      }}
    >
      <Icon name="search" size={16} />
      <input
        aria-label={t('知识检索词')}
        placeholder={t('搜索当前知识库…')}
        value={query}
        onChange={(e) => onChange(e.target.value)}
      />
      <button className="text-button" type="submit" disabled={!canSearch}>
        {t('检索')}
      </button>
    </form>
  );
}
