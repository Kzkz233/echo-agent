import { z } from 'zod';
import { id, memorySchema } from '../../packages/contracts/index.ts';

export const memoryChange = z.object({
  operation: z.enum(['add', 'update', 'merge', 'archive', 'delete', 'propose-core']).default('add'),
  subjectId: id.optional(),
  expectedVersion: z.string().optional(),
  merged: z
    .array(z.object({ id, version: z.string() }))
    .max(20)
    .default([]),
  coreOperation: z.enum(['add', 'update', 'delete', 'promote', 'demote']).optional(),
  title: memorySchema.shape.title,
  text: memorySchema.shape.text,
  sources: z.array(z.string()).min(1).max(50),
  perspective: memorySchema.shape.perspective,
  confirmation: memorySchema.shape.confirmation,
});
export type MemoryChange = z.infer<typeof memoryChange>;
export const memoryOperations = [
  'add',
  'update',
  'merge',
  'archive',
  'delete',
  'propose-core',
] as const;
export const memoryOperationLabels: Record<string, string> = {
  add: '新增普通记忆',
  update: '修订普通记忆',
  merge: '合并普通记忆',
  archive: '归档普通记忆',
  delete: '删除普通记忆',
  'propose-core': '提交核心记忆审批',
};
export const ordinaryGuidance =
  '新材料提供值得长期保留的新信息时新增记忆。表达同一件事时优先修订原条目；重复条目可以合并，并保留来源及有用差异。明确错误、被新事实替代或已失去用途的内容可以按授权归档或删除。不能仅因近期没有提及就删除，也不能把暂时情绪改写为稳定偏好。修改前对照完整原文和当前版本；证据不足时保留不确定性。';
export const coreGuidance =
  '只有涉及长期稳定的身份认知、重要关系、明确约定或持续确认的关键偏好，且值得常驻上下文时，才提出核心记忆变更。说明原条目、建议内容、依据，以及为什么普通记忆不足以承载。核心记忆新增、修改、删除及升降级都只提交待审批提案；批准前旧核心记忆继续有效，不得把待审批内容说成已经生效。';
