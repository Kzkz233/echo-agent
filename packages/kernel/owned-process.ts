import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
/** IPC guardian kills its single child even if the owning core exits unexpectedly. No shell. */
export async function ownedProcess(
  root: string,
  command: string,
  args: string[],
  signal: AbortSignal,
  env: Record<string, string> = {},
) {
  signal.throwIfAborted();
  const source = join(root, 'packages/kernel/process-guardian.ts');
  const p = fork(existsSync(source) ? source : join(root, 'dist/process-guardian.mjs'), [], {
    execArgv: existsSync(source) ? ['--import', 'tsx'] : [],
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      USERPROFILE: process.env.USERPROFILE,
    },
  });
  try {
    await new Promise<void>((ok, no) => {
      const cleanup = () => signal.removeEventListener('abort', abort),
        abort = () => {
          if (p.connected) p.send({ type: 'stop' });
          cleanup();
          no(Error('本地进程已取消'));
        };
      p.on('message', (m: any) => {
        if (m.type === 'failure') {
          cleanup();
          no(Error(m.message));
        } else if (m.type === 'exited') {
          cleanup();
          m.code === 0 ? ok() : no(Error(`本地进程退出 (${m.code}): ${m.tail}`));
        }
      });
      p.once('error', (e) => {
        cleanup();
        no(e);
      });
      p.once('exit', (code) => {
        cleanup();
        if (code !== 0) no(Error(`本地监护进程退出 (${code})`));
      });
      signal.addEventListener('abort', abort, { once: true });
      p.send({ type: 'start', command, args, env });
      if (signal.aborted) abort();
    });
  } finally {
    if (p.connected) p.disconnect();
    await new Promise<void>((done) => {
      if (p.exitCode !== null) {
        done();
        return;
      }
      const timer = setTimeout(done, 5000);
      p.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}
