import { packPlugin } from '../packages/kernel/plugin-package.ts';
const moduleMode = process.argv.includes('--module');
const [directory, target, entry, ...files] = process.argv.slice(2).filter(value => value !== '--module');
if (!directory || !target || !entry || !files.length) throw Error('Usage: tsx scripts/package-plugin.ts <directory> <output.echo-plugin> <entry.mjs> <explicit files including LICENSE...>');
console.log(await packPlugin(directory, target, entry, files, moduleMode ? 'module' : 'node'));
