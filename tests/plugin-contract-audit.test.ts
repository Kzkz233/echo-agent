import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { z } from 'zod';
import { setup, project } from './helpers.ts';
import { sections } from '../apps/workbench/src/navigation.ts';
const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
test('all bundled settings and static UI RPC parameters agree with their registered owners', async (t) => {
  const app = await setup(t);
  for (const id of app.plugins.plugins.keys()) await app.plugins.enable(id);
  const failures: string[] = [],
    operations = new Map(app.registry.list(ui).map((op) => [op.name, op]));
  let calls = 0,
    fields = 0;
  await app.router.inference.refresh();
  let adapterFields = 0;
  for (const adapter of app.router.inference.adapters())
    for (const [json, form] of [
      [adapter.connectionSchema, adapter.connectionFields],
      [adapter.modelSchema, adapter.modelFields],
    ] as const) {
      const validator = z.fromJSONSchema(json as any),
        defaults = validator.safeParse({});
      for (const field of form) {
        adapterFields++;
        const property = (json as any).properties?.[field.key];
        if (!property) failures.push(`${adapter.id}.${field.key}: missing schema property`);
        if (
          field.type === 'string-list' &&
          (property?.type !== 'array' || property.items?.type !== 'string')
        )
          failures.push(`${adapter.id}.${field.key}: line editor requires a string array`);
        if (field.options && defaults.success)
          for (const value of field.options)
            if (!validator.safeParse({ ...(defaults.data as object), [field.key]: value }).success)
              failures.push(`${adapter.id}.${field.key}: invalid adapter option ${value}`);
        for (const key of Object.keys(field.optionLabels ?? {}))
          if (!field.options?.includes(key))
            failures.push(`${adapter.id}.${field.key}: label for an unavailable option`);
      }
    }
  for (const plugin of app.plugins.plugins.values()) {
    const schema: any = plugin.config?.schema,
      defaults = schema?.safeParse({});
    for (const field of plugin.manifest.settings ?? []) {
      fields++;
      if (!schema?.shape?.[field.key])
        failures.push(`${plugin.manifest.id}.${field.key}: missing configuration field`);
      if (field.options && defaults?.success)
        for (const value of field.options)
          if (!schema.safeParse({ ...defaults.data, [field.key]: value }).success)
            failures.push(`${plugin.manifest.id}.${field.key}: invalid option ${value}`);
    }
  }
  const shapes = (schema: any): Set<string> =>
    schema?.shape
      ? new Set(Object.keys(schema.shape))
      : schema?.options
        ? new Set(schema.options.flatMap((s: any) => [...shapes(s)]))
        : new Set();
  const visit = (node: any, file: string) => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'CallExpression' &&
      node.callee?.name === 'rpc' &&
      node.arguments?.[0]?.type === 'StringLiteral'
    ) {
      calls++;
      const name = node.arguments[0].value,
        op = operations.get(name);
      if (!op) failures.push(`${file}: unavailable operation ${name}`);
      else if (node.arguments[1]?.type === 'ObjectExpression') {
        const keys = shapes(op.input);
        if (keys.size)
          for (const p of node.arguments[1].properties ?? [])
            if (p.type === 'ObjectProperty' && !p.computed) {
              const key = p.key?.name ?? p.key?.value;
              if (key && !keys.has(key)) failures.push(`${file}: ${name} ignores input ${key}`);
            }
      }
    }
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments'].includes(key)) {
        if (Array.isArray(value)) value.forEach((v) => visit(v, file));
        else if (value && typeof value === 'object') visit(value, file);
      }
  };
  for (const file of await readdir(join(project, 'apps/workbench/src')))
    if (/\.tsx?$/.test(file))
      visit(
        parse(await readFile(join(project, 'apps/workbench/src', file), 'utf8'), {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
        }),
        file,
      );
  const ids = sections.flatMap((s) => s.views.map((v) => v.id));
  assert.equal(new Set(ids).size, ids.length, 'No duplicate navigation views');
  const viewOwners = new Map<string, string>();
  for (const plugin of app.plugins.plugins.values()) {
    for (const view of plugin.manifest.views ?? []) {
      if (!ids.includes(view)) failures.push(`${plugin.manifest.id}: view ${view} has no page`);
      if (viewOwners.has(view)) failures.push(`${view}: duplicate view ownership`);
      viewOwners.set(view, plugin.manifest.id);
    }
    for (const dep of [...plugin.manifest.dependencies, ...(plugin.manifest.enhances ?? [])])
      if (!app.plugins.plugins.has(dep))
        failures.push(`${plugin.manifest.id}: missing relationship ${dep}`);
  }
  for (const point of app.capabilities.points()) {
    const plugin = app.plugins.plugins.get(point.owner);
    if (plugin && !plugin.manifest.permissions.includes(point.consumePermission))
      failures.push(`${point.id}: owner has not declared consumer permission`);
  }
  for (const op of operations.values()) {
    if (op.owner === 'core') continue;
    const owner = app.plugins.plugins.get(op.owner);
    if (owner && !owner.manifest.permissions.includes(op.permission))
      failures.push(`${op.name}: undeclared permission`);
  }
  await mkdir(join(project, 'test-results'), { recursive: true });
  await writeFile(
    join(project, 'test-results/plugin-contract-audit.json'),
    JSON.stringify(
      {
        plugins: app.plugins.active.size,
        operations: operations.size,
        staticCalls: calls,
        settings: fields,
        adapterFields,
        views: ids.length,
        failures,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, []);
});
test('every bundled plugin retracts its operations/providers and releases resources through repeated unload', async (t) => {
  const app = await setup(t);
  const optional = [...app.plugins.plugins.keys()].filter((id) => !app.plugins.isBuiltin(id));
  for (const id of optional) await app.plugins.enable(id);
  for (const id of [...optional].reverse()) {
    await app.plugins.disable(id);
    assert(
      !app.registry.list(ui).some((op) => op.owner === id),
      id + ' left operations registered',
    );
    assert(
      !app.capabilities.list().some((p) => p.owner === id),
      id + ' left a provider registered',
    );
    await app.plugins.enable(id);
  }
  for (const id of [...optional].reverse()) await app.plugins.disable(id);
  assert.deepEqual([...app.plugins.active.keys()].sort(), ['assets','channels','clock','delegation','documents','embeddings','files','knowledge','local-models','models','notifications','persona','scheduler','storage']);
  assert.equal(app.clock.pending, 0);
  assert.equal(app.capabilities.list().filter((p) => p.owner !== 'core' && !app.plugins.isBuiltin(p.owner)).length, 0);
});
