import { z } from 'zod';
import { id, reasoning } from '../../packages/contracts/index.ts';
import type { Field } from '../../packages/kernel/registry.ts';
import { executionRequest } from '../../packages/contracts/work.ts';
import { contextCompaction } from '../../packages/contracts/compaction.ts';
export { executionRequest };
export type { ExecutionRequest } from '../../packages/contracts/work.ts';
export const defaultDelegationPrompt =
  '你负责理解用户意图、组织工作、检查成果和最终沟通。对于耗时、可独立验收的执行工作，优先使用适合的 Worker；简单交流与短小操作直接处理。委派时说明目标、约束、必要背景和验收标准。收到结果后检查证据和未决事项，再向用户汇报。不要把任务受理或执行结束当作验收通过。';
export const workerTemplate = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1500).default(''),
  profileId: z.string().default(''),
  reasoning: reasoning.default('inherit'),
  projectDirectory: z.string().default(''),
  workspaces: z
    .array(z.object({ path: z.string().min(1), write: z.boolean().default(false) }))
    .max(20)
    .default([]),
  write: z.boolean().default(false),
  fullAccess: z.boolean().optional(),
  approvals: z.enum(['ask', 'deny']).default('ask'),
  terminal: z.boolean().default(false),
  timeoutMinutes: z.number().int().min(1).max(120).default(20),
  prompt: z.string().max(12000).default(''),
  toolPermissions: z.array(id).max(200).optional(),
  compaction: contextCompaction.optional(),
  maxOutputTokens: z.number().int().min(64).max(131072).optional(),
  workerRecall: z.boolean().optional(),
  contextBlocks: z.array(id).max(200).optional(),
});
export type WorkerTemplate = z.infer<typeof workerTemplate>;
// The legacy type name is retained for frozen historical execution snapshots only.
const workspace = z.object({ path: z.string().min(1), write: z.boolean().default(false) });
const policySchema = z.object({
  authorizationVersion: z.literal(3).default(3),
  autonomous: z.boolean().default(true),
  prompt: z.string().max(12000).default(defaultDelegationPrompt),
  reportOnCompletion: z.boolean().default(true),
  reportPrompt: z
    .string()
    .max(12000)
    .default(
      '检查子任务的实际成果与证据，明确记录验收通过或需要返工，再汇报重要结果和未决事项。不要因完成通知重复创建任务。',
    ),
  concurrency: z.number().int().min(1).max(4).default(1),
  selectionMode: z.enum(['choose', 'fixed']).default('choose'),
  fixedProfileId: z.string().default(''),
  defaultReasoning: reasoning.default('inherit'),
  contextBlocks: z.array(id).max(200).optional(),
  compaction: contextCompaction.optional(),
  maxOutputTokens: z.number().int().min(64).max(131072).optional(),
  allowedProfileIds: z.array(id).max(100).default([]),
  workspaces: z.array(workspace).max(100).default([]),
  toolPermissions: z.array(id).max(200).optional(),
  approvals: z.enum(['ask', 'deny']).default('ask'),
  approvalReviewer: z.enum(['user', 'main']).default('user'),
  allowFullAccess: z.boolean().default(false),
  terminal: z.boolean().default(false),
  timeoutMinutes: z.number().int().min(1).max(120).default(20),
});
export const settings = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const value = raw as Record<string, any>;
  if (value.authorizationVersion === 3) return value;
  const legacy: WorkerTemplate[] = Array.isArray(value.templates)
    ? value.templates.map((t: any) => workerTemplate.parse(t))
    : value.profileId
      ? [workerTemplate.parse({ ...value, id: 'default', name: 'Legacy' })]
      : [];
  const roots = new Map<string, { path: string; write: boolean }>();
  for (const template of legacy)
    for (const item of [
      { path: template.projectDirectory, write: template.write },
      ...template.workspaces,
    ]) {
      if (!item.path) continue;
      const prior = roots.get(item.path);
      roots.set(item.path, { path: item.path, write: Boolean(prior?.write || item.write) });
    }
  return {
    ...value,
    authorizationVersion: 3,
    autonomous: value.autonomous ?? value.mode !== 'manual',
    allowedProfileIds: value.allowedProfileIds ?? [
      ...new Set(legacy.map((t) => t.profileId).filter(Boolean)),
    ],
    workspaces: value.workspaces ?? [...roots.values()],
    approvals:
      value.approvals ??
      (legacy.length && legacy.every((t) => t.approvals === 'deny') ? 'deny' : 'ask'),
    terminal: value.terminal ?? legacy.some((t) => t.terminal),
    toolPermissions: value.toolPermissions ?? (legacy.length ? undefined : []),
    timeoutMinutes: value.timeoutMinutes ?? Math.max(20, ...legacy.map((t) => t.timeoutMinutes)),
  };
}, policySchema);
export type DelegationPolicy = z.infer<typeof settings>;
export const characterFields: Field[] = [
  { key: 'autonomous', label: '允许主角色委派子任务', type: 'boolean' },
  {
    key: 'allowedProfileIds',
    label: '子任务执行器',
    type: 'multi',
    resource: 'executor',
    description: '指定执行器，或允许主会话为每个任务选择。模型和账号的授权范围单独保留。',
  },
  {
    key: 'workspaces',
    label: '子任务可访问的目录',
    type: 'records',
    resource: 'workspace',
    max: 100,
    addLabel: '添加目录',
    removeLabel: '移除目录',
    description: '主角色可在这些目录内为每个子任务选择工作位置；勾选写入才允许修改。',
    rowFields: [
      { key: 'path', label: '目录', type: 'path', pathMode: 'directory' },
      { key: 'write', label: '允许写入', type: 'boolean' },
    ],
    defaults: { path: '', write: false },
  },
  {
    key: 'toolPermissions',
    label: '子任务可用的应用工具',
    type: 'multi',
    resource: 'permission',
    description: '每个子任务只取得本次请求的工具权限，不能超出角色和应用的授权。',
  },
  {
    key: 'approvals',
    label: '操作审批',
    type: 'select',
    options: ['ask', 'deny'],
    optionLabels: { ask: '逐次确认', deny: '不允许' },
  },
  {
    key: 'terminal',
    label: '允许子任务请求终端命令',
    type: 'boolean',
    description: '执行时仍需确认；终端不是仅限目录的沙箱。',
  },
  {
    key: 'allowFullAccess', label: '允许委派本机完全访问', type: 'boolean', localOnly: true,
    description: '仅适用于内置执行器。由主会话逐个任务选择，执行仍以当前系统账户权限为准。',
  },
  {
    key: 'approvalReviewer', label: '子任务审批交给', type: 'select', localOnly: true,
    options: ['user', 'main'], optionLabels: { user: '我确认', main: '主会话代审' },
    description: '主会话可代审已授权目录内的文件修改。终端和业务审批交给用户。',
  },
  { key: 'concurrency', label: '同时执行上限', type: 'number', min: 1, max: 4 },
  { key: 'timeoutMinutes', label: '单轮执行时限上限（分钟）', type: 'number', min: 1, max: 120 },
  { key: 'prompt', label: '主角色委派指引', type: 'textarea' },
  { key: 'reportOnCompletion', label: '子任务结束后由主角色接棒', type: 'boolean' },
  { key: 'reportPrompt', label: '接棒与验收指引', type: 'textarea' },
];
