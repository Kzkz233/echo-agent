/** UI grouping never widens the backend's capability decisions. */
export function modelEligible(
  profile: any,
  {
    taskId,
    executor = false,
    backendKinds,
  }: { taskId?: string; executor?: boolean; backendKinds?: string[] } = {},
) {
  return Boolean(
    profile?.available &&
    (!backendKinds || backendKinds.includes(profile.kind)) &&
    (taskId
      ? profile.eligibility?.tasks?.includes(taskId)
      : executor
        ? profile.eligibility?.worker
        : profile.eligibility?.conversation),
  );
}
