import { useEffect, useState, lazy, Suspense } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, EmptyState } from './ui.tsx';
const Body = lazy(() => import('./knowledge-body.tsx'));
export function CharacterLibrary({ personaId, plugins }: any) {
  const [entries, setEntries] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(),
    [issue, setIssue] = useState('');
  useEffect(() => {
    let active = true;
    setSelected(undefined);
    rpc('knowledge.character-library', { personaId })
      .then((result) => {
        if (active) setEntries(result.entries);
      })
      .catch((error) => {
        if (active) setIssue(error.message);
      });
    return () => {
      active = false;
    };
  }, [personaId]);
  const open = async (entry: any) => {
    try {
      setSelected(
        await rpc('knowledge.read', { id: entry.id, vaultId: entry.vaultId, limit: 30000 }),
      );
      setIssue('');
    } catch (error) {
      setIssue((error as Error).message);
    }
  };
  return (
    <div className="library-layout">
      <div>
        {issue && <p role="alert">{issue}</p>}
        {entries
          .filter((entry) => entry.kind !== 'memory')
          .map((entry) => (
            <button
              className="card library-entry"
              key={entry.vaultId + entry.id}
              onClick={() => void open(entry)}
            >
              <strong>{entry.title}</strong>
              <small>
                {entry.logicalPath} ·{' '}
                {t(plugins.find((p: any) => p.id === entry.metadata.producer)?.name ?? entry.kind)}
              </small>
            </button>
          ))}
        {!entries.length && <EmptyState title={t('暂无角色档案')} />}
      </div>
      <div className="card">
        {selected ? (
          <>
            <h2>{selected.title}</h2>
            <Suspense fallback={null}>
              <Body document={selected} />
            </Suspense>
            {selected.nextOffset !== undefined && (
              <Button
                secondary
                onClick={async () => {
                  const next = await rpc('knowledge.read', {
                    id: selected.id,
                    vaultId: selected.vaultId,
                    offset: selected.nextOffset,
                    limit: 30000,
                  });
                  setSelected({ ...next, content: selected.content + next.content });
                }}
              >
                {t('继续阅读')}
              </Button>
            )}
          </>
        ) : (
          <EmptyState title={t('选择一个条目阅读')} />
        )}
      </div>
    </div>
  );
}
