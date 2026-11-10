import { parentPort, workerData } from 'node:worker_threads';
import { readFile, readdir, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, basename, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { materialArchive } from './material-package.ts';
import sharp from 'sharp';

const image = (data: Buffer) => sharp(data, { limitInputPixels: 16000000 });
async function run() {
  const { source, root, name, fps } = workerData;
  const path = await realpath(source),
    info = await stat(path),
    files = new Map<string, Buffer>();
  const read = async (path: string) => {
    const s = await stat(path);
    if (s.size > 50000000) throw Error('素材文件超过 50 MB');
    return readFile(path);
  };
  const petFile = info.isFile() && basename(path).toLowerCase() === 'pet.json';
  if (info.isDirectory() || petFile) {
    const directory = petFile ? resolve(path, '..') : path;
    const names = await readdir(directory, { withFileTypes: true });
    if (
      names.some((n) => n.name === 'pet.json') &&
      !names.some((n) => n.name === 'manifest.json')
    ) {
      const sprite = names.find((n) => /^spritesheet\.(webp|png)$/.test(n.name))?.name;
      if (!sprite) throw Error('PetDex 素材缺少 spritesheet.webp 或 spritesheet.png');
      for (const key of ['pet.json', sprite]) {
        const file = await realpath(join(directory, key));
        if (!file.startsWith(directory + sep)) throw Error('素材文件超出所选目录');
        files.set(key, await read(file));
      }
    } else if (names.some((n) => n.name === 'manifest.json')) {
      for (const key of ['manifest.json', 'atlas.png']) {
        const file = await realpath(join(path, key));
        if (!file.startsWith(path + sep)) throw Error('素材文件超出所选目录');
        files.set(key, await read(file));
      }
    } else {
      const frames = names
        .filter((n) => n.isFile() && /\.png$/i.test(n.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      if (!frames.length || frames.length > 120) throw Error('请选择包含 1–120 张 PNG 帧的目录');
      for (const frame of frames) files.set(frame.name, await read(join(path, frame.name)));
    }
  } else if (extname(path).toLowerCase() === '.zip') {
    const extracted = materialArchive(await read(path));
    const keys = Object.keys(extracted),
      manifests = keys.filter((k) => /(^|\/)(manifest|pet)\.json$/.test(k));
    if (manifests.length > 1) throw Error('压缩包包含多个素材包，请分别导入');
    const prefix = manifests[0]?.slice(0, manifests[0].lastIndexOf('/') + 1) ?? '';
    for (const key of keys) {
      const clean = key.slice(prefix.length);
      if (
        manifests.length
          ? key === prefix + 'manifest.json' ||
            key === prefix + 'atlas.png' ||
            key === prefix + 'pet.json' ||
            /^spritesheet\.(webp|png)$/.test(clean)
          : /\.png$/i.test(key)
      )
        files.set(clean, Buffer.from(extracted[key]));
    }
  } else {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(path))
      throw Error('支持 PNG/JPEG/WebP 图片、PNG 帧目录或 ZIP 素材包');
    files.set(basename(path), await read(path));
  }
  let atlas: Buffer, manifest: any;
  if (files.has('pet.json')) {
    const metadata = JSON.parse(files.get('pet.json')!.toString('utf8'));
    const sprite = files.get('spritesheet.webp') ?? files.get('spritesheet.png');
    if (!sprite) throw Error('PetDex 素材缺少图集');
    const size = await image(sprite).metadata(),
      w = size.width ?? 0,
      h = size.height ?? 0;
    const rows = [9, 11].find(
      (rows) => w > 0 && w % 8 === 0 && h % rows === 0 && w * rows * 208 === h * 8 * 192,
    );
    if (!rows) throw Error('PetDex 图集必须为 8×9 或 8×11 的等比例网格');
    const names = [
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review',
      'extra-9',
      'extra-10',
    ];
    const clips = Object.fromEntries(
      names.slice(0, rows).map((name, row) => [
        name,
        {
          fps,
          frames: Array.from({ length: 8 }, (_, column) => ({
            x: (column * w) / 8,
            y: (row * h) / rows,
            w: w / 8,
            h: h / rows,
          })),
        },
      ]),
    );
    // PetDex grids pad shorter actions with transparent cells. Keep intentional
    // interior gaps, but do not play empty trailing cells as disappearing frames.
    const pixels = await image(sprite).ensureAlpha().raw().toBuffer();
    for (const [name, clip] of Object.entries<any>(clips)) {
      while (clip.frames.length) {
        const frame = clip.frames.at(-1);
        let visible = false;
        for (let y = frame.y; y < frame.y + frame.h && !visible; y++)
          for (let x = frame.x; x < frame.x + frame.w; x++)
            if (pixels[(y * w + x) * 4 + 3]) {
              visible = true;
              break;
            }
        if (visible) break;
        clip.frames.pop();
      }
      if (!clip.frames.length) delete clips[name];
    }
    if (!clips.idle) throw Error('PetDex 素材缺少可见的 idle 动画');
    clips.walk = clips['running-right'] ?? clips.idle;
    clips.jump = clips.jumping ?? clips.idle;
    atlas = await image(sprite).png().toBuffer();
    manifest = {
      format: 'frame-atlas-v1',
      image: 'atlas.png',
      clips,
      sourceFormat: 'petdex',
      author: String(
        typeof metadata.author === 'object'
          ? (metadata.author?.name ?? '')
          : (metadata.author ?? ''),
      ).slice(0, 200),
      license: String(metadata.license ?? '').slice(0, 200),
      sourceName: String(metadata.name ?? '').slice(0, 160),
    };
  } else if (files.has('manifest.json')) {
    if (!files.has('atlas.png')) throw Error('素材包缺少 atlas.png');
    const input = JSON.parse(files.get('manifest.json')!.toString('utf8')),
      meta = await image(files.get('atlas.png')!).metadata();
    if (input.format !== 'frame-atlas-v1') throw Error('帧动画素材格式必须为 frame-atlas-v1');
    if (!meta.width || !meta.height) throw Error('图集尺寸无效');
    const clips: Record<string, any> = {};
    for (const [key, clip] of Object.entries<any>(input.clips ?? {})) {
      if (!Array.isArray(clip.frames) || !clip.frames.length || clip.frames.length > 120)
        throw Error('动画帧数量无效');
      let pixels = 0;
      const frames = clip.frames.map((f: any) => {
        if (
          !['x', 'y', 'w', 'h'].every(
            (k) => Number.isSafeInteger(f[k]) && f[k] >= (k === 'x' || k === 'y' ? 0 : 8),
          ) ||
          f.w > 1024 ||
          f.h > 1024 ||
          f.x + f.w > meta.width! ||
          f.y + f.h > meta.height!
        )
          throw Error('动画帧超出图集范围');
        pixels += f.w * f.h;
        return { x: f.x, y: f.y, w: f.w, h: f.h };
      });
      if (pixels > 4000000) throw Error('动画解码尺寸过大，请减少帧数或缩小图片');
      clips[key] = { fps: Math.max(1, Math.min(30, Math.round(clip.fps ?? fps))), frames };
    }
    if (!clips.idle) throw Error('素材包缺少 idle 动画');
    atlas = await image(files.get('atlas.png')!).png().toBuffer();
    manifest = {
      format: 'frame-atlas-v1',
      image: 'atlas.png',
      clips,
      author: String(input.author ?? '').slice(0, 200),
      license: String(input.license ?? '').slice(0, 200),
      source: String(input.source ?? '').slice(0, 2000),
      licenseUrl: String(input.licenseUrl ?? '').slice(0, 500),
      modifications: String(input.modifications ?? '').slice(0, 2000),
    };
  } else {
    const frames = [...files]
      .filter(([name]) => /\.(png|jpe?g|webp)$/i.test(name))
      .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
    if (!frames.length || frames.length > 120) throw Error('素材中没有有效图片');
    const normalized = [];
    let width = 8,
      height = 8;
    for (const [, data] of frames) {
      const result = await image(data)
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      width = Math.max(width, result.info.width);
      height = Math.max(height, result.info.height);
      normalized.push(result.data);
    }
    if (width * height * frames.length > 4000000)
      throw Error('动画解码尺寸过大，请减少帧数或缩小图片');
    const columns = Math.ceil(Math.sqrt(frames.length)),
      rows = Math.ceil(frames.length / columns),
      composites = [],
      rects = [];
    for (let n = 0; n < normalized.length; n++) {
      const data = await image(normalized[n])
        .resize(width, height, { fit: 'contain', background: '#00000000' })
        .png()
        .toBuffer();
      const left = (n % columns) * width,
        top = Math.floor(n / columns) * height;
      composites.push({ input: data, left, top });
      rects.push({ x: left, y: top, w: width, h: height });
    }
    atlas = await sharp({
      create: {
        width: width * columns,
        height: height * rows,
        channels: 4,
        background: '#00000000',
      },
    })
      .composite(composites)
      .png()
      .toBuffer();
    manifest = {
      format: 'frame-atlas-v1',
      image: 'atlas.png',
      clips: { idle: { fps: frames.length === 1 ? 1 : fps, frames: rects } },
    };
  }
  const text = JSON.stringify(manifest),
    hash = createHash('sha256').update(atlas).update(text).digest('hex'),
    id = 'avatar-' + hash.slice(0, 24),
    directory = resolve(root, id);
  if (!directory.startsWith(resolve(root) + sep)) throw Error('素材目标目录无效');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'atlas.png'), atlas);
  await writeFile(join(directory, 'manifest.json'), text);
  if (files.has('pet.json')) {
    const originals = join(directory, 'original');
    await mkdir(originals, { recursive: true });
    for (const [name, data] of files) await writeFile(join(originals, name), data);
  }
  const f = manifest.clips.idle.frames[0],
    preview = await image(atlas)
      .extract({ left: f.x, top: f.y, width: f.w, height: f.h })
      .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  return {
    id,
    kind: 'frames',
    format: 'frame-atlas-v1',
    name: name?.trim() || basename(source, extname(source)),
    directory,
    hash,
    frames: manifest.clips.idle.frames.length,
    fps: manifest.clips.idle.fps,
    width: f.w,
    height: f.h,
    preview: 'data:image/png;base64,' + preview.toString('base64'),
    author: manifest.author,
    license: manifest.license,
  };
}
run().then(
  (result) => parentPort!.postMessage({ result }),
  (error) =>
    parentPort!.postMessage({ error: error instanceof Error ? error.message : '素材导入失败' }),
);
