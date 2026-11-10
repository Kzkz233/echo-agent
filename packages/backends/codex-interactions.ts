import type { GenerateRequest } from '../contracts/index.ts';

export async function answerCodex(
  request: GenerateRequest,
  method: string,
  params: any,
  fileChanges: unknown,
  signal: AbortSignal,
) {
  const ask = request.onInteraction;
  if (method === 'item/tool/requestUserInput') {
    if (!ask) return { answers: {} };
    const answer = await ask(
      {
        kind: 'questions',
        questions: params.questions.map((q: any) => ({
          id: q.id,
          text: q.question,
          options: q.options ?? [],
          custom: q.isOther || q.isSecret || !q.options?.length,
          secret: q.isSecret,
        })),
      },
      signal,
    );
    return {
      answers:
        answer.decision === 'answer'
          ? Object.fromEntries(
              answer.answers.map((a) => [
                a.id,
                { answers: [...a.selected, ...(a.custom ? [a.custom] : [])] },
              ]),
            )
          : {},
    };
  }
  const command = method === 'item/commandExecution/requestApproval';
  const files = method === 'item/fileChange/requestApproval';
  const permissions = method === 'item/permissions/requestApproval';
  if (!command && !files && !permissions) throw Error('Unsupported Codex host request');
  const deny = () =>
    permissions
      ? { permissions: {}, scope: 'turn' }
      : {
          decision:
            params.availableDecisions && !params.availableDecisions.includes('decline')
              ? 'cancel'
              : 'decline',
        };
  if (!ask || request.permissions?.codex.approvals !== 'ask') return deny();
  const detail = JSON.stringify(
    {
      reason: params.reason,
      command: params.command,
      cwd: params.cwd,
      network: params.networkApprovalContext,
      permissions: params.permissions ?? params.additionalPermissions,
      root: params.grantRoot,
      changes: fileChanges,
    },
    null,
    2,
  );
  const canAllow =
    (!params.availableDecisions || params.availableDecisions.includes('accept')) &&
    (permissions
      ? !!params.permissions
      : files
        ? !!(fileChanges || params.grantRoot)
        : !!(params.command || params.networkApprovalContext));
  if (detail.length > 32000) return deny();
  const answer = await ask(
    {
      kind: 'approval',
      title: params.networkApprovalContext
        ? 'Codex · 网络访问'
        : command
          ? 'Codex · 执行命令'
          : files
            ? 'Codex · 修改文件'
            : 'Codex · 访问权限',
      detail,
      canAllow,
    },
    signal,
  );
  if (answer.decision === 'allow' && canAllow)
    return permissions
      ? { permissions: params.permissions, scope: 'turn' }
      : { decision: 'accept' };
  if (answer.decision === 'cancel' && !permissions) return { decision: 'cancel' };
  return deny();
}
