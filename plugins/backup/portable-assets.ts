import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { storagePathSchema, type StoragePaths } from '../../packages/contracts/storage.ts';
import { inside } from '../../packages/kernel/storage.ts';
import { packagePath } from '../../packages/kernel/plugin-package.ts';
import { invariant } from '../../packages/contracts/index.ts';

export type OwnerPaths = { owner: string; paths: StoragePaths[] };
export type SavedPath = {
  table: 'documents' | 'kv';
  collection: string;
  id: string;
  pointer: string[];
  owner: string;
  path: string;
};
export function ownedAsset(owner: string, path: string) {
  const root = packagePath(path).split('/')[0];
  return /^[a-z][\w-]*$/.test(owner) && (root === owner + '-assets' || root === owner + '-data');
}
function values(
  data: any,
  parts: string[],
  prefix: string[] = [],
): { pointer: string[]; value: string }[] {
  if (!parts.length) return typeof data === 'string' ? [{ pointer: prefix, value: data }] : [];
  if (!data || typeof data !== 'object') return [];
  const [key, ...rest] = parts;
  const keys = key === '*' && Array.isArray(data) ? Object.keys(data) : [key];
  return keys
    .filter((k) => Object.hasOwn(data, k))
    .flatMap((k) => values(data[k], rest, [...prefix, k]));
}
export async function collectAssets(
  db: DatabaseSync,
  runtime: string,
  owners: OwnerPaths[],
  record: (sub: string, path: string) => Promise<void>,
) {
  const saved: SavedPath[] = [],
    seen = new Set<string>(),
    dirs = new Set<string>();
  const visit = async (path: string) => {
    const rel = relative(runtime, path).split(sep).join('/');
    if (seen.has(rel)) return;
    seen.add(rel);
    const stat = await lstat(path);
    invariant(
      !stat.isSymbolicLink() && inside(runtime, await realpath(path)),
      'backup_link',
      '扩展资料含有外部链接',
    );
    if (stat.isDirectory()) {
      dirs.add(rel);
      for (const child of await readdir(path)) await visit(join(path, child));
    } else if (stat.isFile()) await record('plugin-data/' + rel, path);
  };
  for (const { owner, paths } of owners)
    for (const declaration of storagePathSchema.array().parse(paths)) {
      const rows = (
        declaration.table === 'documents'
          ? db.prepare('SELECT id,data FROM documents WHERE namespace=?')
          : db.prepare('SELECT key AS id,value AS data FROM kv WHERE key=?')
      ).all(declaration.collection) as { id: string; data: string }[];
      for (const row of rows)
        for (const raw of declaration.pointers)
          for (const { pointer, value } of values(JSON.parse(row.data), raw.slice(1).split('/'))) {
            if (
              !isAbsolute(value) ||
              !inside(runtime, value) ||
              resolve(runtime) === resolve(value)
            )
              continue;
            const path = relative(runtime, value).split(sep).join('/');
            if (!ownedAsset(owner, path)) continue;
            const exists = await lstat(value).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== 'ENOENT') throw e;
              return undefined;
            });
            if (!exists) continue;
            await visit(value);
            saved.push({
              table: declaration.table,
              collection: declaration.collection,
              id: row.id,
              pointer,
              owner,
              path,
            });
          }
    }
  return { saved, directories: [...dirs] };
}
export function restoreAssetPaths(db: DatabaseSync, target: string, saved: SavedPath[]) {
  for (const item of saved) {
    invariant(
      ownedAsset(item.owner, item.path) &&
        item.pointer.length > 0 &&
        item.pointer.every(
          (k) => /^[\w.-]+$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k),
        ),
      'backup_asset',
      '扩展路径无效',
    );
    const table = item.table === 'documents';
    const row = (
      table
        ? db
            .prepare('SELECT data FROM documents WHERE namespace=? AND id=?')
            .get(item.collection, item.id)
        : db.prepare('SELECT value AS data FROM kv WHERE key=?').get(item.collection)
    ) as { data: string } | undefined;
    if (!row) continue;
    const data = JSON.parse(row.data);
    let cursor = data;
    for (const key of item.pointer.slice(0, -1)) cursor = cursor?.[key];
    const key = item.pointer.at(-1)!;
    invariant(
      cursor &&
        typeof cursor[key] === 'string' &&
        isAbsolute(cursor[key]) &&
        cursor[key].replaceAll('\\', '/').endsWith('/' + item.path),
      'backup_asset',
      '扩展资料路径与快照记录不符',
    );
    cursor[key] = join(target, item.path);
    if (table)
      db.prepare('UPDATE documents SET data=? WHERE namespace=? AND id=?').run(
        JSON.stringify(data),
        item.collection,
        item.id,
      );
    else db.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(data), item.collection);
  }
}
