import { parse } from '@babel/parser';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
export async function collectUIStrings() {
  const strings = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'StringLiteral' &&
      /\p{Script=Han}/u.test(node.value) &&
      node.value.length < 400
    )
      strings.add(node.value);
    if (
      node.type === 'CallExpression' &&
      node.callee?.name === 't' &&
      node.arguments[0]?.type === 'StringLiteral'
    )
      strings.add(node.arguments[0].value);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments'].includes(key)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
  }
  for (const file of await readdir(join(root, 'apps/workbench/src'))) {
    if (!/\.tsx?$/.test(file)) continue;
    visit(
      parse(await readFile(join(root, 'apps/workbench/src', file), 'utf8'), {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
      }),
    );
  }
  for (const directory of await readdir(join(root, 'plugins'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(join(root, 'plugins', directory.name, 'echo-plugin.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    strings.add(manifest.name);
    if (manifest.category) strings.add(manifest.category);
    strings.add(manifest.description);
    for (const field of manifest.settings ?? []) {
      strings.add(field.label);
      if (field.description) strings.add(field.description);
    }
  }
  const providers = await readFile(join(root, 'plugins/mail/providers.ts'), 'utf8');
  visit(parse(providers, { sourceType: 'module', plugins: ['typescript'] }));
  const metadata = (node) => {
    if (!node || typeof node !== 'object') return;
    if(node.type==='ObjectProperty' && node.key?.name==='presets' && node.value?.type==='ArrayExpression')
      for(const item of node.value.elements??[]){const name=item?.properties?.find(p=>p.key?.name==='name')?.value;if(name?.type==='StringLiteral')strings.add(name.value);}
    if (
      node.type === 'ObjectProperty' &&
      (node.key?.name ?? node.key?.value) === 'label' &&
      node.value?.type === 'StringLiteral'
    )
      strings.add(node.value.value);
    for (const [key, value] of Object.entries(node))
      if (!['loc', 'extra', 'comments'].includes(key)) {
        if (Array.isArray(value)) value.forEach(metadata);
        else if (value && typeof value === 'object') metadata(value);
      }
  };
  for (const path of [
    'packages/backends/catalog.ts',
    'packages/kernel/inference.ts',
    'plugins/delegation/config.ts',
    ...['local-models', 'embeddings', 'memory', 'review', 'observation', 'semantic'].map(
      (id) => 'plugins/' + id + '/index.ts',
    ),
  ])
    metadata(
      parse(await readFile(join(root, path), 'utf8'), {
        sourceType: 'module',
        plugins: ['typescript'],
      }),
    );
  return [...strings];
}
