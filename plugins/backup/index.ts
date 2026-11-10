import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { mkdir, readdir, readFile, lstat, rm, rename, realpath } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { workerTask } from '../../packages/kernel/worker-task.ts';
import type { Plugin } from '../../packages/kernel/registry.ts';
import { operations } from '../shared.ts';
const config = z.object({
  directory: z.string().default(''),
  keep: z.number().int().min(1).max(365).default(7),
});
const name = /^echo-backup-[\dT.-]+Z-[\w-]+$/;
export class Backups {
  private busy = false;
  constructor(
    readonly store: Store,
    readonly root: string,
  ) {}
  config() {
    return config.parse(this.store.get('backup.config', {}));
  }
  async run(signal: AbortSignal) {
    invariant(!this.busy, 'backup_busy', '备份正在进行');
    const c = this.config();
    invariant(c.directory, 'backup_directory', '请先选择备份目录');
    this.busy = true;
    try {
      await mkdir(c.directory, { recursive: true });
      const base = await realpath(c.directory),
        id = 'echo-backup-' + new Date().toISOString().replace(/:/g, '.') + '-' + randomUUID(),
        temp = join(base, '.incomplete-' + id),
        destination = join(base, id);
      const result = await workerTask<any>(
        this.root,
        'backup-worker',
        'plugins/backup/backup-worker.ts',
        { database: this.store.path, destination: temp },
        signal,
        600000,
      );
      signal.throwIfAborted();
      await rename(temp, destination);
      const completed = { ...result, directory: destination, at: new Date().toISOString() };
      this.store.set('backup.last', completed);
      const entries = (await readdir(base))
        .filter((p) => name.test(p))
        .sort()
        .reverse();
      for (const old of entries.slice(c.keep)) {
        const path = resolve(base, old);
        invariant(relative(base, path) === old, 'backup_path', '清理目标不在备份目录内');
        const info = await lstat(path);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          const m = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
          if (m.format === 'echo-backup-v1') await rm(path, { recursive: true });
        }
      }
      return completed;
    } finally {
      this.busy = false;
    }
  }
  async inspect(directory: string, signal: AbortSignal = new AbortController().signal) {
    return workerTask<any>(
      this.root,
      'restore-worker',
      'plugins/backup/restore-worker.ts',
      { directory },
      signal,
      600000,
    );
  }
  async restore(directory: string, target: string, signal: AbortSignal) {
    return workerTask<any>(
      this.root,
      'restore-worker',
      'plugins/backup/restore-worker.ts',
      { directory, target },
      signal,
      600000,
    );
  }
  plugin(): Plugin {
    return {
      config: { schema: config },
      manifest: defineManifest(packageManifest),
      activate: (ctx) => {
        const op = operations(ctx, 'backup');
        op('status', '备份状态', z.object({}), 'backup.read', () => ({
          busy: this.busy,
          last: this.store.get('backup.last', null),
        }));
        op('run', '生成完整备份', z.object({}), 'backup.write', (_v, s) => this.run(s), false);
        op(
          'inspect',
          '校验完整备份',
          z.object({ directory: z.string() }),
          'backup.read',
          (v, s) => this.inspect(v.directory, s),
          false,
        );
        op(
          'restore',
          '恢复到新的空数据目录；自动功能保持关闭',
          z.object({ directory: z.string(), target: z.string(), confirmed: z.literal(true) }),
          'backup.write',
          (v, s) => this.restore(v.directory, v.target, s),
          false,
        );
        ctx.capabilities.provide('scheduler.handlers@1', 'backup.run', 'Echo 完整备份', (_v, s) =>
          this.run(s),
        );
      },
    };
  }
}
