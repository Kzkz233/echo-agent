import type { BrowseLibrary, CatalogResult } from '../../packages/contracts/library-catalog.ts';
import type { KnowledgeCollection } from '../../packages/contracts/knowledge-collections.ts';

export type Item = { key: string; version: number; data: Record<string, any> };
export type Reference = {
  itemKey: string;
  vaultId: string;
  documentId: string;
  sha256: string;
  jobId?: string;
};
export type LinkedEntry = Reference & { state?: string };
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
        fields.get(label) || fields.get(english) ||
        Array.from(fields).find(([key]) => key.endsWith(' ' + english))?.[1] || '';
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
const jobState: Record<string, string> = {
  queued: '等待入库',
  running: '入库中',
  paused: '已暂停',
  failed: '入库失败',
  cancelled: '已取消',
};
export async function browseCatalog(
  catalog: ReturnType<typeof buildCatalog>,
  input: BrowseLibrary,
  links: LinkedEntry[],
  coverage: (
    vaultId: string,
    ids: string[],
  ) => Promise<Record<string, 'ready' | 'partial' | 'missing'>>,
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
  const selected = catalog.entries.filter(
    (r) =>
      (!input.group || r.collections.some((k) => groups.has(k))) &&
      words.every((w) => r.search.includes(w)),
  );
  const visible = selected.slice(input.offset, input.offset + input.limit);
  const visibleKeys = new Set(visible.map((row) => row.key));
  const byItem = new Map<string, LinkedEntry[]>(),
    byVault = new Map<string, Set<string>>();
  for (const link of links) {
    if (!visibleKeys.has(link.itemKey)) continue;
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
      const docs = [
        ...new Map(
          complete.map((l) => [
            JSON.stringify([l.vaultId, l.documentId]),
            { vaultId: l.vaultId, documentId: l.documentId },
          ]),
        ).values(),
      ];
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
      const imported =
        [
          ...new Set(
            refs.map((l) =>
              l.state === 'completed' ? '已入库' : (jobState[l.state ?? ''] ?? '状态不可用'),
            ),
          ),
        ].join(' / ') || '未入库';
      const files = r.files.map((f) => ({
        id: f.key,
        title: String(f.data.filename || f.data.title || f.key),
        ...(f.data.linkMode === 'imported_file' && f.data.contentType === 'application/pdf'
          ? { action: { label: '导入或复用 PDF', input: { attachment: f.key } } }
          : {}),
      }));
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
