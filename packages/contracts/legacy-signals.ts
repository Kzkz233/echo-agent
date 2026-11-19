// Frozen identities of pre-namespaced requests and channel opt-ins. New events
// always use the declaring provider's namespace; changing old keys would replay work.
const unscoped = new Set(['observation.interesting', 'care.opportunity', 'mail-triggers.arrived']);
export function hasScopedSignalKey(kind: unknown): kind is string {
  return typeof kind === 'string' && !unscoped.has(kind);
}

export function legacyNoticeSelector(kind: string, source: string) {
  if (kind === 'review.completed' || kind === 'review.failed') return 'review';
  return hasScopedSignalKey(kind) ? 'signal:' + kind : source;
}
