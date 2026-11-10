import { z } from 'zod';
import { id } from '../../packages/contracts/index.ts';
import type { PluginContext } from '../../packages/kernel/registry.ts';
import { bm25, buildLocalQuery } from '../../packages/kernel/search-query.ts';

/** Retrieval consumes a caller-selected record set; providers cannot widen its scope. */
export function registerRetrievalOptions(capabilities: PluginContext['capabilities']) {
  capabilities.define({
    id: 'knowledge.queries@1',
    description: '根据当前输入和有限历史构造检索查询',
    input: z.object({
      personaId: id.optional(),
      text: z.string().max(100000),
      recent: z.array(z.unknown()).max(20),
      maxChars: z.number().int().min(64).max(1000),
    }),
    output: z.object({ query: z.string().max(4000) }),
    providePermission: 'knowledge.enhance',
    consumePermission: 'knowledge.read',
    cardinality: 'many',
  });
  capabilities.provide(
    'knowledge.queries@1',
    'knowledge.local',
    '本地关键词提取',
    ({ text, recent, maxChars }) => ({
      query: buildLocalQuery(text, recent, { historyWindow: recent.length, maxChars }),
    }),
  );
  capabilities.define({
    id: 'knowledge.retrieval@1',
    description: '检索调用方授权的文档集合',
    input: z.object({
      personaId: id.optional(),
      collection: z.string().default('knowledge'),
      query: z.string().max(4000),
      records: z.array(z.object({ id: z.string(), version: z.string(), text: z.string() })),
    }),
    output: z.array(
      z.object({
        id: z.string(),
        version: z.string(),
        score: z.number().finite(),
        method: z.string(),
      }),
    ),
    providePermission: 'knowledge.enhance',
    consumePermission: 'knowledge.read',
    cardinality: 'many',
  });
  capabilities.provide(
    'knowledge.retrieval@1',
    'knowledge.keyword',
    '关键词检索',
    ({ query, records }) => bm25(query, records),
  );
}
