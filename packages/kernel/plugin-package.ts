import { unzipSync, zipSync, strToU8 } from 'fflate';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { manifestSchema } from './registry.ts';
import { invariant } from '../contracts/index.ts';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const maxBytes = 100 * 1024 * 1024;
export function packagePath(value: string) {
  invariant(
    value.length > 0 &&
      value.length < 240 &&
      !value.includes('\\') &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every(
          (part) =>
            !!part &&
            !['.', '..'].includes(part) &&
            !/[<>:"|?*\x00-\x1f]/.test(part) &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    'package_path',
    '插件包含无效路径：' + value,
  );
  return value;
}
export const packageMetadata = z.object({
  format: z.literal('echo-plugin-v1'),
  entry: z.string(),
  runtime: z.enum(['node', 'module']),
  hostApi: z.literal(1).optional(),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
/** Inspect central-directory metadata before decompression to bound allocations and reject links. */
function checkZip(bytes: Buffer) {
  invariant(bytes.length <= maxBytes && bytes.length >= 22, 'package_size', '插件包大小无效');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  invariant(
    end >= 0 && bytes.readUInt32LE(end) === 0x06054b50,
    'package_zip',
    '插件包 ZIP 目录无效',
  );
  const count = bytes.readUInt16LE(end + 10),
    offset = bytes.readUInt32LE(end + 16);
  invariant(
    count > 0 &&
      count <= 4096 &&
      bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0,
    'package_zip',
    '不支持分卷或过大的插件包',
  );
  let position = offset,
    total = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    invariant(
      position + 46 <= end && bytes.readUInt32LE(position) === 0x02014b50,
      'package_zip',
      '插件包目录损坏',
    );
    const length = bytes.readUInt16LE(position + 28),
      extra = bytes.readUInt16LE(position + 30),
      comment = bytes.readUInt16LE(position + 32);
    const size = bytes.readUInt32LE(position + 24),
      mode = bytes.readUInt32LE(position + 38) >>> 16;
    invariant(
      position + 46 + length + extra + comment <= end &&
        !(bytes.readUInt16LE(position + 8) & 1) &&
        [0, 8].includes(bytes.readUInt16LE(position + 10)) &&
        (mode & 0xf000) !== 0xa000,
      'package_entry',
      '不支持加密、链接或特殊压缩条目',
    );
    const name = packagePath(
      bytes.subarray(position + 46, position + 46 + length).toString('utf8'),
    );
    invariant(!names.has(name.toLowerCase()), 'package_collision', '插件包含重复路径');
    names.add(name.toLowerCase());
    total += size;
    invariant(
      size <= 32 * 1024 * 1024 && total <= maxBytes,
      'package_size',
      '插件包解压后超过大小限制',
    );
    position += 46 + length + extra + comment;
  }
  return names;
}
export async function inspectPluginPackage(path: string) {
  const bytes = await readFile(path),
    names = checkZip(bytes);
  const files = unzipSync(bytes, {
    filter: (entry) => {
      packagePath(entry.name);
      invariant(entry.originalSize <= 32 * 1024 * 1024, 'package_size', '插件条目过大');
      return true;
    },
  });
  invariant(
    Object.keys(files).length === names.size &&
      files['echo-package.json'] &&
      files['echo-plugin.json'],
    'package_manifest',
    '插件包缺少清单',
  );
  const meta = packageMetadata.parse(
    JSON.parse(Buffer.from(files['echo-package.json']).toString('utf8')),
  );
  const manifest = manifestSchema.parse(
    JSON.parse(Buffer.from(files['echo-plugin.json']).toString('utf8')),
  );
  invariant(
    meta.runtime !== 'module' || meta.hostApi === 1,
    'package_api',
    '此扩展需要不受支持的宿主 API',
  );
  invariant(
    !manifest.package?.startsWith('@echo/'),
    'extension_identity',
    '@echo/ 命名空间保留给内置包',
  );
  packagePath(meta.entry);
  invariant(
    /\.(mjs|cjs|js)$/.test(meta.entry) && files[meta.entry],
    'package_entry',
    '插件入口不存在或不是 JavaScript',
  );
  const expected = Object.keys(meta.files);
  invariant(
    expected.length === Object.keys(files).length - 1,
    'package_hash',
    '插件包文件列表不一致',
  );
  for (const name of expected) {
    packagePath(name);
    invariant(
      files[name] && hash(files[name]) === meta.files[name],
      'package_hash',
      '插件文件校验失败：' + name,
    );
  }
  return { manifest, meta, files, sha256: hash(bytes), bytes: bytes.length };
}
export async function extractPluginPackage(path: string, destination: string) {
  const inspected = await inspectPluginPackage(path);
  await mkdir(destination, { recursive: false });
  for (const [name, bytes] of Object.entries(inspected.files)) {
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return inspected;
}
/** Export only an explicit allowlist; never sweep a user's directory into a shareable package. */
export async function packPlugin(
  directory: string,
  target: string,
  entry: string,
  included: string[],
  runtime: 'node' | 'module' = 'node',
) {
  const root = await realpath(directory),
    files: Record<string, Uint8Array> = {};
  for (const name of new Set(['echo-plugin.json', ...included, entry])) {
    packagePath(name);
    const path = join(root, name),
      resolved = await realpath(path),
      rel = relative(root, resolved);
    invariant(
      !isAbsolute(rel) && !rel.startsWith('..') && !(await lstat(path)).isSymbolicLink(),
      'package_path',
      '打包文件必须位于插件目录内',
    );
    invariant(
      !/(^|\/)(\.env(?:\..*)?|credentials|master\.key|.*\.secret|.*\.sqlite(?:-wal|-shm)?)(\/|$)/i.test(
        name,
      ),
      'package_private',
      '插件包不能包含凭据或运行数据库',
    );
    files[name] = await readFile(path);
  }
  invariant(
    Object.keys(files).some((name) => /(^|\/)licen[cs]e(?:\.|$)/i.test(name)),
    'package_license',
    '插件包必须包含许可证文件',
  );
  files['echo-package.json'] = strToU8(
    JSON.stringify({
      format: 'echo-plugin-v1',
      runtime,
      entry,
      ...(runtime === 'module' ? { hostApi: 1 } : {}),
      files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])),
    }),
  );
  const bytes = zipSync(files);
  checkZip(Buffer.from(bytes));
  await writeFile(target, bytes, { flag: 'wx' });
  return { target, files: Object.keys(files).length, bytes: bytes.length };
}
