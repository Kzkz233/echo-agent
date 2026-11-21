import type { Store } from '../../packages/kernel/store.ts';
import type { Item, Reference } from './catalog.ts';
import { buildCatalog, pdfSignature } from './catalog.ts';

type Group = { key: string; name: string; parentCollection: string | false };
export type Catalog = { collections: Group[]; members: Record<string, string[]> };
export type Directory = {
  items: Item[];
  attachments: Item[];
  collections: Item[];
  archived: Item[];
  baselines: Record<string, string>;
  syncedAt?: string;
};
export const archivedGroup = 'zotero-archived';

// Retain detached knowledge pages by source key. Reappearance of the same key restores its link.
export function reconcileDirectory(
  previous: Directory | undefined,
  collections: Item[],
  items: Item[],
  attachments: Item[],
  links: Reference[],
): Directory {
  const active = new Set(items.map((r) => r.key));
  const linked = new Set(links.map((r) => r.itemKey));
  const archived = [...(previous?.archived ?? []), ...(previous?.items ?? [])].filter(
    (r) => !active.has(r.key) && linked.has(r.key),
  );
  const legacy = new Set(links.filter((r) => !r.attachmentKey).map((r) => r.itemKey));
  const baselines: Record<string, string> = {};
  for (const key of legacy) {
    baselines[key] =
      previous?.baselines[key] ??
      pdfSignature(attachments.filter((f) => f.data.parentItem === key));
  }
  return {
    collections,
    items,
    attachments,
    archived,
    baselines,
    syncedAt: new Date().toISOString(),
  };
}

export function projectDirectory(data: Directory) {
  const archive = data.archived.map((r) => ({
    ...r,
    data: { ...r.data, collections: [archivedGroup] },
  }));
  const groups = data.archived.length
    ? [...data.collections, { key: archivedGroup, version: 0, data: { name: '已移出文献库' } }]
    : data.collections;
  return buildCatalog(groups, [...data.items, ...archive], data.attachments);
}

// Older installations persisted membership and links, but not the bibliographic fields.
export async function legacyDirectory(
  store: Store,
  server: string,
  links: Reference[],
  titles: (vault: string, ids: string[]) => Promise<Map<string, string>>,
): Promise<Directory> {
  const old = store.document<Catalog>('zotero-catalog', server);
  const names = new Map<string, string>();
  for (const vault of new Set(links.map((r) => r.vaultId))) {
    const selected = links.filter((r) => r.vaultId === vault);
    const entries = await titles(
      vault,
      selected.map((r) => r.documentId),
    );
    for (const r of selected) {
      const title = entries.get(r.documentId);
      if (title) names.set(r.itemKey, title);
    }
  }
  const items = Object.entries(old?.members ?? {}).map(([key, collections]) => ({
    key,
    version: 0,
    data: { title: names.get(key) || key, collections },
  }));
  const archived = [...names]
    .filter(([key]) => !Object.hasOwn(old?.members ?? {}, key))
    .map(([key, title]) => ({ key, version: 0, data: { title } }));
  return {
    items,
    archived,
    attachments: [],
    baselines: {},
    collections: (old?.collections ?? []).map((g) => ({
      key: g.key,
      version: 0,
      data: { name: g.name, parentCollection: g.parentCollection },
    })),
  };
}
