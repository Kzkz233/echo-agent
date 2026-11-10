/** Portable task values are declared by the task owner. Local resource bindings
 * and credentials are never inferred from the kind of selector used by the UI. */
export function portableTaskSettings(
  fields: { key: string; kind: string; portability?: 'value' | 'resource' | 'private' }[],
  values: Record<string, unknown>,
) {
  const allowed = new Set(
    fields
      .filter(
        (field) =>
          field.portability === 'value' ||
          (!field.portability && ['number', 'boolean', 'textarea'].includes(field.kind)),
      )
      .filter(
        (field) =>
          !/(api.?key|secret|credential|token|password|path|directory)/i.test(field.key) ||
          field.key === 'maxOutputTokens',
      )
      .map((field) => field.key),
  );
  allowed.add('name');
  return Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key)));
}
