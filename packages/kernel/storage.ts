import { storagePathSchema, coreStoragePaths, type StoragePaths } from '../contracts/storage.ts';
import { InstanceLock } from './instance.ts';
import { readFile, writeFile, mkdir, readdir, lstat, realpath, statfs, copyFile, rename } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { invariant } from '../contracts/index.ts';

const ephemeral = new Set(['connection.json', 'instance.lock', 'storage-migration.json', 'storage-location.json']);
export async function snapshotDatabase(source: string, destination: string) {
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); } finally { db.close(); }
  const copy = new DatabaseSync(destination, { readOnly: true });
  try { invariant((copy.prepare('PRAGMA integrity_check').get() as any).integrity_check === 'ok', 'snapshot_integrity', '数据库快照校验失败'); }
  finally { copy.close(); }
}
export const inside = (root: string, target: string) => { const rel = relative(root, target); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')); };
async function json(path: string) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function atomic(path: string, value: unknown) {
  const temp = path + '.tmp'; await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temp, path);
}
export async function storageLocation(anchor: string) {
  const record = await json(join(anchor, 'storage-location.json'));
  invariant(!record || record.format === 'echo-storage-v1' && isAbsolute(record.path), 'storage_locator', '数据位置记录无效');
  return record?.path ?? anchor;
}
export async function restoreStorageLocation(anchor: string, source: string) {
  await atomic(join(anchor, 'storage-location.json'), { format: 'echo-storage-v1', path: source });
}
export async function storageInventory(root: string) {
  const files: { path: string; bytes: number }[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name), rel = relative(root, full);
      if (!rel.includes('/') && !rel.includes('\\') && ephemeral.has(entry.name)) continue;
      const info = await lstat(full);
      invariant(!info.isSymbolicLink(), 'storage_link', '数据目录含链接，请先将链接内容注册为外部资料：' + rel);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) files.push({ path: rel, bytes: info.size });
      else throw Error('不支持的存储项：' + rel);
    }
  };
  await walk(root); return files;
}
export async function planStorageMigration(source: string, destination: string) {
  const from = await realpath(source), to = resolve(destination);
  invariant(!inside(from, to) && !inside(to, from), 'storage_overlap', '新旧数据目录不能相同或互相包含');
  let parent = to;
  while (true) { try { await lstat(parent); break; } catch (e: any) { if (e.code !== 'ENOENT') throw e; parent = dirname(parent); } }
  invariant((await realpath(parent)).toLowerCase() === resolve(parent).toLowerCase(), 'storage_link', '目标目录不能经过链接');
  try { invariant((await readdir(to)).length === 0, 'storage_not_empty', '目标目录必须为空'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  const files = await storageInventory(from), bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const disk = await statfs(parent);
  invariant(disk.bavail * disk.bsize > bytes * 1.1 + 16_777_216, 'storage_space', '目标磁盘空间不足');
  return { source: from, destination: to, files: files.length, bytes, credentialsIncluded: true, externalFilesMoved: false };
}
async function digest(path: string) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }

/** Called only on startup, after acquiring the source instance lock and before opening any application DB. */
export async function applyStorageMigration(anchor: string, source: string, retainLock?: (lock: InstanceLock) => void) {
  const ticket = await json(join(source, 'storage-migration.json'));
  if (!ticket || ticket.state !== 'pending') return source;
  const plan = await planStorageMigration(source, ticket.destination);
  const target = plan.destination;
  await mkdir(target, { recursive: true });
  const targetLock = InstanceLock.acquire(target);
  let retained = false;
  try {
    await writeFile(join(target, 'storage-incomplete.json'), JSON.stringify({ source, at: new Date().toISOString() }), { flag: 'wx' });
    const files = await storageInventory(source);
    for (const file of files) {
      const from = join(source, file.path), to = join(target, file.path);
      await mkdir(dirname(to), { recursive: true }); await copyFile(from, to, constants.COPYFILE_EXCL);
      invariant(await digest(from) === await digest(to), 'storage_hash', '迁移文件校验失败：' + file.path);
    }
    for (const file of files.filter((file) => /\.sqlite$/i.test(file.path))) {
      const db = new DatabaseSync(join(target, file.path));
      try {
        invariant((db.prepare('PRAGMA integrity_check').get() as any).integrity_check === 'ok', 'storage_integrity', '数据库校验失败：' + file.path);
        // Only copied libraries are rebased. External libraries and the original
        // runtime remain untouched. Bodies and arbitrary metadata are never scanned.
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_meta'").get()&&
          (db.prepare("SELECT value FROM library_meta WHERE key='format'").get() as any)?.value==='echo-library-v1'){
          for(const table of ['files','entries','entry_revision_sources']){
            if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
            for(const row of db.prepare(`SELECT rowid,source_uri FROM ${table} WHERE source_uri IS NOT NULL`).all() as any[])
              if(isAbsolute(row.source_uri)&&inside(source,row.source_uri))db.prepare(`UPDATE ${table} SET source_uri=? WHERE rowid=?`).run(join(target,relative(source,row.source_uri)),row.rowid);
          }
        }
      } finally { db.close(); }
    }
    // Only registered path-bearing records are changed; persona and message text is never traversed.
    const db = new DatabaseSync(join(target, 'echo.sqlite'));
    try {
      const rewritePointer = (value: any, parts: string[]): any => {
        if (!parts.length) return typeof value === 'string' && isAbsolute(value) && inside(source, value)
          ? join(target, relative(source, value)) : value;
        if (!value || typeof value !== 'object') return value;
        const [key, ...rest] = parts;
        if (key === '*') return Array.isArray(value) ? value.map((entry) => rewritePointer(entry, rest)) : value;
        if (Object.hasOwn(value, key)) value[key] = rewritePointer(value[key], rest);
        return value;
      };
      const declarations = [...coreStoragePaths, ...storagePathSchema.array().parse(ticket.paths ?? legacyStoragePaths)];
      db.exec('BEGIN');
      for (const declaration of declarations) {
        const rows = declaration.table === 'documents'
          ? db.prepare('SELECT id,data FROM documents WHERE namespace=?').all(declaration.collection)
          : db.prepare('SELECT key AS id,value AS data FROM kv WHERE key=?').all(declaration.collection);
        for (const row of rows as { id: string; data: string }[]) {
          let value = JSON.parse(row.data);
          for (const pointer of declaration.pointers) value = rewritePointer(value, pointer.slice(1).split('/'));
          if (declaration.table === 'documents') db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(JSON.stringify(value), declaration.collection, row.id);
          else db.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(value), declaration.collection);
        }
      }
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
    await atomic(join(source, 'storage-migration.json'), { ...ticket, state: 'copied', destination: target });
    await atomic(join(target, 'storage-complete.json'), { source, files: files.length, at: new Date().toISOString() });
    const { unlink } = await import('node:fs/promises'); await unlink(join(target, 'storage-incomplete.json'));
    await atomic(join(anchor, 'storage-location.json'), { format: 'echo-storage-v1', path: target, previous: source });
    if (retainLock) { retainLock(targetLock); retained = true; }
    return target;
  } catch (error) {
    await atomic(join(source, 'storage-migration.json'), { ...ticket, state: 'failed', error: (error as Error).message });
    throw error;
  } finally { if (!retained) targetLock.release(); }
}
const legacyStoragePaths: StoragePaths[] = [
  { table: 'documents', collection: 'vaults', pointers: ['/path'] },
  ...['avatar-profiles','avatar-assets','character-settings.avatar'].map((collection) => ({ table: 'documents' as const, collection, pointers: ['/directory','/assetDirectory'] })),
  ...['avatar.config','local-models.config'].map((collection) => ({ table: 'kv' as const, collection, pointers: ['/directory','/assetDirectory','/cacheDir'] })),
];
export async function requestStorageMigration(source: string, destination: string, paths: StoragePaths[] = legacyStoragePaths) {
  const plan = await planStorageMigration(source, destination);
  await atomic(join(source, 'storage-migration.json'), { state: 'pending', paths: storagePathSchema.array().parse(paths), destination: plan.destination, requestedAt: new Date().toISOString() });
  return { ...plan, state: 'pending', requiresRestart: true };
}

export async function storageMigrationStatus(source: string) { return await json(join(source, 'storage-migration.json')) ?? null; }
export async function cancelStorageMigration(source: string) {
  const ticket = await storageMigrationStatus(source);
  invariant(ticket?.state === 'pending', 'migration_state', '当前没有待执行的数据迁移');
  await atomic(join(source, 'storage-migration.json'), { ...ticket, state: 'cancelled' });
  return { cancelled: true };
}
