import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, readFile } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { installTransaction, updatePlanSchema, updateRoot } from './update-transaction.ts';
import { jsonFile, atomicJson } from './update-files.ts';

const delay = () => new Promise((done) => setTimeout(done, 200));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function main() {
  const transaction = resolve(process.argv[2]);
  const plan = updatePlanSchema.parse(
    JSON.parse(await readFile(join(transaction, 'plan.json'), 'utf8')),
  );
  let trial: ChildProcess | undefined;
  await atomicJson(join(transaction, 'helper-ready.json'), { pid: process.pid, id: plan.id });
  await installTransaction(plan, transaction, {
    async stopped() {
      for (let attempt = 0; attempt < 225; attempt++) {
        if (!alive(plan.desktopPid) && !alive(plan.backendPid)) return;
        await delay();
      }
      throw Error('Echo 未能完整退出，更新未应用。');
    },
    async snapshot(destination) {
      const db = new DatabaseSync(join(plan.dataRoot, 'echo.sqlite'), { readOnly: true });
      try {
        await backup(db, destination);
      } finally {
        db.close();
      }
      const check = new DatabaseSync(destination, { readOnly: true });
      try {
        if (Object.values(check.prepare('PRAGMA quick_check').get()!)[0] !== 'ok')
          throw Error('更新前数据快照校验失败。');
      } finally {
        check.close();
      }
      // The connection token and lock belong to exited processes and are never copied.
      const marker = await jsonFile(join(plan.dataRoot, 'storage-location.json'));
      if (marker)
        await copyFile(
          join(plan.dataRoot, 'storage-location.json'),
          join(transaction, 'storage-location.json'),
        );
    },
    async launch(isTrial) {
      const child = spawn(join(plan.appRoot, plan.executable), [], {
        cwd: plan.appRoot,
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
        env: {
          ...process.env,
          ECHO_DATA_DIR: plan.anchor,
          ECHO_UPDATE_TRANSACTION: isTrial ? transaction : '',
          ECHO_UPDATE_TOKEN: isTrial ? plan.id : '',
          ECHO_WEBVIEW_DEBUG_PORT: '',
          ECHO_WEBVIEW_TEST_DIR: '',
        },
      });
      await new Promise<void>((done, reject) => {
        child.once('spawn', done);
        child.once('error', reject);
      });
      child.unref();
      if (isTrial) trial = child;
    },
    async healthy() {
      for (let attempt = 0; attempt < 450; attempt++) {
        const ready = await jsonFile<{ id: string; buildId: string }>(
          join(transaction, 'healthy.json'),
        );
        if (ready?.id === plan.id && ready.buildId === plan.manifest.build.buildId) return;
        if (trial && trial.exitCode !== null) throw Error('新版桌面程序启动失败。');
        await delay();
      }
      throw Error('新版桌面或后端未通过启动验收。');
    },
    async stopTrial() {
      const connection = await jsonFile<{ pid: number; url: string; token: string }>(
        join(plan.dataRoot, 'connection.json'),
      );
      if (connection && /^http:\/\/127\.0\.0\.1:\d+$/.test(connection.url)) {
        const response = await fetch(connection.url + '/rpc', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + connection.token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'updates.abortTrial',
            params: { id: plan.id },
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => undefined);
        if (response?.ok) await delay();
      }
      if (trial?.pid && trial.exitCode === null && alive(trial.pid)) {
        // The helper owns this exact trial child. Terminate its startup tree if its
        // backend never became ready enough for graceful shutdown.
        const stop = spawn('taskkill.exe', ['/PID', String(trial.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        await new Promise<void>((done, reject) => {
          stop.once('error', reject);
          stop.once('exit', () => done());
        });
      }
      for (let attempt = 0; attempt < 150; attempt++) {
        if (
          (!trial?.pid || !alive(trial.pid)) &&
          (!connection?.pid || connection.pid === plan.backendPid || !alive(connection.pid))
        )
          return;
        await delay();
      }
      throw Error('新版进程仍在运行。');
    },
  });
}
main().catch(async (error) => {
  const issue = error instanceof Error ? error.message : String(error);
  process.stderr.write(issue + '\n');
  // Leave the transaction and old files available for inspection even if the helper fails.
  const transaction = resolve(process.argv[2] ?? '.');
  const plan = await jsonFile<any>(join(transaction, 'plan.json')).catch(() => undefined);
  if (plan?.id && transaction === join(updateRoot(plan.appRoot), plan.id))
    await atomicJson(join(updateRoot(plan.appRoot), 'journal.json'), {
      id: plan.id,
      phase: 'failed',
      before: plan.before,
      after: plan.manifest.build,
      at: new Date().toISOString(),
      issue: '更新助手未能完成：' + issue,
    });
  process.exitCode = 1;
});
