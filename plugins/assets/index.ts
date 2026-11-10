import { Events } from '../../packages/kernel/events.ts';
import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Files } from '../files/index.ts';
import type { Plugin } from '../../packages/kernel/registry.ts';
import { operations } from '../shared.ts';
type Asset = { id: string; fileId: string; name: string; tags: string[]; mime: string };
const mime: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
export class Assets {
  constructor(
    readonly store: Store,
    readonly files: Files,
    readonly events?: Events,
  ) {}
  async import(
    v: { vaultId: string; source: string; name?: string; tags: string[] },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    this.files.assertWrite(v.vaultId, 'assets');
    const type = mime[extname(v.source).toLowerCase()];
    invariant(type, 'asset_type', '支持 PNG/JPEG/WebP/GIF 图片');
    const file = await this.files.import(v.vaultId, v.source, undefined, signal);
    signal?.throwIfAborted();
    const asset: Asset = {
      id: file.id,
      fileId: file.id,
      name: v.name ?? file.name,
      tags: v.tags,
      mime: type,
    };
    this.store.put('assets', asset.id, asset);
    this.events?.emit('assets.updated', {});
    return asset;
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(packageManifest),
      activate: (ctx) => {
        const op = operations(ctx, 'assets');
        op(
          'list',
          '查找素材',
          z.object({ query: z.string().default(''), vaultId: id.optional() }),
          'assets.read',
          async (v) => {
            const result = [];
            for (const r of this.store
              .documents<Asset>('assets')
              .filter((r) =>
                (r.name + ' ' + r.tags.join(' ')).toLowerCase().includes(v.query.toLowerCase()),
              )) {
              const file = await this.files.record(r.fileId);
              if (file && (!v.vaultId || file.vaultId === v.vaultId)) result.push({ ...r, file });
            }
            return result;
          },
        );
        op(
          'import',
          '导入图片素材',
          z.object({
            vaultId: id,
            source: z.string().min(1),
            name: z.string().optional(),
            tags: z.array(z.string().max(80)).max(30).default([]),
          }),
          'assets.write',
          (v, signal) => this.import(v, signal),
          false,
        );
        op(
          'preview',
          '读取小图预览',
          z.object({ id, size: z.number().int().min(64).max(600).default(600) }),
          'assets.read',
          async (v) => {
            const asset = this.store.document<Asset>('assets', v.id),
              file = asset && (await this.files.record(asset.fileId));
            invariant(asset && file, 'asset_missing', '素材不存在');
            const sharp = (await import('sharp')).default;
            const bytes = await readFile(await this.files.path(file.vaultId, file.relativePath));
            const preview = await sharp(bytes, { limitInputPixels: 40000000 })
              .resize(v.size, v.size, { fit: 'inside', withoutEnlargement: true })
              .webp({ quality: 75 })
              .toBuffer();
            return { ...asset, data: 'data:image/webp;base64,' + preview.toString('base64') };
          },
        );
      },
    };
  }
}
