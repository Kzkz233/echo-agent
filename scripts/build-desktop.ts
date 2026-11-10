import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { rustEnvironment } from './rust-environment.ts';
const root = resolve(import.meta.dirname, '..');
function run(command: string, args: string[], cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32' && command === 'pnpm',
    env: rustEnvironment(root),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(command + ' ' + args.join(' ') + ' failed');
}
// The bundle reads dist/runtime. Never update that directory concurrently with Tauri/NSIS.
run('cargo', ['build', '--release'], join(root, 'native'));
run('pnpm', ['run', 'build']);
run('pnpm', ['exec', 'tsx', 'scripts/package-runtime.ts']);
run('pnpm', ['exec', 'tsx', 'scripts/licenses.ts']);
run(
  'pnpm',
  ['exec', 'tauri', 'build', ...(process.argv.includes('--no-bundle') ? ['--no-bundle'] : [])],
  join(root, 'apps/desktop'),
);
