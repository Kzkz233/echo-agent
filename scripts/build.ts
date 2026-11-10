import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { version } from '../packages/contracts/version.ts';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: {
    server: 'apps/server/main.ts',
    cli: 'apps/cli/main.ts',
    'embedding-worker': 'plugins/local-models/embedding-worker.ts',
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
});
await viteBuild({ configFile: 'apps/workbench/vite.config.ts' });
await writeFile(
  'dist/build-info.json',
  JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2),
);
