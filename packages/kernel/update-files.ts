import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { updateManifestSchema, updatePath, type UpdateManifest } from '../contracts/update.ts';
import { buildSchema, type BuildInfo } from '../contracts/build.ts';

export async function fileHash(path: string, bytes?: number) {
  const hash = createHash('sha256');
  const size = bytes ?? (await lstat(path)).size;
  if (size <= 1024 ** 2) return hash.update(await readFile(path)).digest('hex');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export function contained(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('..' + sep) &&
    !resolve(rel).startsWith('\\\\') &&
    !rel.includes(':')
  );
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path);
      break;
    } catch (error) {
      if (
        attempt >= 30 ||
        !['EPERM', 'EACCES', 'EBUSY', 'EEXIST'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}
export async function jsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
export async function fileInventory(root: string) {
  const files: UpdateManifest['files'] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Update packages cannot contain linked files');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const name = updatePath.parse(relative(root, path).split(sep).join('/'));
        files.push({ path: name, bytes: 0, sha256: '' });
      } else throw Error('Unsupported update package entry');
    }
  }
  await walk(root);
  await eachFile(files, async (file) => {
    const path = join(root, file.path);
    file.bytes = (await lstat(path)).size;
    file.sha256 = await fileHash(path, file.bytes);
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function verifyApp(root: string, manifest: UpdateManifest, executable = 'Echo.exe') {
  const approved = new Set(
    manifest.files.map((file) => (file.path === 'Echo.exe' ? executable : file.path).toLowerCase()),
  );
  if ((await lstat(root)).isSymbolicLink()) throw Error('Update directory cannot be a link');
  async function inspect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Update packages cannot contain links');
      if (entry.isDirectory()) await inspect(path);
      else if (!approved.has(relative(root, path).split(sep).join('/').toLowerCase()))
        throw Error('Unlisted update package file');
    }
  }
  await inspect(root);
  await eachFile(manifest.files, async (file) => {
    const path = join(root, file.path === 'Echo.exe' ? executable : file.path);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.size !== file.bytes ||
      (await fileHash(path, info.size)) !== file.sha256
    )
      throw Error('Update file verification failed');
  });
  const installed = buildSchema.parse(await jsonFile(join(root, 'runtime/dist/build-info.json')));
  if (JSON.stringify(installed) !== JSON.stringify(manifest.build))
    throw Error('Update build information differs');
}
// Bound I/O and memory while keeping small-file checks from serializing on every
// filesystem round trip. Settle all readers before an error can trigger cleanup.
async function eachFile<T>(files: readonly T[], run: (file: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (next < files.length) {
      const file = files[next++];
      await run(file);
    }
  });
  const results = await Promise.allSettled(workers);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
export async function readUpdateManifest(directory: string, current: BuildInfo) {
  const parsed = updateManifestSchema.safeParse(await jsonFile(join(directory, 'update.json')));
  if (!parsed.success) throw Error('更新包格式或文件清单无效。');
  const manifest = parsed.data;
  if (
    manifest.build.edition !== current.edition ||
    manifest.build.dataVersion !== current.dataVersion
  )
    throw Error('更新包与当前发行渠道或数据格式不兼容。');
  return manifest;
}
