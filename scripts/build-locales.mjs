import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { collectUIStrings } from './ui-strings.mjs';
const root = resolve(import.meta.dirname, '..');
const lines = (await readFile(join(root, 'scripts/ui-translations.tsv'), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean),
  known = new Map(),
  pairs = [];
for (const line of lines) {
  const [source, ...parts] = line.split('\t'),
    target = parts.join('\t');
  if (!target) throw Error('Invalid translation row: ' + source);
  const pair = /\p{Script=Han}/u.test(source) ? [source, target] : [target, source];
  pairs.push(pair);
  known.set(source, pair);
  for (const text of pair) known.set(text, pair);
}
const used = await collectUIStrings(),
  missing = [];
for (const source of used) {
  const key = source.trim();
  if (!known.has(key)) {
    missing.push(source);
    continue;
  }
  const pair = known.get(key),
    leading = source.match(/^\s*/)[0],
    trailing = source.match(/\s*$/)[0];
  if (leading || trailing) pairs.push(pair.map((v) => leading + v + trailing));
}
await writeFile(
  join(root, 'apps/workbench/src/locales.json'),
  JSON.stringify(pairs, null, 2) + '\n',
);
await mkdir(join(root, 'test-results'), { recursive: true });
await writeFile(
  join(root, 'test-results/missing-translations.json'),
  JSON.stringify(missing, null, 2),
);
console.log(JSON.stringify({ entries: pairs.length, missing: missing.length }));
if (missing.length) {
  console.log(JSON.stringify(missing, null, 2));
  process.exitCode = 1;
}
