import { mkdir, mkdtemp, readFile, realpath, stat, writeFile, rm } from 'node:fs/promises';
import { join, sep, resolve } from 'node:path';
import { invariant } from '../../packages/contracts/index.ts';

export async function packAvatar(directory: string, manifest: 'manifest.json') {
  if (!directory) return {};
  const root = await realpath(directory);
  const assets: Record<string, string> = {};
  let bytes = 0;
  for (const name of [manifest, 'atlas.png']) {
    const path = await realpath(join(root, name));
    invariant(path.startsWith(root + sep), 'package_asset_path', '素材文件超出了所选目录。');
    bytes += (await stat(path)).size;
    invariant(
      bytes <= 7500000,
      'package_asset_size',
      '角色包素材超过 7.5 MB，请压缩图集后再导出。',
    );
    assets[name] = (await readFile(path)).toString('base64');
  }
  return assets;
}

export async function unpackAvatar<T>(
  root: string,
  assets: Record<string, string>,
  manifest: 'manifest.json',
  importAsset: (directory: string) => Promise<T>,
) {
  const names = Object.keys(assets);
  invariant(
    names.length === 2 && names.includes(manifest) && names.includes('atlas.png'),
    'package_assets',
    '角色包素材需要图集和对应的动画描述。',
  );
  invariant(
    names.reduce((sum, name) => sum + assets[name].length, 0) <= 10000000,
    'package_asset_size',
    '角色包素材超过限制。',
  );
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, 'role-package-'));
  try {
    for (const name of names) {
      invariant(
        /^[A-Za-z0-9+/]*={0,2}$/.test(assets[name]) && assets[name].length % 4 === 0,
        'package_assets',
        '素材编码无效。',
      );
      await writeFile(join(staging, name), Buffer.from(assets[name], 'base64'));
    }
    return await importAsset(staging);
  } finally {
    if (resolve(staging).startsWith(resolve(root) + sep))
      await rm(staging, { recursive: true, force: true });
  }
}
