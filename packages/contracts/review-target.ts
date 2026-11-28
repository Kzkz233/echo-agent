import { z } from 'zod';
import { id, invariant } from './index.ts';

/** Target-owned fields beyond the common proposal (title, text, sources and operation). */
export const reviewActionSchemas = z.record(id, z.record(z.string(), z.unknown()));
export type ReviewActionSchemas = z.infer<typeof reviewActionSchemas>;
export function targetActionFields(action: { subjectId?: string; expectedVersion?: number; attributes?: unknown }) {
  return {
    ...(action.subjectId !== undefined && { subjectId: action.subjectId }),
    ...(action.expectedVersion !== undefined && { expectedVersion: action.expectedVersion }),
    ...(action.attributes !== undefined && { attributes: action.attributes }),
  };
}

export function targetActionIssue(schemas: ReviewActionSchemas | undefined,
  action: Parameters<typeof targetActionFields>[0] & {operation?: string}) {
  if (!schemas) return;
  const operation = action.operation ?? 'add';
  if (!Object.hasOwn(schemas, operation)) return '可用操作：' + Object.keys(schemas).join('、');
  const schema = schemas[operation];
  const result = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(targetActionFields(action));
  if (!result.success) {
    const errors = result.error.issues.map(issue => [issue.path.join('.'), issue.message].filter(Boolean).join(' · '));
    return errors.join('；') + '。' + JSON.stringify(schema);
  }
}

export function assertTargetAction(schemas: ReviewActionSchemas | undefined, action: Parameters<typeof targetActionIssue>[1]) {
  const issue = targetActionIssue(schemas, action);
  invariant(!issue, 'review_invalid_action', issue ?? '');
}
