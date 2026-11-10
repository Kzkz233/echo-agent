import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { memoryChange } from '../memory/changes.ts';

export const reviewValidationVersion = 3;
export const draftSchema = memoryChange.extend({ text: z.string().min(1).max(2000) });
export const proposal = z.object({
  title: z.string().min(1).max(160),
  text: z.string().min(1).max(2000),
  sources: z.array(z.string()).min(1).max(20),
  operation: z.string().min(1).max(40).optional(),
  subjectId: id.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export const reviewResult = z.object({
  notes: z.string().max(12000),
  report: z.string().trim().optional(),
  memories: z.array(draftSchema).max(30),
  actions: z
    .array(proposal.extend({ target: z.string().min(1).max(200) }))
    .max(10)
    .default([]),
});
export type ReviewOutputContext = {
  sources: string[];
  targets: { id: string }[];
  memoryOperations?: readonly string[];
  memorySnapshot?: { id: string; version: string }[];
};

export function parseReviewOutput(text: string, context: ReviewOutputContext) {
  const result = reviewResult.parse(
    JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')),
  );
  for (const [kind, entries] of [
    ['memories', result.memories],
    ['actions', result.actions],
  ] as const)
    entries.forEach((entry, index) => {
      const invalid = entry.sources.find((source) => !context.sources.includes(source));
      invariant(
        invalid === undefined,
        'review_sources',
        `${kind}[${index}].sources 包含本段以外的来源：${invalid}。只能使用本段原始记录 ID，未推进阅读进度。`,
      );
    });
  result.actions.forEach((action, index) =>
    invariant(
      context.targets.some((target) => target.id === action.target),
      'review_target',
      `actions[${index}].target 不是已授权的插件目标：${action.target}。允许的 target 为 ${context.targets.map((target) => target.id).join('、') || '无（actions 必须为空）'}；具体条目编号属于 subjectId，不能填入 target。未推进阅读进度。`,
    ),
  );
  for (const memory of result.memories) {
    const operation = memory.operation === 'propose-core' ? memory.coreOperation : memory.operation;
    invariant(operation, 'review_memory_shape', '核心记忆提案必须指定 coreOperation。');
    invariant(
      operation === 'add' ? !memory.subjectId : Boolean(memory.subjectId && memory.expectedVersion),
      'review_memory_shape',
      `记忆操作 ${operation} 的目标字段不完整：新增不能填 subjectId；修改、合并、归档或删除必须同时提供 subjectId 和 expectedVersion。`,
    );
    invariant(
      !memory.merged.length || operation === 'merge',
      'review_memory_shape',
      '只有 merge 操作可以包含 merged 条目。',
    );
    invariant(
      (context.memoryOperations ?? ['add']).includes(memory.operation),
      'review_permission',
      '整理提出了未授权的记忆操作。',
    );
    const references = [
      ...(memory.subjectId ? [{ id: memory.subjectId, version: memory.expectedVersion }] : []),
      ...memory.merged,
    ];
    invariant(
      references.every((ref) =>
        context.memorySnapshot?.some(
          (memory) => memory.id === ref.id && memory.version === ref.version,
        ),
      ),
      'review_memory_read',
      '修改前必须完整读取相应记忆及当前版本。',
    );
  }
  return result;
}

/** Legacy checkpoints accepted updates with only a version. A unique SHA-256
 * content version in the frozen read set identifies the record without guessing.
 * New outputs must always provide both fields and never use this recovery path. */
export function recoverLegacyReviewReferences(
  drafts: z.input<typeof draftSchema>[],
  snapshot: { id: string; version: string }[] = [],
) {
  const repairs: {
    index: number;
    before: z.input<typeof draftSchema>;
    after: z.input<typeof draftSchema>;
  }[] = [];
  const recovered = drafts.map((draft, index) => {
    if (draft.operation !== 'update' || draft.subjectId) return draft;
    const matches = /^[a-f0-9]{64}$/i.test(draft.expectedVersion ?? '')
      ? snapshot.filter((row) => row.version === draft.expectedVersion)
      : [];
    invariant(
      matches.length === 1,
      'review_memory_shape',
      `旧整理草稿 ${index + 1} 缺少 subjectId，无法从已读版本唯一确定目标；未猜测或提交该条目。`,
    );
    const after = { ...draft, subjectId: matches[0].id };
    repairs.push({ index, before: draft, after });
    return after;
  });
  return { drafts: recovered, repairs };
}

/** The retry schema describes this frozen packet, not a generic open-ended target string. */
export function reviewRepairSchema(context: ReviewOutputContext) {
  const sources = z
    .array(z.enum([...new Set(context.sources)]))
    .min(1)
    .max(20);
  const operations = context.memoryOperations ?? ['add'];
  return reviewResult.extend({
    memories: operations.length
      ? z.array(draftSchema.extend({ sources, operation: z.enum([...operations]) })).max(30)
      : z.array(z.never()).max(0),
    actions: context.targets.length
      ? z
          .array(
            proposal.extend({
              sources,
              target: z.enum(context.targets.map((target) => target.id)),
            }),
          )
          .max(10)
      : z.array(z.never()).max(0),
  });
}
