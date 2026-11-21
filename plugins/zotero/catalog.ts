import { attachmentState, jobLabel } from './attachment-status.ts';
import type { BrowseLibrary, CatalogResult } from '../../packages/contracts/library-catalog.ts';
import type { KnowledgeCollection } from '../../packages/contracts/knowledge-collections.ts';

export type Item = { key: string; version: number; data: Record<string, any> };
export type Reference = {
  itemKey: string;
  vaultId: string;
  documentId: string;
  sha256: string;
  jobId?: string;
  attachmentKey?: string;
  sourceName?: string;
  sourceMd5?: string;
  sourceMtime?: number;
  sourceVersion?: number;
};
export type LinkedEntry = Reference & { state?: string; title?: string };
export function pdfSignature(files: Item[]) {
  return JSON.stringify(
    files
      .filter((f) => f.data.contentType === 'application/pdf')
      .map((f) => [f.key, f.data.md5 || f.data.mtime || f.version])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
export function buildCatalog(collections: Item[], parents: Item[], attachments: Item[]) {
  const groups: KnowledgeCollection[] = collections.map(({ key, data }) => ({
    id: key,
    title: data.name,
    parentId: data.parentCollection || undefined,
    kind: 'group',
  }));
  const children = new Map<string, Item[]>();
  for (const file of attachments) {
    if (!file.data.parentItem) continue;
    const list = children.get(file.data.parentItem) ?? [];
    list.push(file);
    children.set(file.data.parentItem, list);
  }
  const entries = parents
    .filter(({ data }) => !['attachment', 'note', 'annotation'].includes(data.itemType))
    .map(({ key, data }) => {
      const files = children.get(key) ?? [];
      const fields = new Map<string, string>();
      for (const line of String(data.extra ?? '').split(/\r?\n/)) {
        const match = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
        if (match) fields.set(match[1].trim().toLowerCase(), match[2].trim());
      }
      // Imported libraries can qualify Extra labels with the source application's name.
      const extraField = (label: string, english: string) =>
        fields.get(label) ||
        fields.get(english) ||
        Array.from(fields).find(([key]) => key.endsWith(' ' + english))?.[1] ||
        '';
      const caption = extraField('短评', 'caption');
      const rating = extraField('评分', 'rating');
      const title = String(data.title || data.shortTitle || key);
      const search = [
        title,
        data.DOI,
        data.date,
        data.publicationTitle,
        data.abstractNote,
        data.extra,
        ...(data.creators ?? []).flatMap((v: any) => [v.name, v.firstName, v.lastName]),
        ...(data.tags ?? []).map((v: any) => v.tag),
        ...files.map((f) => f.data.filename ?? f.data.title),
      ]
        .join(' ')
        .toLocaleLowerCase();
      return {
        key,
        title,
        caption,
        rating,
        files,
        collections: (data.collections ?? []) as string[],
        search,
      };
    })
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title, 'zh-CN', { numeric: true }) || a.key.localeCompare(b.key),
    );
  return { groups, entries };
}
export function linkedDocuments(
  entry: ReturnType<typeof buildCatalog>['entries'][number],
  links: LinkedEntry[],
  baseline?: string,
) {
  const documents = new Map<
    string,
    NonNullable<CatalogResult['rows'][number]['documents']>[number]
  >();
  const legacyChanged = baseline !== undefined && baseline !== pdfSignature(entry.files);
  for (const link of links) {
    const file = entry.files.find((f) => f.key === link.attachmentKey);
    let sourceState: 'removed' | 'changed' | 'check' | undefined;
    if (entry.collections.includes('zotero-archived') || (link.attachmentKey && !file))
      sourceState = 'removed';
    else if (file?.data.md5 && link.sourceMd5 && file.data.md5.toLowerCase() !== link.sourceMd5)
      sourceState = 'changed';
    else if (
      file &&
      !file.data.md5 &&
      (link.sourceMtime
        ? file.data.mtime !== link.sourceMtime
        : link.sourceVersion !== undefined && file.version !== link.sourceVersion)
    )
      sourceState = 'check';
    else if (!link.attachmentKey && legacyChanged) sourceState = 'check';
    const key = JSON.stringify([link.vaultId, link.documentId]);
    const prior = documents.get(key);
    if (!prior || (prior.sourceState && !sourceState)) {
      documents.set(key, {
        vaultId: link.vaultId,
        documentId: link.documentId,
        title: file?.data.filename || link.sourceName || link.title,
        sourceState,
      });
    }
  }
  return [...documents.values()];
}
export async function browseCatalog(
  catalog: ReturnType<typeof buildCatalog>,
  input: BrowseLibrary,
  links: LinkedEntry[],
  coverage: (
    vaultId: string,
    ids: string[],
  ) => Promise<Record<string, 'ready' | 'partial' | 'missing'>>,
  baselines: Record<string, string> = {},
  verify?: (refs: LinkedEntry[], files: Item[]) => Promise<LinkedEntry[]>,
): Promise<CatalogResult> {
  const groups = new Set<string>();
  if (input.group) {
    groups.add(input.group);
    for (let previous = -1; previous !== groups.size;) {
      previous = groups.size;
      for (const node of catalog.groups)
        if (node.parentId && groups.has(node.parentId)) groups.add(node.id);
    }
  }
  const words = input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const readable = input.documentsOnly
    ? new Set(links.filter((r) => r.state === 'completed').map((r) => r.itemKey))
    : undefined;
  const selected = catalog.entries.filter(
    (r) =>
      (!readable || readable.has(r.key)) &&
      (input.group
        ? r.collections.some((k) => groups.has(k))
        : !r.collections.includes('zotero-archived')) &&
      words.every((w) => r.search.includes(w)),
  );
  const visible = selected.slice(input.offset, input.offset + input.limit);
  const visibleKeys = new Set(visible.map((row) => row.key));
  const byItem = new Map<string, LinkedEntry[]>(),
    byVault = new Map<string, Set<string>>();
  const scopedLinks = links.filter((r) => visibleKeys.has(r.itemKey));
  for (const link of verify
    ? await verify(
        scopedLinks,
        visible.flatMap((row) => row.files),
      )
    : scopedLinks) {
    const list = byItem.get(link.itemKey) ?? [];
    list.push(link);
    byItem.set(link.itemKey, list);
    if (link.state !== 'completed') continue;
    const ids = byVault.get(link.vaultId) ?? new Set<string>();
    ids.add(link.documentId);
    byVault.set(link.vaultId, ids);
  }
  const coverageByVault = new Map(
    await Promise.all(
      [...byVault].map(async ([vault, ids]) => [vault, await coverage(vault, [...ids])] as const),
    ),
  );
  return {
    groups: catalog.groups,
    total: selected.length,
    rows: visible.map((r) => {
      const refs = byItem.get(r.key) ?? [],
        complete = refs.filter((l) => l.state === 'completed');
      const docs = linkedDocuments(r, complete, baselines[r.key]);
      const states = docs.map((d) => coverageByVault.get(d.vaultId)?.[d.documentId]);
      const index = !docs.length
        ? '—'
        : states.some((s) => !s)
          ? '状态不可用'
          : states.every((s) => s === 'ready')
            ? '已索引'
            : states.every((s) => s === 'missing')
              ? '未索引'
              : '部分索引';
      const files = r.files.map((f) =>
        attachmentState(f, refs, (ref) => coverageByVault.get(ref.vaultId)?.[ref.documentId]),
      );
      const pdfStates = files
        .filter((f) => !['网页链接', '链接文件或其他附件'].includes(f.status))
        .map((f) => f.status);
      const statuses = new Set(pdfStates);
      if (complete.length) statuses.add('已入库');
      for (const ref of refs)
        if (ref.state !== 'completed' && !files.some((f) => f.id === ref.attachmentKey))
          statuses.add(jobLabel(ref.state));
      const imported = statuses.size
        ? [...statuses].join(' / ')
        : !files.length
          ? '无附件'
          : files.every((f) => f.status === '网页链接')
            ? '仅网页链接'
            : '无可入库 PDF';
      return {
        id: r.key,
        cells: {
          title: r.title,
          caption: r.caption,
          rating: r.rating,
          attachments: files.map((f) => f.title).join('\n'),
          imported,
          index,
        },
        files,
        documents: docs,
      };
    }),
  };
}
