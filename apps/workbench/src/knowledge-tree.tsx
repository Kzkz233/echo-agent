import { useEffect, useMemo, useState } from 'react';
import type { KnowledgeCollection } from '../../../packages/contracts/knowledge-collections.ts';
import { t } from './i18n.ts';
import { Icon } from './ui.tsx';

export function collectionPaths(catalog: KnowledgeCollection[]) {
  const nodes = new Map(catalog.map((node) => [node.id, node]));
  const roots = catalog.filter((node) => !node.parentId);
  const singleRoot = roots.length === 1 && roots[0].kind === 'library' ? roots[0].id : undefined;
  const result = new Map<string, KnowledgeCollection>();
  for (const node of catalog) {
    if (node.id === singleRoot) continue;
    const parts = new Set([node.id]);
    let parent = node.parentId;
    while (parent && parent !== singleRoot && !parts.has(parent) && nodes.has(parent)) {
      parts.add(parent);
      parent = nodes.get(parent)?.parentId;
    }
    result.set([...parts].reverse().join('/'), node);
  }
  return result;
}

export function KnowledgeTree({
  folders,
  selected,
  label,
  onSelect,
  vault,
  grouped = false,
  leafLabel,
  rootEntry = true,
  heading,
}: {
  folders: string[];
  selected: string;
  label: (path: string) => string;
  onSelect: (path: string) => void;
  vault: string;
  grouped?: boolean;
  leafLabel?: (path: string) => string;
  rootEntry?: boolean;
  heading?: string;
}) {
  const [expanded, setExpanded] = useState(new Set<string>());
  useEffect(() => setExpanded(new Set()), [vault]);
  useEffect(() => {
    if (!selected) return;
    const parts = selected.split('/');
    setExpanded(
      (old) =>
        new Set([...old, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]),
    );
  }, [selected]);
  const children = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const path of folders) {
      const parent = path.split('/').slice(0, -1).join('/');
      map.set(parent, [...(map.get(parent) ?? []), path]);
    }
    return map;
  }, [folders]);
  const render = (parent: string, depth = 0): any =>
    (children.get(parent) ?? []).map((path) => {
      const branch = Boolean(children.get(path)?.length),
        open = expanded.has(path);
      return (
        <div
          key={path}
          role="treeitem"
          aria-selected={selected === path}
          aria-expanded={branch ? open : undefined}
        >
          <div
            className={'folder-node ' + (selected === path ? 'selected' : '')}
            style={{ paddingLeft: depth * 12 }}
          >
            {branch ? (
              <button
                className="folder-disclosure"
                aria-label={(open ? t('收起目录') : t('展开目录')) + ' ' + label(path)}
                onClick={() =>
                  setExpanded((old) => {
                    const next = new Set(old);
                    if (open) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              >
                <Icon name="chevron" size={12} />
              </button>
            ) : (
              <span className="folder-disclosure" />
            )}
            <button onClick={() => onSelect(path)} title={label(path)}>
              <Icon name="files" size={14} />
              <span>{leafLabel?.(path) ?? label(path).split(' / ').at(-1)}</span>
            </button>
          </div>
          {branch && open && <div role="group">{render(path, depth + 1)}</div>}
        </div>
      );
    });
  return (
    <>
      <div className="folder-tree-heading">
        <span>{heading ?? t(grouped ? '知识分组' : '目录')}</span>
        <button className="text-button" onClick={() => setExpanded(new Set())}>
          {t('全部收起')}
        </button>
      </div>
      {rootEntry && (
        <button className={!selected ? 'selected' : ''} onClick={() => onSelect('')}>
          <Icon name="knowledge" size={15} />
          {t(grouped ? '全部文献' : '全部目录')}
        </button>
      )}
      <div className="folder-nodes" role="tree" aria-label={heading ?? t('知识目录树')}>
        {render('')}
      </div>
    </>
  );
}
