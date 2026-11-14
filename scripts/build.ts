import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildSchema } from '../packages/contracts/build.ts';
import { version } from '../packages/contracts/version.ts';
await mkdir('dist', { recursive: true });
const runtimeOnly = process.argv.includes('--runtime-only');
const info = buildSchema.parse(runtimeOnly ? JSON.parse(await readFile('dist/build-info.json', 'utf8')) : { version, edition: process.env.ECHO_EDITION ?? 'development', buildId: randomUUID(), builtAt: new Date().toISOString(), dataVersion: 1 });
if (info.version !== version || process.env.ECHO_EDITION && info.edition !== process.env.ECHO_EDITION)
  throw Error('Runtime rebuild must keep the existing version and edition');
if (!runtimeOnly) await writeFile('dist/build-info.json', JSON.stringify(info, null, 2));
await copyFile('resources/update-archive.ps1', 'dist/update-archive.ps1');
await build({
  entryPoints: {
    server: 'apps/server/main.ts',
    cli: 'apps/cli/main.ts',
    'embedding-worker': 'plugins/local-models/embedding-worker.ts',
    'vad-worker': 'plugins/asr/vad-worker.ts',
    'process-guardian': 'packages/kernel/process-guardian.ts',
    'document-result-worker': 'plugins/documents/result-worker.ts',
    'semantic-search-worker': 'plugins/semantic/search-worker.ts',
    'avatar-import-worker': 'plugins/avatar/import-worker.ts',
    'parse-worker': 'plugins/documents/parse-worker.ts',
    'library-export-worker': 'plugins/knowledge/export-worker.ts',
    'backup-worker': 'plugins/backup/backup-worker.ts',
    'restore-worker': 'plugins/backup/restore-worker.ts',
  },
  outdir: 'dist',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outExtension: { '.js': '.mjs' },
  sourcemap: true,
  define: { __ECHO_BUILD__: JSON.stringify(info) },
});
await build({ entryPoints: ['packages/kernel/update-helper.ts'], outfile: 'dist/update-helper.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24', define: { __ECHO_BUILD__: JSON.stringify(info) } });
if (!runtimeOnly) await viteBuild({ configFile: 'apps/workbench/vite.config.ts' });
