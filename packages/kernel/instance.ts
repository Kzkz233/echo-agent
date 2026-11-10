import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EchoError } from '../contracts/index.ts';
export class InstanceLock {
  private constructor(
    readonly path: string,
    readonly identity: string,
  ) {}
  static acquire(root: string) {
    const path = join(root, 'instance.lock');
    const identity = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeFileSync(
            fd,
            JSON.stringify({ pid: process.pid, identity, createdAt: new Date().toISOString() }),
          );
        } finally {
          closeSync(fd);
        }
        return new InstanceLock(path, identity);
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        const bytes = readFileSync(path);
        let record: any;
        try {
          record = JSON.parse(bytes.toString());
        } catch {
          if (Date.now() - statSync(path).mtimeMs < 10000)
            throw new EchoError('already_starting', 'Echo 核心正在启动。');
        }
        if (record?.pid) {
          try {
            process.kill(record.pid, 0);
            throw new EchoError(
              'already_running',
              '此数据目录已有 Echo 核心运行，请连接现有实例。',
            );
          } catch (error: any) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        if (readFileSync(path).equals(bytes)) unlinkSync(path);
      }
    }
    throw new EchoError('instance_lock', '无法取得 Echo 数据目录的写入锁。');
  }
  release() {
    try {
      const record = JSON.parse(readFileSync(this.path, 'utf8'));
      if (record.identity === this.identity) unlinkSync(this.path);
    } catch {}
  }
}
