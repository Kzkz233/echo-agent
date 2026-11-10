import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Cargo's encoded form preserves paths with spaces as single compiler flags. */
export function rustEnvironment(root: string, env: NodeJS.ProcessEnv = process.env) {
  const original = env.CARGO_ENCODED_RUSTFLAGS
    ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
    : (env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
  const mappings = new Map<string, string>();
  for (const [from, to] of [
    [homedir(), '/build/home'],
    [resolve(root), '/build/echo'],
  ] as const) {
    mappings.set(from, to);
    mappings.set(from.replaceAll('\\', '/'), to);
  }
  return {
    ...env,
    CARGO_INCREMENTAL: '0',
    CARGO_ENCODED_RUSTFLAGS: [
      ...original,
      ...[...mappings].map(([from, to]) => `--remap-path-prefix=${from}=${to}`),
    ].join('\x1f'),
  };
}
