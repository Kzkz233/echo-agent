import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';
try {
  const entries = unzipSync(Buffer.from(workerData.data, 'base64'), {
    filter: (f) =>
      f.originalSize <= 48000000 && /(?:\.md|\.(?:png|jpe?g|webp|gif|svg))$/i.test(f.name),
  });
  const markdown = Object.keys(entries).filter((n) => /(^|\/)full\.md$/i.test(n));
  if (markdown.length !== 1) throw Error('解析结果缺少唯一的 full.md');
  const main = markdown[0],
    base = main.slice(0, -'full.md'.length),
    text = new TextDecoder().decode(entries[main]);
  if (text.length > 16000000) throw Error('解析正文超过大小上限');
  let bytes = 0;
  const assets = [];
  for (const [path, data] of Object.entries(entries)) {
    if (path === main || !path.startsWith(base) || !/\.(png|jpe?g|webp|gif|svg)$/i.test(path))
      continue;
    const name = path.slice(base.length);
    if (name.startsWith('/') || name.split('/').includes('..')) throw Error('解析附件路径无效');
    bytes += data.byteLength;
    if (bytes > 48000000 || assets.length >= 1000) throw Error('解析附件超过大小上限');
    const ext = name.split('.').at(-1)!.toLowerCase(),
      mimeType = 'image/' + (ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext);
    assets.push({ name, mimeType, data: Buffer.from(data).toString('base64') });
  }
  parentPort!.postMessage({ result: { text, assets } });
} catch (e) {
  parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
}
