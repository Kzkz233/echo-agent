import { bm25 } from './search-query.ts';
import { z } from 'zod';
import { Capabilities } from './capabilities.ts';
function tokens(text: string) {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' '),
    result = new Set(normalized.match(/[a-z0-9]+/g) ?? []);
  for (const block of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (block.length === 1) result.add(block);
    for (let i = 0; i < block.length - 1; i++) result.add(block.slice(i, i + 2));
  }
  return result;
}
export function keywordScore(query: string, text: string) {
  const q = tokens(query),
    d = tokens(text);
  if (!q.size) return 0;
  let hits = 0;
  for (const t of q) if (d.has(t)) hits++;
  return hits / Math.sqrt(q.size * Math.max(d.size, 1));
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return -1;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export type SearchRecord = {
  id: string;
  version: string;
  text: string;
  title?: string;
  documentId?: string;
  vaultId?: string;
  bodyHash?: string;
};
export type SearchHit = {
  id: string;
  version: string;
  score: number;
  method: string;
  text?: string;
  node?: { id: string; modality: string; parentId?: string };
};
export type SearchStrategy = 'keyword' | 'semantic' | 'hybrid';
export type SearchQuery = { text: string; weight: number };
export type KnowledgeScope = {
  vaultId?: string;
  collectionId?: string;
  documentIds?: string[];
  kind?: string;
  folder?: string;
  folderExact?: boolean;
  archived?: boolean;
};

/** Weighted reciprocal ranks keep lexical and cosine scales independent. */
export function fuseRanks(lists: { hits: SearchHit[]; weight: number; query?: string }[]) {
  const result = new Map<string, SearchHit & { matchedQueries: string[] }>();
  let maximum = 0;
  for (const list of lists) {
    if (list.weight <= 0) continue;
    maximum += list.weight / 61;
    [...list.hits]
      .sort((a, b) => b.score - a.score)
      .forEach((hit, rank) => {
        const key = hit.id + ':' + hit.version;
        const old = result.get(key) ?? { ...hit, score: 0, matchedQueries: [] };
        old.score += list.weight / (61 + rank);
        if (hit.node) {
          old.node = hit.node;
          old.text = hit.text;
          old.method = hit.method;
        }
        if (list.query && !old.matchedQueries.includes(list.query))
          old.matchedQueries.push(list.query);
        result.set(key, old);
      });
  }
  return [...result.values()]
    .map((hit) => ({ ...hit, score: maximum ? hit.score / maximum : 0 }))
    .sort((a, b) => b.score - a.score);
}
export type RetrievalProvider = {
  id: string;
  rank: (
    scope: string,
    query: string,
    records: SearchRecord[],
    signal: AbortSignal,
    context?: { personaId?: string },
  ) => Promise<SearchHit[] | undefined>;
};
export class Retrieval {
  constructor(
    readonly capabilities = new Capabilities(),
    readonly selection: () => string | undefined = () => undefined,
  ) {}
  define(scope: ReturnType<Capabilities['forOwner']>) {
    scope.define({
      id: 'core.retrieval@1',
      description: '可选检索增强；只处理本次明确提供的记录',
      input: z.object({
        scope: z.string(),
        personaId: z.string().optional(),
        query: z.string(),
        records: z.array(
          z.object({
            id: z.string(),
            version: z.string(),
            text: z.string(),
            documentId: z.string().optional(),
            vaultId: z.string().optional(),
            bodyHash: z.string().optional(),
          }),
        ),
      }),
      output: z
        .array(
          z.object({
            id: z.string(),
            version: z.string(),
            score: z.number().finite().min(-1).max(1),
            method: z.string(),
            text: z.string().optional(),
            node: z
              .object({ id: z.string(), modality: z.string(), parentId: z.string().optional() })
              .optional(),
          }),
        )
        .nullable(),
      providePermission: 'knowledge.enhance',
      consumePermission: 'knowledge.read',
      cardinality: 'one',
    });
  }
  register(provider: RetrievalProvider, ownerScope: ReturnType<Capabilities['forOwner']>) {
    return ownerScope.provide('core.retrieval@1', provider.id + '.rank', provider.id, (v, signal) =>
      provider
        .rank(v.scope, v.query, v.records, signal, { personaId: v.personaId })
        .then((result) => result ?? null),
    );
  }
  get providers() {
    return this.capabilities.list('core.retrieval@1').filter((p) => p.state === 'active');
  }
  async rank(
    scope: string,
    query: string,
    records: SearchRecord[],
    signal: AbortSignal,
    useSemantic = true,
    strict = false,
    context: { personaId?: string } = {},
  ): Promise<SearchHit[]> {
    signal.throwIfAborted();
    if (useSemantic && this.providers.length)
      try {
        const providers = this.providers;
        const selected = this.selection();
        const chosen = selected
          ? providers.find((p) => p.id === selected)
          : providers.length === 1
            ? providers[0]
            : undefined;
        if (chosen) {
          const hits = (await this.capabilities.invoke(
            { id: 'retrieval', permissions: new Set(['knowledge.read']), signal },
            'core.retrieval@1',
            chosen.id,
            { scope, query, records, personaId: context.personaId },
            signal,
          )) as SearchHit[] | null;
          if (hits) {
            const known = new Set(records.map((r) => r.id + ':' + r.version));
            if (!hits.every((h) => known.has(h.id + ':' + h.version)))
              throw Error('检索提供方返回了不属于本次范围的记录');
            return [...new Map(hits.map((h) => [h.id + ':' + h.version, h])).values()];
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        if (strict) throw error;
      }
    if (strict && useSemantic) throw Error('所选范围没有可用语义索引，请先建立向量索引。');
    return bm25(query, records);
  }
  async search(
    scope: string,
    queries: SearchQuery[],
    records: SearchRecord[],
    signal: AbortSignal,
    strategy: SearchStrategy,
    semanticWeight = 0.7,
  ) {
    const lists = [];
    let usedSemantic = false;
    for (const query of queries) {
      signal.throwIfAborted();
      const keyword = bm25(query.text, strategy === 'semantic' ? [] : records).filter((hit) => hit.score >= 0.02);
      let hits: SearchHit[] = keyword;
      if (strategy !== 'keyword') {
        const ranked = await this.rank(
          scope,
          query.text,
          records,
          signal,
          true,
          strategy === 'semantic',
        );
        const semantic = ranked.filter((h) => h.method !== 'keyword');
        usedSemantic ||= semantic.length > 0;
        hits =
          strategy === 'semantic'
            ? semantic
            : fuseRanks([
                { hits: keyword, weight: 1 - semanticWeight },
                { hits: semantic, weight: semanticWeight },
              ]);
      }
      lists.push({ hits, weight: query.weight, query: query.text });
    }
    return fuseRanks(lists).map((hit) => ({
      ...hit,
      method: strategy === 'hybrid' && !usedSemantic ? 'keyword' : strategy,
    }));
  }
}
