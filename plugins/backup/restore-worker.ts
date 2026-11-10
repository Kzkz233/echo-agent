import { workerData, parentPort } from 'node:worker_threads';
import { mkdir, readdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { InstanceLock } from '../../packages/kernel/instance.ts';
const safe = (rel: string) =>
  rel !== '' &&
  rel !== '..' &&
  !rel.startsWith('..\\') &&
  !rel.startsWith('../') &&
  !isAbsolute(rel);
async function run() {
  const { directory, target } = workerData,
    base = await realpath(directory),
    manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'echo-backup-v1' || !Array.isArray(manifest.files))
    throw Error('不是 Echo 备份');
  for (const row of manifest.files) {
    const source = await realpath(resolve(base, row.path));
    if (!safe(relative(base, source))) throw Error('备份路径越界');
    const hash = createHash('sha256');
    for await (const data of createReadStream(source)) hash.update(data);
    if (hash.digest('hex') !== row.hash) throw Error('备份校验失败');
  }
  if (!target) return { ...manifest, valid: true };
  const destination = resolve(target);
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length) throw Error('恢复目标必须是新的空目录，不覆盖已有数据');
  const lock = InstanceLock.acquire(destination);
  try {
    await writeFile(
      join(destination, 'restore-incomplete.json'),
      JSON.stringify({ source: base, at: new Date().toISOString() }),
      { flag: 'wx' },
    );
    for (const row of manifest.files) {
      if (
        row.path !== 'echo.sqlite' &&
        row.path !== 'semantic/index.sqlite' &&
        !row.path.startsWith('vaults/') &&
        !/^chat-attachments\/[a-f0-9]{64}$/.test(row.path) &&
        !row.path.startsWith('observations/')
      )
        throw Error('备份包含未知条目');
      const path = resolve(destination, row.path);
      if (!safe(relative(destination, path))) throw Error('恢复路径越界');
      await mkdir(dirname(path), { recursive: true });
      await copyFile(
        resolve(base, row.path),
        path,
        (await import('node:fs')).constants.COPYFILE_EXCL,
      );
    }
    const db = new DatabaseSync(join(destination, 'echo.sqlite'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const rows = (ns: string) =>
        db.prepare('SELECT id,data FROM documents WHERE namespace=?').all(ns) as {
          id: string;
          data: string;
        }[];
      const set = (key: string, value: unknown) =>
        db
          .prepare(
            'INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          )
          .run(key, JSON.stringify(value));
      for (const row of rows('vaults')) {
        const vault = JSON.parse(row.data);
        if (!/^[\w][\w.-]*$/.test(vault.id)) throw Error('备份目录编号无效');
        vault.path = join(destination, 'vaults', vault.id);
        await mkdir(vault.path, { recursive: true });
        db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(
          JSON.stringify(vault),
          'vaults',
          row.id,
        );
      }
      for (const feature of ['observation', 'review', 'care', 'avatar']) {
        const old = db.prepare('SELECT value FROM kv WHERE key=?').get(feature + '.config') as
          { value: string } | undefined;
        set(feature + '.config', { ...(old ? JSON.parse(old.value) : {}), enabled: false });
      }
      for (const key of ['observation.tasks', 'care.rules', 'review.tasks']) {
        const taskList = db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
        if (taskList) set(key, JSON.parse(taskList.value).map((task: object) => ({ ...task, enabled: false })));
      }
      for (const row of rows('mail-trigger-rules'))
        db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(
          JSON.stringify({ ...JSON.parse(row.data), enabled: false }),
          'mail-trigger-rules',
          row.id,
        );
      for (const row of rows('scheduler-jobs'))
        db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(
          JSON.stringify({ ...JSON.parse(row.data), enabled: false, nextAt: undefined }),
          'scheduler-jobs',
          row.id,
        );
      for (const row of rows('channel-outbound')) {
        const delivery = JSON.parse(row.data);
        if (['pending', 'sending'].includes(delivery.state))
          db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(
            JSON.stringify({ ...delivery, state: delivery.state === 'pending' ? 'skipped' : 'unknown' }),
            'channel-outbound',
            row.id,
          );
      }
      for (const row of rows('agenda')) {
        const item = JSON.parse(row.data);
        if (item.reminder?.enabled)
          db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(
            JSON.stringify({ ...item, reminder: { ...item.reminder, enabled: false } }),
            'agenda',
            row.id,
          );
      }
      for (const row of db.prepare('SELECT id,data FROM receipts').all() as {
        id: string;
        data: string;
      }[]) {
        const v = JSON.parse(row.data);
        if (
          (v.kind === 'input' && ['queued', 'running'].includes(v.state)) ||
          (v.kind === 'bubble' && ['pending', 'claimed'].includes(v.state))
        )
          db.prepare('UPDATE receipts SET data=? WHERE id=?').run(
            JSON.stringify({ ...v, state: 'unknown', error: '从备份恢复，等待核对，未重放。' }),
            row.id,
          );
      }
      db.exec(
        "DELETE FROM bindings WHERE json_extract(data,'$.profileId') IN (SELECT p.id FROM documents p JOIN documents c ON c.namespace='connections' AND c.id=json_extract(p.data,'$.connectionId') WHERE p.namespace='profiles' AND json_extract(c.data,'$.adapterId') IN ('core.dsh','core.codex','worker-dsh.provider','worker-codex.provider'))",
      );
      for (const row of rows('extensions'))
        db.prepare('DELETE FROM documents WHERE namespace=? AND id=?').run('extensions', row.id);
      set('restore.info', {
        source: base,
        at: new Date().toISOString(),
        automaticFeaturesDisabled: true,
        nativeBindingsDetached: true,
        externalCodeDisabled: true,
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      db.close();
    }
    const { unlink } = await import('node:fs/promises');
    await unlink(join(destination, 'restore-incomplete.json'));
    return {
      restored: true,
      directory: destination,
      files: manifest.files.length,
      automaticFeaturesDisabled: true,
    };
  } finally {
    lock.release();
  }
}
run().then(
  (result) => parentPort!.postMessage({ result }),
  (e) => parentPort!.postMessage({ error: e instanceof Error ? e.message : '恢复失败' }),
);
