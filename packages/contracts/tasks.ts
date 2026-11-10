/** A task's lifetime is independent of the duration or outcome of any one run. */
export type TaskLifetime = 'once' | 'continuous';
export type TaskContextMode = 'continue' | 'fresh';
export type TaskLifecycle = 'active' | 'paused' | 'ended';
export function taskPresentation(task: {
  lifetime?: TaskLifetime;
  lifecycle?: TaskLifecycle;
  state: string;
  acceptanceStatus?: string;
}) {
  const ended =
    task.lifecycle === 'ended' ||
    (task.lifetime !== 'continuous' &&
      (task.state === 'cancelled' ||
        (task.state === 'completed' && task.acceptanceStatus === 'accepted')));
  const label =
    task.lifecycle === 'paused'
      ? '已暂停'
      : ended
        ? task.state === 'cancelled'
          ? '已停止'
          : '已完成'
        : task.state === 'completed'
          ? task.acceptanceStatus === 'accepted'
            ? '等待触发'
            : task.acceptanceStatus === 'needs-work'
              ? '需要返工'
              : '待验收'
          : ((
              {
                queued: '等待执行',
                running: '执行中',
                waiting: '等待确认',
                failed: '执行失败',
                cancelled: '已停止',
                unknown: '结果待核对',
              } as Record<string, string>
            )[task.state] ?? '等待触发');
  return { ended, label };
}
