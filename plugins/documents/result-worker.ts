import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';
try {
  const entries = unzipSync(Buffer.from(workerData.data, 'base64'), {
    filter: (f) =>
      f.originalSize <= 48000000 && /(?:\.md|content_list(?:_v2)?\.json|\.(?:png|jpe?g|webp|gif|svg))$/i.test(f.name),
  });
  const markdown = Object.keys(entries).filter((n) => /(^|\/)full\.md$/i.test(n));
  if (markdown.length !== 1) throw Error('解析结果缺少唯一的 full.md');
  const main = markdown[0],
    base = main.slice(0, -'full.md'.length),
    text = new TextDecoder().decode(entries[main]);
  if (text.length > 16000000) throw Error('解析正文超过大小上限');
  let bytes = 0;
  const assets: Array<{ name: string; mimeType: string; data: string }> = [];
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
  const list = Object.keys(entries).find(n => n.startsWith(base) && /content_list\.json$/i.test(n));
  const raw = list ? JSON.parse(new TextDecoder().decode(entries[list])) : [];
  const blocks = Array.isArray(raw) ? raw.slice(0, 100000).flatMap((b: any) => {
    if (!['text', 'image', 'table'].includes(b.type)) return [];
    const text = typeof b.text === 'string' ? b.text.slice(0, 200000) : typeof b.table_body === 'string' ? b.table_body.slice(0, 200000) : undefined;
    const asset = typeof b.img_path === 'string' && assets.some(a => a.name === b.img_path) ? b.img_path : undefined;
    return [{ type: b.type, ...(text ? { text } : {}), ...(asset ? { asset } : {}), ...(Number.isInteger(b.page_idx) && b.page_idx >= 0 ? { page: b.page_idx + 1 } : {}) }];
  }) : [];
  parentPort!.postMessage({ result: { text, assets, ...(blocks.length ? { blocks } : {}) } });
} catch (e) {
  parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
}
