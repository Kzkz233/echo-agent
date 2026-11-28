import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { characterDraft, characterTask, type CharacterDraft } from './character-contracts.ts';

const key = z
  .string()
  .min(1)
  .max(256)
  .refine((k) => !['__proto__', 'constructor', 'prototype'].includes(k));
const field = z.object({
  path: z.array(key).min(1).max(32),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export const characterEdits = z.object({
  fields: z.array(field).max(4096),
  tasks: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('add'), task: characterTask }),
        z.object({ action: z.literal('edit'), type: id, id, fields: z.array(field).max(1024) }),
        z.object({ action: z.literal('remove'), task: characterTask }),
      ]),
    )
    .max(100),
});
type Edits = z.infer<typeof characterEdits>;
type Field = z.infer<typeof field>;
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (!object(a) || !object(b)) return false;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => equal(a[k], b[k]));
}
function diff(
  before: Record<string, any>,
  after: Record<string, any>,
  path: string[] = [],
): Field[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((k) => {
    const a = before[k],
      b = after[k],
      p = [...path, k];
    if (equal(a, b)) return [];
    if (object(a) && object(b)) return diff(a, b, p);
    return [{ path: p, before: a, after: b }];
  });
}
export const taskKey = (t: { type: string; id: string }) => JSON.stringify([t.type, t.id]);
export function editedCharacter(
  base: CharacterDraft,
  draft: CharacterDraft,
  removed: Set<string>,
): Edits {
  const { tasks: old, revision: _old, ...previous } = base;
  const { tasks: current, revision: _new, ...next } = draft;
  const tasks: Edits['tasks'] = [];
  for (const task of current) {
    const before = old.find((t) => taskKey(t) === taskKey(task));
    if (!before) tasks.push({ action: 'add', task });
    else {
      const fields = diff(before, task);
      if (fields.length) tasks.push({ action: 'edit', type: task.type, id: task.id, fields });
    }
  }
  for (const task of old)
    if (removed.has(taskKey(task)) && !current.some((t) => taskKey(t) === taskKey(task)))
      tasks.push({ action: 'remove', task });
  return { fields: diff(previous, next), tasks };
}
function applyFields(target: Record<string, any>, fields: Field[], allowed: string[]) {
  for (const { path, before, after } of fields) {
    invariant(
      allowed.includes(path[0]) &&
        !(path[0] === 'persona' && (path.length < 2 || path[1] === 'id')),
      'character_edit',
      '伙伴编辑字段无效。',
    );
    let node = target;
    for (const k of path.slice(0, -1)) {
      invariant(
        Object.hasOwn(node, k) && object(node[k]),
        'revision_conflict',
        '此配置已在其他窗口修改。',
      );
      node = node[k];
    }
    const k = path.at(-1)!;
    invariant(
      equal(node[k], before) || equal(node[k], after),
      'revision_conflict',
      '此配置已在其他窗口修改。',
    );
    if (after === undefined) delete node[k];
    else node[k] = structuredClone(after);
  }
}
export function mergeCharacter(current: CharacterDraft, edits: Edits): CharacterDraft {
  const result = structuredClone(current);
  applyFields(
    result,
    edits.fields,
    Object.keys(characterDraft.shape).filter((k) => !['tasks', 'revision'].includes(k)),
  );
  for (const edit of edits.tasks) {
    const ref = edit.action === 'edit' ? edit : edit.task;
    const index = result.tasks.findIndex((t) => taskKey(t) === taskKey(ref));
    const existing = result.tasks[index];
    if (edit.action === 'remove') {
      if (!existing) continue;
      invariant(
        equal(existing, edit.task),
        'revision_conflict',
        '任务配置已变化，请重新打开后确认移除。',
      );
      result.tasks.splice(index, 1);
    } else if (edit.action === 'add') {
      invariant(
        !existing || equal(existing, edit.task),
        'revision_conflict',
        '此任务编号已被使用。',
      );
      if (!existing) result.tasks.push(edit.task);
    } else {
      invariant(existing, 'revision_conflict', '任务已在其他窗口移除。');
      applyFields(existing, edit.fields, ['settings', 'templateId', 'enabledWhenAvailable']);
    }
  }
  return characterDraft.parse(result);
}
