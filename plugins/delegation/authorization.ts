import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { projectRoot, within } from '../../packages/backends/project-root.ts';
import { invariant } from '../../packages/contracts/index.ts';
import { roleToolGrants, type RoleToolGrants } from '../../packages/kernel/tool-access.ts';
import {
  workerTemplate,
  type ExecutionRequest,
  type DelegationPolicy,
  type WorkerTemplate,
} from './config.ts';
import type { Store } from '../../packages/kernel/store.ts';

export async function authorizeExecution(
  store: Store,
  personaId: string,
  mainProfileId: string | undefined,
  policy: DelegationPolicy,
  request: ExecutionRequest,
): Promise<WorkerTemplate> {
  const fixed = policy.selectionMode === 'fixed';
  const fixedId = policy.fixedProfileId || mainProfileId;
  invariant(!fixed || !request.profileId || request.profileId === fixedId,
    'worker_executor_fixed', '此角色已指定子任务执行器，请使用指定配置。');
  const profileId = (fixed ? fixedId : request.profileId) || mainProfileId || policy.allowedProfileIds[0];
  invariant(
    profileId && (profileId === mainProfileId || policy.allowedProfileIds.includes(profileId)),
    'worker_model_grant',
    '所选执行模型未获角色授权。',
  );
  const scope = await Promise.all(
    policy.workspaces.map(async (root) => ({
      path: projectRoot(await realpath(root.path), dirname(store.path)),
      write: root.write,
    })),
  );
  const check = async (path: string, write: boolean) => {
    const canonical = projectRoot(await realpath(path), dirname(store.path));
    invariant(
      request.fullAccess || scope.some((root) => within(root.path, canonical) && (!write || root.write)),
      'worker_workspace_grant',
      '子任务请求的目录或写入权限超出角色授权。',
    );
    return canonical;
  };
  invariant(!request.fullAccess || policy.allowFullAccess, 'worker_full_access', '角色未授权委派本机完全访问。');
  const write = request.fullAccess || (request.write ?? false);
  const selected =
    request.projectDirectory ?? scope.find((root) => !write || root.write)?.path ?? '';
  invariant(!write || selected || request.fullAccess, 'worker_workspace_grant', '修改文件需要一个获准写入的工作目录。');
  const projectDirectory = selected ? await check(selected, write) : '';
  const workspaces = await Promise.all(
    (request.workspaces ?? []).map(async (root) => ({
      path: await check(root.path, root.write),
      write: root.write,
    })),
  );
  invariant(
    !workspaces.some((root) => root.write) || write,
    'worker_workspace_grant',
    '附加目录写入需要启用本次任务的文件修改。',
  );
  invariant(
    !request.terminal || (policy.terminal && write && policy.approvals === 'ask'),
    'worker_terminal_grant',
    '此角色未允许所请求的终端执行。',
  );
  invariant(
    !write || policy.approvals === 'ask',
    'worker_approval_grant',
    '角色不允许审批执行，不能创建写入任务。',
  );
  const role = store.document<RoleToolGrants>('characters', personaId);
  const parentPermissions = roleToolGrants(store, role);
  const ceiling = new Set(role?.independentToolGrants ? policy.toolPermissions ?? [] :
    (policy.toolPermissions ?? parentPermissions).filter((p) => parentPermissions.includes(p)));
  const toolPermissions =
    request.toolPermissions ?? [...ceiling].filter((p) => p.endsWith('.read'));
  invariant(
    toolPermissions.every((p) => ceiling.has(p)),
    'worker_tool_grant',
    '子任务请求的工具权限超出角色授权。',
  );
  const timeoutMinutes = request.timeoutMinutes ?? Math.min(20, policy.timeoutMinutes);
  invariant(
    timeoutMinutes <= policy.timeoutMinutes,
    'worker_timeout_grant',
    '子任务时限超过角色授权上限。',
  );
  return workerTemplate.parse({
    id: 'task',
    name: '子任务',
    ...request,
    reasoning: request.reasoning && request.reasoning !== 'inherit' ? request.reasoning : policy.defaultReasoning,
    contextBlocks: request.contextBlocks ?? policy.contextBlocks,
    compaction: request.compaction ?? policy.compaction,
    maxOutputTokens: request.maxOutputTokens ?? policy.maxOutputTokens,
    profileId,
    projectDirectory,
    workspaces,
    write,
    approvals: policy.approvals,
    toolPermissions,
    timeoutMinutes,
  });
}
