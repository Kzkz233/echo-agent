import type { Item, LinkedEntry } from './catalog.ts';

export function storedPDF(file: Item) {
  return (
    ['imported_file', 'imported_url'].includes(file.data.linkMode) &&
    file.data.contentType === 'application/pdf'
  );
}
const jobs: Record<string, string> = {
  unavailable: '知识条目不可用',
  queued: '等待入库',
  running: '入库中',
  pausing: '正在暂停',
  paused: '已暂停',
  failed: '入库失败',
  cancelled: '已取消',
};
export const jobLabel = (state?: string) => jobs[state ?? ''] ?? '状态不可用';

export function attachmentState(
  file: Item,
  links: LinkedEntry[],
  covered: (ref: LinkedEntry) => string | undefined,
) {
  const bound = links.filter((r) => r.attachmentKey === file.key);
  const current = bound.filter((r) =>
    file.data.md5 && r.sourceMd5
      ? file.data.md5.toLowerCase() === r.sourceMd5
      : r.sourceMtime
        ? file.data.mtime === r.sourceMtime
        : file.version === r.sourceVersion,
  );
  const ready = current.filter((r) => r.state === 'completed');
  const indexes = ready.map(covered);
  const index = !ready.length
    ? undefined
    : indexes.every((s) => s === 'ready')
      ? '已索引'
      : indexes.every((s) => s === 'missing')
        ? '未索引'
        : indexes.some((s) => !s)
          ? '状态不可用'
          : '部分索引';
  const job =
    current.find((r) => ['running', 'queued', 'pausing'].includes(r.state ?? '')) ?? current[0];
  const pdf = storedPDF(file);
  const status = ready.length
    ? '已入库'
    : job
      ? jobLabel(job.state)
      : bound.length
        ? '附件内容待核对'
        : file.data.linkMode === 'linked_url'
          ? '网页链接'
          : !pdf
            ? '链接文件或其他附件'
            : links.some((r) => !r.attachmentKey)
              ? '已有正文待核对'
              : 'PDF 待入库';
  const canImport = pdf && !ready.length && (!job || job.state === 'unavailable');
  return {
    id: file.key,
    title: String(file.data.filename || file.data.title || file.key),
    status,
    index,
    ...(canImport ? { action: { label: '导入或复用 PDF', input: { attachment: file.key } } } : {}),
  };
}
