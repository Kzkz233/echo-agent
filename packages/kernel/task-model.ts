import type { Store } from './store.ts';

/** Move a plugin's old per-role override to existing tasks, including disabled ones. */
export function migrateTaskModelRoute<T extends { personaId: string }>(
  store: Store, storageKey: string, inferenceTask: string, field: string,
) {
  const tasks = store.get<(T & Record<string, unknown>)[] | null>(storageKey, null);
  const roles = new Map(store.documents<{ id: string; routes?: Record<string, string> }>('characters')
    .flatMap(role => role.routes?.[inferenceTask] ? [[role.id, role] as const] : []));
  if (!roles.size) return;
  store.transaction(() => {
    if (tasks) store.set(storageKey, tasks.map(task => {
      const legacy = roles.get(task.personaId)?.routes?.[inferenceTask];
      return legacy && !task[field] ? { ...task, [field]: legacy } : task;
    }));
    for (const [personaId, role] of roles) {
      const routes = { ...role.routes };
      delete routes[inferenceTask];
      store.put('characters', personaId, { ...role, routes });
    }
  });
}
