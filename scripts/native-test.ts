import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { rustEnvironment } from './rust-environment.ts';
const root = resolve(import.meta.dirname, '..');
const result = spawnSync(
  'cargo',
  process.argv.includes('--build')
    ? ['build', '--release', '--manifest-path', 'native/Cargo.toml']
    : ['test', '--release', '--lib', '--manifest-path', 'native/Cargo.toml'],
  { cwd: root, env: rustEnvironment(root), stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
