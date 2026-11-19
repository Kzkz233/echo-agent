import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { packageMetadata, packagePath } from '../../packages/kernel/plugin-package.ts';
import { inside } from '../../packages/kernel/storage.ts';
import { invariant } from '../../packages/contracts/index.ts';

export type PackageLocation = { namespace: string; id: string; directory: string };
export const packageTables = ['extensions', 'module-extensions', 'extension-rollback'] as const;
export async function packageFiles(runtime: string, row: any) {
  if (!row.sha256 || !row.metadataHash) return;
  const id = packagePath(row.manifest.id);
  invariant(!id.includes('/'), 'backup_package', '无效的扩展编号');
  const root = await realpath(join(runtime, 'extensions', id));
  const directory = await realpath(row.directory);
  const sub = relative(root, directory);
  invariant(
    inside(root, directory) && sub && !sub.includes(sep) && packagePath(sub) === sub,
    'backup_package',
    '扩展包目录超出安装位置',
  );
  const files: { name: string; path: string; hash: string }[] = [];
  const metadataPath = await realpath(join(directory, 'echo-package.json'));
  invariant(inside(directory, metadataPath), 'backup_package', '扩展元数据超出安装位置');
  const bytes = await readFile(metadataPath);
  invariant(
    createHash('sha256').update(bytes).digest('hex') === row.metadataHash,
    'backup_package',
    '扩展安装清单已变化',
  );
  const meta = packageMetadata.parse(JSON.parse(bytes.toString('utf8')));
  for (const [name, hash] of Object.entries({
    ...meta.files,
    'echo-package.json': row.metadataHash as string,
  })) {
    const path = await realpath(resolve(directory, packagePath(name)));
    invariant(inside(directory, path), 'backup_package', '扩展文件超出安装位置');
    files.push({ name, path, hash });
  }
  return { directory: 'extensions/' + id + '/' + sub, files };
}
