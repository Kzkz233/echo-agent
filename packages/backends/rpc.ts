import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EchoError } from '../contracts/index.ts';

export class StdioRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private listeners = new Set<(method: string, params: any) => void>();
  private lines;
  private stopped = false;
  constructor(
    command: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
    onRequest?: (method: string, params: any, id: string | number) => Promise<unknown>,
  ) {
    this.child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {}); // Credentials and provider logs never enter UI or durable history.
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      if (line.length > 16000000) return;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        if (onRequest) {
          void Promise.resolve()
            .then(() => onRequest(message.method, message.params, message.id))
            .then(
              (result) => {
                if (!this.stopped)
                  this.child.stdin.write(
                    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n',
                  );
              },
              (error) => {
                if (!this.stopped)
                  this.child.stdin.write(
                    JSON.stringify({
                      jsonrpc: '2.0',
                      id: message.id,
                      error: {
                        code: -32001,
                        message: error instanceof Error ? error.message : 'Operation denied',
                      },
                    }) + '\n',
                  );
              },
            );
          return;
        }
        this.child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32001, message: 'Echo has not granted this interactive action.' },
          }) + '\n',
        );
        return;
      }
      if (message.id !== undefined) {
        const p = this.pending.get(message.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(message.id);
        message.error
          ? p.reject(new EchoError('rpc_error', message.error.message ?? '后端拒绝请求。'))
          : p.resolve(message.result);
      } else if (message.method)
        for (const fn of this.listeners) fn(message.method, message.params);
    });
    const fail = () => {
      if (this.stopped) return;
      this.stopped = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new EchoError('rpc_disconnected', '后端进程已断开，需要核对执行结果。', true));
      }
      this.pending.clear();
      for (const fn of this.listeners) fn('echo/disconnected', {});
    };
    this.child.on('exit', fail);
    this.child.on('error', fail);
    this.child.stdin.on('error', fail);
  }
  call(method: string, params: unknown, timeoutMs = 30000,
    activity?: () => number): Promise<any> {
    if (this.stopped) return Promise.reject(new EchoError('rpc_disconnected', '后端未连接。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const expire = () => {
        // A live tool loop is not a missing RPC acknowledgement. Only callers
        // with scoped progress evidence opt in to an inactivity deadline.
        const remaining = activity ? Math.min(timeoutMs - (Date.now() - activity()),
          1800000 - (Date.now() - started)) : 0;
        if (remaining > 0) {
          const pending = this.pending.get(id);
          if (pending) pending.timer = setTimeout(expire, remaining);
          return;
        }
        this.pending.delete(id);
        reject(new EchoError('rpc_timeout', `后端操作 ${method} 未取得回执。`, true));
      };
      const timer = setTimeout(expire, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new EchoError('rpc_write', '后端写入失败。', true));
          }
        },
      );
    });
  }
  notify(method: string, params: unknown = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  subscribe(fn: (method: string, params: any) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async close() {
    this.lines.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill();
    });
  }
}
