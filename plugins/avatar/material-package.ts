import { readFile, stat } from 'node:fs/promises';
import { unzipSync } from 'fflate';
export async function readMaterialFile(path: string, limit = 50000000) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw Error('素材文件超过大小限制或不是普通文件');
  return readFile(path);
}
export function materialArchive(bytes: Uint8Array) {
  let total = 0;
  const names = new Set<string>();
  const result = unzipSync(bytes, {
    filter: (file) => {
      const key = file.name.replaceAll('\\', '/');
      if (
        key.startsWith('/') ||
        /^[a-z]:/i.test(key) ||
        key.split('/').some((p) => p === '..' || p === '.') ||
        names.has(key)
      )
        throw Error('压缩包含越界路径或重复文件');
      names.add(key);
      if (names.size > 256) throw Error('素材包文件过多');
      if (!/\.(png|json)$/i.test(key)) return false;
      total += file.originalSize;
      if (total > 64000000 || file.originalSize > 50000000) throw Error('解压素材超过大小限制');
      return true;
    },
  });
  return Object.fromEntries(
    Object.entries(result).map(([name, value]) => [name.replaceAll('\\', '/'), value]),
  );
}
