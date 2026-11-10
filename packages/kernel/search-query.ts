/** Bounded lexical query construction; no model, network or document parser required. */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const filler = new Set(['我', '你', '他', '她', '它', '的', '了', '呢', '啊', '吗', '吧', '这个', '那个', '这些', '那些', '然后', '就是', '一下', '可以', '觉得', '请问', '帮我', 'the', 'a', 'an', 'and', 'or', 'to', 'is', 'are', 'i', 'you', 'it', 'this', 'that', 'please']);
export function lexicalTerms(text: string): string[] {
  const value = text.normalize('NFKC').toLowerCase();
  // Preserve identifiers/paths/dates as well as natural-language words.
  const identifiers = value.match(/[a-z0-9][a-z0-9_.:/\\-]{2,}/g) ?? [];
  const words = [...segmenter.segment(value)].filter((part) => part.isWordLike).map((part) => part.segment);
  return [...words, ...identifiers.filter((word) => !words.includes(word))];
}
export type QueryHistory = { role: string; text: string; source?: string; meta?: Record<string, unknown> };
export function naturalHistory(history: QueryHistory[], window: number) {
  const count = Math.min(20, Math.max(0, Math.floor(window)));
  if (!count || !Number.isFinite(count)) return [];
  return history.filter((message) => ['user', 'assistant'].includes(message.role)
    && !message.meta?.memoryVersion && !['memory', 'observation', 'review', 'control', 'tool'].includes(String(message.meta?.kind ?? '')) && !message.meta?.control
    && !['observation', 'observe', 'care', 'review', 'tool', 'system'].includes(message.source ?? ''))
    .slice(-count).map(({ role, text }) => ({ role, text: text.slice(-1000) }));
}
export function buildLocalQuery(current: string, history: QueryHistory[] = [], options: { historyWindow?: number; maxChars?: number } = {}) {
  const maximum = Math.max(64, Math.min(1000, options.maxChars ?? 320));
  const recent = naturalHistory(history, options.historyWindow ?? 4);
  const weights = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const term of new Set(lexicalTerms(text))) {
      if (filler.has(term) || term.length < 2 && !/[\p{N}不没无未]/u.test(term)) continue;
      weights.set(term, (weights.get(term) ?? 0) + weight);
    }
  };
  recent.forEach((message, index) => add(message.text, (index + 1) / Math.max(1, recent.length)));
  add(current.slice(-4000), 4);
  const terms = [...weights].sort((a, b) => b[1] - a[1]).map(([term]) => term);
  let query = '';
  for (const term of terms) {
    if (query.length + term.length + 1 > maximum) continue;
    query += (query ? ' ' : '') + term;
    if (query.split(' ').length >= 32) break;
  }
  return query;
}

/** Corpus-aware BM25; a monotonic bounded score keeps existing cutoff settings meaningful. */
export function bm25<T extends { id: string; version: string; text: string; title?: string }>(query: string, records: T[]) {
  const terms = [...new Set(lexicalTerms(query).filter((term) => !filler.has(term)))];
  const docs = records.map((record) => {
    const tokens = lexicalTerms(record.text), frequencies = new Map<string, number>();
    tokens.forEach((term) => frequencies.set(term, (frequencies.get(term) ?? 0) + 1));
    lexicalTerms(record.title ?? '').forEach((term) => frequencies.set(term, (frequencies.get(term) ?? 0) + 2));
    return { record, frequencies, length: tokens.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length) || 1;
  const df = new Map(terms.map((term) => [term, docs.filter((doc) => doc.frequencies.has(term)).length]));
  return docs.map(({ record, frequencies, length }) => {
    let score = 0;
    for (const term of terms) {
      const tf = frequencies.get(term) ?? 0;
      if (!tf) continue;
      const count = df.get(term)!;
      score += Math.log(1 + (docs.length - count + 0.5) / (count + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / average));
    }
    return { ...record, score: score / (1 + score), method: 'keyword' };
  }).sort((a, b) => b.score - a.score);
}
