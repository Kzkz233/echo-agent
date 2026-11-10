import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
/** On-demand bounded work; never leaves an idle worker resident. */
export async function workerTask<T>(
  root: string,
  name: string,
  source: string,
  input: unknown,
  signal: AbortSignal,
  timeout = 120000,
): Promise<T> {
  signal.throwIfAborted();
  const built = join(root, 'dist', name + '.mjs');
  const sourcePath = join(root, source),
    development = existsSync(sourcePath);
  const worker = new Worker(pathToFileURL(development ? sourcePath : built), {
    execArgv: development ? ['--import', 'tsx'] : [],
    workerData: input,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP },
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error('工作已取消或超时'));
      };
      const timer = setTimeout(abort, timeout);
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', (m) => {
        cleanup();
        m.error ? reject(new Error(m.error)) : resolve(m.result);
      });
      worker.once('error', (e) => {
        cleanup();
        reject(e);
      });
      worker.once('exit', (code) => {
        cleanup();
        reject(new Error('工作进程退出，代码 ' + code));
      });
    });
  } finally {
    await worker.terminate();
  }
}
