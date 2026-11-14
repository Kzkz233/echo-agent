import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** One loopback-only server, owned by the IPC guardian. No shell, global ports or shared credentials. */
export class LocalServer {
  private child?: ChildProcess;
  private base = '';
  private token = randomUUID();
  async close() {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        if (child.connected) child.disconnect();
        done();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      if (child.connected) child.send({ type: 'stop' });
    });
  }
  async start(
    root: string,
    command: string,
    args: string[],
    signal: AbortSignal,
    timeoutMs: number,
  ) {
    signal.throwIfAborted();
    const port = await new Promise<number>((ok, no) => {
      const server = createServer();
      server.once('error', no);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as any).port;
        server.close(() => ok(port));
      });
    });
    this.base = `http://127.0.0.1:${port}`;
    const alias = 'echo-' + randomUUID(),
      source = join(root, 'packages/kernel/process-guardian.ts');
    const child = fork(existsSync(source) ? source : join(root, 'dist/process-guardian.mjs'), [], {
      execArgv: existsSync(source) ? ['--import', 'tsx'] : [],
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP },
    });
    this.child = child;
    let failure = '';
    child.on('error', (error) => {
      failure = error.message;
    });
    child.on('message', (message: any) => {
      if (message.type === 'failure') failure = message.message;
      if (message.type === 'exited') failure = `本地模型退出 (${message.code}): ${message.tail}`;
    });
    child.send({
      type: 'start',
      command: resolve(command),
      args: [
        ...args,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--alias',
        alias,
        '--api-key',
        this.token,
        '--no-webui',
      ],
    });
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (failure || child.exitCode !== null) throw Error(failure || '本地模型进程提前退出');
        try {
          const data = await this.json(
            '/v1/models',
            undefined,
            AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          );
          if (!data.data?.some((model: any) => model.id === alias)) throw Error('本地模型身份不符');
          return;
        } catch (error: any) {
          if (error.message === '本地模型身份不符') throw error;
        }
        await delay(100, undefined, { signal });
      }
      throw Error('本地模型启动超时');
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async json(path: string, body: unknown, signal: AbortSignal): Promise<any> {
    const result = await fetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!result.ok) {
      const error = (await result.json().catch(() => ({}))) as any;
      throw Error(
        `本地模型 HTTP ${result.status}: ${String(error?.error?.message ?? '')
          .replace(/data:[^ ]+/g, '[media]')
          .slice(0, 400)}`,
      );
    }
    return result.json();
  }
}
