import { readFile } from 'node:fs/promises';
import { collectUIStrings } from './ui-strings.mjs';
const catalog = JSON.parse(
  await readFile(new URL('../apps/workbench/src/locales.json', import.meta.url), 'utf8'),
);
const known = new Set(catalog.flat()),
  identity = new Set(['Echo', 'E', 'e', 'v', ' MB', ' · v', '· v']);
const used = await collectUIStrings(),
  missing = used.filter((s) => !known.has(s) && !identity.has(s));
if (missing.length) throw Error('Missing UI translations: ' + JSON.stringify(missing));
console.log(`UI translations verified: ${used.length} static strings and plugin metadata`);
