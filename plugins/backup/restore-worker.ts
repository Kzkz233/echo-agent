import { workerData, parentPort } from 'node:worker_threads';
import { mkdir, readdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { InstanceLock } from '../../packages/kernel/instance.ts';
import { packageTables, type PackageLocation } from './extension-archive.ts';
import { ownedAsset, restoreAssetPaths, type SavedPath } from './portable-assets.ts';
import { packageMetadata, packagePath } from '../../packages/kernel/plugin-package.ts';
const safe = (rel: string) =>
  rel !== '' &&
  rel !== '..' &&
  !rel.startsWith('..\\') &&
  !rel.startsWith('../') &&
  !isAbsolute(rel);
async function run() {
  const { directory, target, migrate = false } = workerData,
    base = await realpath(directory),
    manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  if (
    !['echo-backup-v1', 'echo-backup-v2'].includes(manifest.format) ||
    !Array.isArray(manifest.files)
  )
    throw Error('不是 Echo 备份');
  if (migrate && manifest.format !== 'echo-backup-v2')
    throw Error('迁移需要包含扩展安装文件的新版备份');
  const packages: PackageLocation[] = manifest.format === 'echo-backup-v2' ? manifest.packages : [];
  if (!Array.isArray(packages)) throw Error('无效的扩展包清单');
  const fileHashes = new Map<string, string>();
  for (const row of manifest.files) {
    packagePath(row.path);
    if (fileHashes.has(row.path.toLowerCase())) throw Error('备份包含重复路径');
    fileHashes.set(row.path.toLowerCase(), row.hash);
    const source = await realpath(resolve(base, row.path));
    if (!safe(relative(base, source))) throw Error('备份路径越界');
    const hash = createHash('sha256');
    for await (const data of createReadStream(source)) hash.update(data);
    if (hash.digest('hex') !== row.hash) throw Error('备份校验失败');
  }
  const assets: SavedPath[] = manifest.assets?.saved ?? [];
  const assetPath = (path: string) =>
    assets.some(
      (a) => ownedAsset(a.owner, path) && (path === a.path || path.startsWith(a.path + '/')),
    );
  const packagePaths = new Set<string>();
  for (const record of packages) {
    const sub = packagePath(record.directory).split('/');
    if (
      !packageTables.some((ns) => ns === record.namespace) ||
      sub.length !== 3 ||
      sub[0] !== 'extensions' ||
      sub[1] !== record.id
    )
      throw Error('无效的扩展安装位置');
    const metadataFile = record.directory + '/echo-package.json';
    if (!fileHashes.has(metadataFile.toLowerCase())) throw Error('缺少扩展清单');
    const meta = packageMetadata.parse(
      JSON.parse(await readFile(join(base, metadataFile), 'utf8')),
    );
    packagePaths.add(metadataFile);
    if (!meta.files[packagePath(meta.entry)] || !meta.files['echo-plugin.json'])
      throw Error('缺少扩展入口');
    for (const [name, hash] of Object.entries(meta.files)) {
      const path = record.directory + '/' + packagePath(name);
      if (fileHashes.get(path.toLowerCase()) !== hash) throw Error('扩展文件完整性校验失败');
      packagePaths.add(path);
    }
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
        !(row.path.startsWith('plugin-data/') && assetPath(row.path.slice(12))) &&
        !packagePaths.has(row.path) &&
        row.path !== 'echo.sqlite' &&
        row.path !== 'semantic/index.sqlite' &&
        !row.path.startsWith('vaults/') &&
        !/^chat-attachments\/[a-f0-9]{64}$/.test(row.path) &&
        !row.path.startsWith('observations/')
      )
        throw Error('备份包含未知条目');
      if (packagePaths.has(row.path) && !migrate) continue;
      const path = resolve(
        destination,
        row.path.startsWith('plugin-data/') ? row.path.slice(12) : row.path,
      );
      if (!safe(relative(destination, path))) throw Error('恢复路径越界');
      await mkdir(dirname(path), { recursive: true });
      await copyFile(
        resolve(base, row.path),
        path,
        (await import('node:fs')).constants.COPYFILE_EXCL,
      );
    }
    for (const dir of manifest.assets?.directories ?? []) {
      if (!assetPath(dir)) throw Error('无效扩展资料目录');
      await mkdir(join(destination, dir), { recursive: true });
    }
    const db = new DatabaseSync(join(destination, 'echo.sqlite'));
    try {
      db.exec('BEGIN IMMEDIATE');
      restoreAssetPaths(db, destination, assets);
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
      if (!migrate) {
        for (const feature of ['observation', 'review', 'care', 'avatar']) {
          const old = db.prepare('SELECT value FROM kv WHERE key=?').get(feature + '.config') as
            { value: string } | undefined;
          set(feature + '.config', { ...(old ? JSON.parse(old.value) : {}), enabled: false });
        }
        for (const key of ['observation.tasks', 'care.rules', 'review.tasks']) {
          const taskList = db.prepare('SELECT value FROM kv WHERE key=?').get(key) as
            { value: string } | undefined;
          if (taskList)
            set(
              key,
              JSON.parse(taskList.value).map((task: object) => ({ ...task, enabled: false })),
            );
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
      }
      for (const row of rows('channel-outbound')) {
        const delivery = JSON.parse(row.data);
        if (['pending', 'sending'].includes(delivery.state))
          db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(
            JSON.stringify({
              ...delivery,
              state: delivery.state === 'pending' ? 'skipped' : 'unknown',
            }),
            'channel-outbound',
            row.id,
          );
      }
      if (!migrate)
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
      const configured = db.prepare('SELECT value FROM kv WHERE key=?').get('plugins.intent') as
        { value: string } | undefined;
      const intent = JSON.parse(configured?.value ?? '{}');
      const previousEnabled = new Set<string>();
      for (const ns of packageTables)
        for (const row of rows(ns)) {
          const pack = migrate && packages.find((p) => p.namespace === ns && p.id === row.id);
          if (intent[row.id]) previousEnabled.add(row.id);
          if (!pack) {
            db.prepare('DELETE FROM documents WHERE namespace=? AND id=?').run(ns, row.id);
            continue;
          }
          const data = JSON.parse(row.data);
          const metadata = pack.directory + '/echo-package.json';
          if (!data.metadataHash || data.metadataHash !== fileHashes.get(metadata.toLowerCase()))
            throw Error('安装记录与包清单不匹配');
          data.directory = join(destination, pack.directory);
          const meta = packageMetadata.parse(
            JSON.parse(await readFile(join(destination, metadata), 'utf8')),
          );
          if (
            data.entry !== meta.entry ||
            data.runtime !== meta.runtime ||
            data.manifest.id !== row.id
          )
            throw Error('扩展安装记录不一致');
          if (meta.runtime === 'node') {
            data.manifest.command = 'node';
            data.manifest.args = [join(data.directory, meta.entry)];
          }
          db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(
            JSON.stringify(data),
            ns,
            row.id,
          );
        }
      for (const name of previousEnabled) intent[name] = false;
      set('plugins.intent', intent);
      set('restore.info', {
        source: base,
        at: new Date().toISOString(),
        automaticFeaturesDisabled: !migrate,
        extensionsToEnable: [...previousEnabled],
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
      automaticFeaturesDisabled: !migrate,
    };
  } finally {
    lock.release();
  }
}
run().then(
  (result) => parentPort!.postMessage({ result }),
  (e) => parentPort!.postMessage({ error: e instanceof Error ? e.message : '恢复失败' }),
);
