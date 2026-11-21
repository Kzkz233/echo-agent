import { lazy, Suspense, useEffect, useState } from 'react';
import type { CatalogResult } from '../../../packages/contracts/library-catalog.ts';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button } from './ui.tsx';
const KnowledgeBody = lazy(() => import('./knowledge-body.tsx'));
type DocumentRef = NonNullable<CatalogResult['rows'][number]['documents']>[number];
const sourceLabels = {
  changed: '附件内容已更新',
  removed: '来源已移除',
  check: '来源附件待核对',
} as const;

export function CatalogDocuments({
  documents,
  start,
  navigate,
}: {
  documents: DocumentRef[];
  start?: { offset?: number; node?: { id: string; graphPolicy?: string } };
  navigate?: (page: string, selected?: string, selection?: any) => void;
}) {
  const current = documents.filter((d) => !d.sourceState);
  const automatic =
    current.length === 1 ? current[0] : documents.length === 1 ? documents[0] : undefined;
  const [choice, setChoice] = useState<string>();
  const selected =
    documents.find((d) => JSON.stringify([d.vaultId, d.documentId]) === choice) ?? automatic;
  const [offset, setOffset] = useState(start?.offset ?? 0),
    [document, setDocument] = useState<any>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setDocument((old: any) => (offset ? old : undefined));
    if (!selected) return;
    setBusy(true);
    setError('');
    void rpc('knowledge.read', {
      id: selected.documentId,
      vaultId: selected.vaultId,
      offset,
      ...(offset === (start?.offset ?? 0) && start?.node
        ? { nodeId: start.node.id, graphPolicy: start.node.graphPolicy }
        : {}),
    })
      .then((next) => {
        if (active)
          setDocument((old: any) =>
            offset && old?.version === next.version
              ? { ...next, content: old.content + next.content }
              : next,
          );
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [selected?.vaultId, selected?.documentId, offset]);
  return (
    <>
      {documents.length > 1 &&
        documents.map((doc, i) => (
          <Button
            key={JSON.stringify([doc.vaultId, doc.documentId])}
            disabled={doc.vaultId === selected?.vaultId && doc.documentId === selected?.documentId}
            secondary
            onClick={() => {
              setDocument(undefined);
              setOffset(0);
              setChoice(JSON.stringify([doc.vaultId, doc.documentId]));
            }}
          >
            {doc.title || t('知识条目') + ' ' + (i + 1)}{' '}
            {doc.sourceState && t(sourceLabels[doc.sourceState])}
          </Button>
        ))}
      {selected?.sourceState && <p role="status">{t(sourceLabels[selected.sourceState])}</p>}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">{t('正在加载…')}</p>}
      {document && (
        <article className="document-reader">
          <Suspense fallback={<p>{t('正在排版…')}</p>}>
            <KnowledgeBody
              showOriginal
              document={document}
              onOpenEntry={(d: DocumentRef) => navigate?.('knowledge', undefined, d)}
            />
          </Suspense>
          {document.nextOffset != null && (
            <Button secondary disabled={busy} onClick={() => setOffset(document.nextOffset)}>
              {t('继续读取')}
            </Button>
          )}
        </article>
      )}
    </>
  );
}
