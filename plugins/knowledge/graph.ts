import type { EvidenceNode, IngestionPolicy } from '../../packages/contracts/ingestion.ts';
import { ingestionHash } from '../../packages/kernel/artifact-identity.ts';

/** Pure normalization: the original Markdown is never rewritten by segmentation. */
export function evidenceGraph(
  doc: {
    id: string;
    title: string;
    content: string;
    original?: { mediaType?: string };
    sourceHash?: string;
    blocks?: Array<{ type: string; text?: string; asset?: string; page?: number }>;
    segments?: Array<{ start: number; end: number; text: string; assessment?: { state: string } }>;
    assessment?: { state: string } | null;
    attachments?: Array<{
      hash?: string;
      objectHash?: string;
      mediaType?: string;
      role?: string;
      name?: string;
    }>;
  },
  policy: IngestionPolicy,
  duration?: number,
  hasAudio = true,
) {
  const nodes: EvidenceNode[] = [{ id: 'document', kind: 'document', text: doc.title }];
  const segments = (doc.segments ?? []).map(s => ({ ...s, text: s.assessment && s.assessment.state !== 'accepted' ? '' : s.text }));
  let parent = 'document',
    cursor = 0,
    ordinal = 0;
  const add = (node: Omit<EvidenceNode, 'id'>, key: string) => {
    const result = { ...node, id: 'n-' + ingestionHash([doc.id, key]).slice(0, 32) };
    nodes.push(result);
    return result.id;
  };
  if (segments.length) {
    for (const segment of segments) {
      const found = doc.content.indexOf(segment.text, cursor);
      if (found >= 0) cursor = found + segment.text.length;
      const p = add(
        {
          kind: 'segment',
          parentId: 'document',
          text: segment.text,
          start: segment.start,
          end: segment.end,
          offset: Math.max(0, found),
        },
        'segment:' + ordinal++,
      );
      if (policy.modalities.includes('text'))
        for (let n = 0; n < segment.text.length; n += policy.chunkChars - policy.overlapChars)
          add(
            {
              kind: 'text',
              parentId: p,
              text: segment.text.slice(n, n + policy.chunkChars),
              offset: Math.max(0, found) + n,
              start: segment.start,
              end: segment.end,
            },
            p + ':text:' + n,
          );
    }
  } else if (!doc.assessment || doc.assessment.state === 'accepted') {
    let offset = 0;
    // Headings become parents; a paragraph is split only when it exceeds the budget.
    for (const part of doc.content.split(/(?=^#{1,6}\s)/m)) {
      const heading = /^#{1,6}\s+(.+)$/m.exec(part)?.[1];
      if (heading)
        parent = add(
          { kind: 'section', parentId: 'document', text: heading, offset },
          'section:' + offset,
        );
      if (policy.modalities.includes('text'))
        for (let n = 0; n < part.length; n += policy.chunkChars - policy.overlapChars)
          add(
            {
              kind: 'text',
              parentId: parent,
              text: part.slice(n, n + policy.chunkChars),
              offset: offset + n,
            },
            'text:' + (offset + n),
          );
      offset += part.length;
    }
  }
  if (
    !doc.segments?.length &&
    policy.modalities.includes('text') &&
    doc.blocks?.some((b) => b.page && b.text)
  ) {
    let cursor = 0;
    const spans = doc.blocks.flatMap((b) => {
      if (!b.text || !b.page) return [];
      const from = doc.content.indexOf(b.text, cursor);
      if (from < 0) return [];
      cursor = from + b.text.length;
      return [{ from, to: cursor, page: b.page }];
    });
    if (spans.length) {
      for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].kind === 'text') nodes.splice(i, 1);
      const pages = new Map<number, string>();
      for (const span of spans)
        if (!pages.has(span.page))
          pages.set(
            span.page,
            add(
              {
                kind: 'section',
                parentId: 'document',
                text: doc.blocks
                  .filter((b) => b.page === span.page)
                  .map((b) => b.text ?? '')
                  .join('\n')
                  .slice(0, 6000),
                page: span.page,
                offset: span.from,
              },
              'page:' + span.page,
            ),
          );
      const cuts = [
        ...new Set([0, doc.content.length, ...spans.flatMap((s) => [s.from, s.to])]),
      ].sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i++) {
        const from = cuts[i],
          to = cuts[i + 1],
          span = spans.find((s) => from >= s.from && to <= s.to);
        for (let n = from; n < to; n += policy.chunkChars - policy.overlapChars)
          add(
            {
              kind: 'text',
              text: doc.content.slice(n, Math.min(to, n + policy.chunkChars)),
              offset: n,
              parentId: span ? pages.get(span.page)! : 'document',
              ...(span ? { page: span.page } : {}),
            },
            'text:' + n,
          );
      }
    }
  }
  if (policy.modalities.includes('image')) {
    const seen = new Set<string>();
    for (const image of doc.content.matchAll(/!\[[^\]]*\]\(<?echo-asset:([a-f0-9]{64})[^)]*\)/g)) {
      if (seen.has(image[1])) continue;
      seen.add(image[1]);
      const block = doc.blocks?.find((b) => b.asset === 'echo-asset:' + image[1]);
      let p =
        nodes.filter((n) => n.kind === 'section' && (n.offset ?? 0) <= image.index!).at(-1)?.id ??
        'document';
      if (block?.page) {
        p =
          nodes.find((n) => n.kind === 'section' && n.page === block.page)?.id ??
          add(
            { kind: 'section', parentId: 'document', text: doc.title, page: block.page },
            'page:' + block.page,
          );
      }
      add(
        {
          kind: 'image',
          parentId: p,
          text: doc.title,
          sourceHash: image[1],
          offset: image.index,
          page: block?.page,
        },
        'image:' + image[1],
      );
    }
    if (
      doc.sourceHash &&
      doc.original?.mediaType?.startsWith('image/') &&
      !seen.has(doc.sourceHash)
    )
      add(
        { kind: 'image', parentId: 'document', text: doc.title, sourceHash: doc.sourceHash },
        'original-image',
      );
  }
  const media = doc.original?.mediaType?.split('/')[0];
  if (doc.sourceHash && ['audio', 'video'].includes(media ?? '')) {
    const end = duration ?? Math.max(0, ...segments.map((s) => s.end));
    for (let start = 0; start < end;) {
      const existing = nodes.find(
        (n) =>
          n.kind === 'segment' &&
          n.start !== undefined &&
          n.end !== undefined &&
          n.start <= start &&
          n.end > start,
      );
      const next = nodes
        .filter((n) => n.kind === 'segment' && n.start !== undefined && n.start > start)
        .sort((a, b) => a.start! - b.start!)[0];
      const stop = Math.min(end, start + policy.mediaSeconds, existing?.end ?? next?.start ?? end);
      const spans = segments.filter((s) => s.start < stop && s.end > start);
      const p =
        existing?.id ??
        add(
          {
            kind: 'segment',
            parentId: 'document',
            text: spans.map((s) => s.text).join('\n'),
            start,
            end: stop,
          },
          'media:' + start,
        );
      for (const kind of ['audio', 'video'] as const)
        if ((kind === 'audio' ? hasAudio : media === 'video') && policy.modalities.includes(kind))
          add(
            {
              kind,
              parentId: p,
              text: spans.map((s) => s.text).join('\n') || doc.title,
              sourceHash: doc.sourceHash,
              start,
              end: stop,
            },
            p + ':' + kind + ':' + start,
          );
      start = stop;
    }
  }
  return nodes;
}
