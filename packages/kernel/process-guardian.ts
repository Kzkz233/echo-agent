// Owns just one explicitly configured executable. IPC disconnect also covers abrupt core exit.
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
let child: ChildProcess | undefined,
  tail = '',
  stopping = false;
const stop = () => {
  stopping = true;
  if (child && child.exitCode === null) child.kill();
  else process.exit(0);
};
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', (m: any) => {
  if (m.type === 'stop') {
    stop();
    return;
  }
  if (m.type !== 'start' || child || stopping) return;
  child = spawn(m.command, m.args, {
    cwd: dirname(m.command),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...m.env },
  });
  child.stderr?.on('data', (b) => {
    tail = (tail + b.toString()).slice(-1500);
  });
  child.on('error', (e) => {
    if (process.connected) process.send?.({ type: 'failure', message: e.message });
    process.exit(1);
  });
  child.on('exit', (code) => {
    if (!stopping && process.connected)
      process.send?.({ type: 'exited', code, tail }, () => process.exit(code ?? 0));
    else process.exit(code ?? 0);
  });
});
