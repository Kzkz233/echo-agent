import { createHash, randomUUID } from 'node:crypto';
import { invariant } from '../../packages/contracts/index.ts';
import type { SearchRecord, KnowledgeScope } from '../../packages/kernel/retrieval.ts';
import type { Files } from './index.ts';
import { prepareKeywordIndex } from './keyword-index.ts';
import { canReadEntry, type ResourceReader } from '../../packages/kernel/resource-access.ts';
import type { ParsePlan, ParsedContent } from '../../packages/contracts/parsing.ts';
export type LibraryEntry = {
  id: string;
  vaultId: string;
  title: string;
  logicalPath?: string;
  source?: string;
  sourceHash?: string;
  sourceFileId?: string;
  updatedAt: string;
  version: string;
  revision: number;
  metadata: Record<string, unknown>;
  kind: 'knowledge' | 'persona' | 'memory' | 'observation' | 'review';
};
export function logicalEntryPath(value: string) {
  const path = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  invariant(
    path.length <= 1000 &&
      !path.split('/').some((p) => p === '..' || p === '.' || /[\x00-\x1f]/.test(p)),
    'knowledge_path',
    '目录名称无效',
  );
  return path;
}
export class Entries {
  constructor(readonly files: Files) {}
  row(value: any, vaultId: string): LibraryEntry {
    return {
      id: value.id,
      vaultId,
      title: value.title,
      logicalPath: value.logical_path ?? undefined,
      source: value.source_uri ?? undefined,
      sourceHash: value.source_hash ?? undefined,
      sourceFileId: value.source_file_id ?? undefined,
      updatedAt: value.updated_at,
      version: value.version,
      revision: value.revision,
      metadata: JSON.parse(value.metadata),
      kind: value.kind,
    };
  }
  async list(vaultId?: string, reader?: ResourceReader) {
    const result: LibraryEntry[] = [];
    for (const vault of this.files.roots().filter((v) => !vaultId || v.id === vaultId)) {
      const database = await this.files.database(vault.id);
      result.push(
        ...(
          database.db
            .prepare(
              'SELECT id,title,kind,logical_path,source_file_id,source_uri,source_hash,version,revision,updated_at,metadata FROM entries',
            )
            .all() as any[]
        )
          .map((r) => this.row(r, vault.id))
          .filter((entry) => canReadEntry(entry, reader)),
      );
    }
    return result;
  }
  async find(documentId: string, vaultId?: string, reader?: ResourceReader) {
    const rows: LibraryEntry[] = [];
    for (const vault of this.files.roots().filter((v) => !vaultId || v.id === vaultId)) {
      const db = await this.files.database(vault.id),
        row = db.db
          .prepare(
            'SELECT id,title,kind,logical_path,source_file_id,source_uri,source_hash,version,revision,updated_at,metadata FROM entries WHERE id=?',
          )
          .get(documentId);
      if (row) {
        const entry = this.row(row, vault.id);
        if (canReadEntry(entry, reader)) rows.push(entry);
      }
    }
    invariant(rows.length, 'document_missing', documentId);
    invariant(rows.length === 1, 'document_ambiguous', '多个知识库包含相同条目编号，请指定知识库');
    return rows[0];
  }
  async records(filter: KnowledgeScope = {}, reader?: ResourceReader) {
    const records: (SearchRecord & {
      documentId: string;
      vaultId: string;
      offset: number;
      title: string;
      logicalPath?: string;
      timeRange?: { start: number; end: number; sourceHash: string };
    })[] = [];
    for (const vault of this.files
      .roots()
      .filter((v) => !filter.vaultId || v.id === filter.vaultId)) {
      const db = await this.files.database(vault.id);
      if (filter.documentIds && !filter.documentIds.length) continue;
      const docs = db.db
        .prepare(
          'SELECT id,title,body,kind,logical_path,metadata,source_hash,(SELECT segments FROM parse_generations g JOIN entry_revision_parsing p ON p.entry_id=g.entry_id AND p.parse_revision=g.revision WHERE p.entry_id=entries.id AND p.revision=entries.revision) AS segments FROM entries' +
            (filter.documentIds ? ' WHERE id IN (SELECT value FROM json_each(?))' : ''),
        )
        .all(...(filter.documentIds ? [JSON.stringify(filter.documentIds)] : [])) as any[];
      for (const doc of docs) {
        const meta = JSON.parse(doc.metadata);
        if (
          !canReadEntry({ kind: doc.kind, logicalPath: doc.logical_path, metadata: meta }, reader)
        )
          continue;
        if (
          meta.sourceUnavailable ||
          Boolean(meta.archived) !== Boolean(filter.archived) ||
          (filter.kind !== 'all' && doc.kind !== (filter.kind ?? 'knowledge')) ||
          (filter.folder &&
            (filter.folderExact
              ? (doc.logical_path ?? '').split('/').slice(0, -1).join('/') !== filter.folder
              : !(doc.logical_path ?? '').startsWith(filter.folder + '/')))
        )
          continue;
        const bodyHash = createHash('sha256').update(doc.body).digest('hex');
        let cursor = 0;
        const segments = (JSON.parse(doc.segments ?? '[]') as any[])
          .map((segment) => {
            const at = doc.body.indexOf(segment.text, cursor);
            if (at < 0) return undefined;
            cursor = at + segment.text.length;
            return { ...segment, from: at, to: cursor };
          })
          .filter(Boolean);
        let firstSegment=0;
        for (let offset = 0; offset < Math.max(1, doc.body.length); offset += 1000) {
          const text = doc.title + '\n' + doc.body.slice(offset, offset + 1200);
          while(firstSegment<segments.length&&segments[firstSegment].to<=offset)firstSegment++;
          const spans=[];
          for(let at=firstSegment;at<segments.length&&segments[at].from<offset+1200;at++)spans.push(segments[at]);
          records.push({
            id: vault.id + ':' + doc.id + '.c.' + offset,
            version: createHash('sha256').update(text).digest('hex'),
            text,
            documentId: doc.id,
            vaultId: vault.id,
            offset,
            title: doc.title,
            logicalPath: doc.logical_path,
            bodyHash,
            ...(spans.length && doc.source_hash
              ? {
                  timeRange: {
                    start: spans[0].start,
                    end: spans.at(-1).end,
                    sourceHash: doc.source_hash,
                  },
                }
              : {}),
          });
        }
      }
    }
    return records;
  }
  async save(
    vaultId: string,
    title: string,
    text: string,
    options: {
      id?: string;
      path?: string;
      source?: string;
      sourceHash?: string;
      sourceFileId?: string;
      kind?: LibraryEntry['kind'];
      metadata?: Record<string, unknown>;
      revision?: number;
      parsed?: { jobId: string; plan: ParsePlan; segments?: ParsedContent['segments']; blocks?: ParsedContent['blocks']; assessment?: ParsedContent['assessment'] };
      restoreRevision?: number;
    } = {},
    writer?: string,
  ) {
    this.files.assertWrite(vaultId, writer);
    invariant(text.length <= 16000000, 'document_size', '知识正文超过16M字符');
    const documentId = options.id ?? randomUUID(),
      database = await this.files.database(vaultId);
    prepareKeywordIndex(database);
    const result = database.transaction(() => {
      const old = database.db.prepare('SELECT * FROM entries WHERE id=?').get(documentId) as any;
      const producer = old && JSON.parse(old.metadata).producer;
      invariant(!producer || producer === writer, 'knowledge_owner', '请通过来源页面修改此条目');
      if (options.revision !== undefined)
        invariant(
          (old?.revision ?? 0) === options.revision,
          'revision_conflict',
          '知识包已变化，请重新读取',
        );
      const metadata = {
          ...(old ? JSON.parse(old.metadata) : {}),
          ...options.metadata,
          ...(writer ? { producer: writer } : {}),
        };
      const previousParse = database.db.prepare(`SELECT g.plan,g.segments,
        (SELECT blocks FROM parse_blocks b WHERE b.entry_id=g.entry_id AND b.revision=g.revision) AS blocks,
        (SELECT assessment FROM parse_assessments a WHERE a.entry_id=g.entry_id AND a.revision=g.revision) AS assessment
        FROM parse_generations g JOIN entry_revision_parsing p ON p.entry_id=g.entry_id AND p.parse_revision=g.revision
        WHERE p.entry_id=? AND p.revision=?`).get(documentId, options.restoreRevision ?? old?.revision ?? 0) as any;
      const extraction = options.parsed ? {
        plan: { format: options.parsed.plan.format, parser: options.parsed.plan.parser, provenance: options.parsed.plan.provenance },
        segments: options.parsed.segments ?? [], blocks: options.parsed.blocks ?? [], assessment: options.parsed.assessment ?? null,
      } : previousParse ? { plan: JSON.parse(previousParse.plan), segments: JSON.parse(previousParse.segments), blocks: JSON.parse(previousParse.blocks ?? '[]'), assessment: JSON.parse(previousParse.assessment ?? 'null') } : undefined;
      const version = createHash('sha256')
          .update(JSON.stringify(extraction ? [title, text, metadata, extraction] : [title, text, metadata]))
          .digest('hex');
      const row = {
        id: documentId,
        title,
        body: text,
        kind: options.kind ?? old?.kind ?? 'knowledge',
        logical_path: options.path ? logicalEntryPath(options.path) : (old?.logical_path ?? null),
        source_file_id: options.sourceFileId ?? old?.source_file_id ?? null,
        source_uri: options.source ?? old?.source_uri ?? null,
        source_hash: options.sourceHash ?? old?.source_hash ?? null,
        version,
        revision: (old?.revision ?? 0) + 1,
        updated_at: new Date().toISOString(),
        metadata: JSON.stringify(metadata),
      };
      database.db
        .prepare(
          'INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,kind=excluded.kind,logical_path=excluded.logical_path,source_file_id=excluded.source_file_id,source_uri=excluded.source_uri,source_hash=excluded.source_hash,version=excluded.version,revision=excluded.revision,updated_at=excluded.updated_at,metadata=excluded.metadata',
        )
        .run(...Object.values(row));
      database.db
        .prepare('INSERT INTO entry_revisions VALUES(?,?,?,?,?,?,?)')
        .run(documentId, row.revision, title, text, row.metadata, version, row.updated_at);
      const inlineHashes = new Set(
        [...text.matchAll(/echo-asset:([a-f0-9]{64})/g)].map((m) => m[1]),
      );
      if (options.restoreRevision !== undefined)
        database.db
          .prepare(
            "INSERT OR IGNORE INTO entry_attachments SELECT entry_id,id,name,object_hash,role FROM entry_revision_attachments WHERE entry_id=? AND revision=? AND id NOT LIKE 'inline-%'",
          )
          .run(documentId, options.restoreRevision);
      // Only automatically discovered links are replaced. User attachments retain
      // their identity and historical references are kept by revision snapshots.
      for (const attachment of database.db
        .prepare(
          "SELECT id,object_hash FROM entry_attachments WHERE entry_id=? AND id LIKE 'inline-%'",
        )
        .all(documentId) as any[])
        if (!inlineHashes.has(attachment.object_hash))
          database.db
            .prepare('DELETE FROM entry_attachments WHERE entry_id=? AND id=?')
            .run(documentId, attachment.id);
      for (const hash of inlineHashes) {
        const object = database.db
          .prepare('SELECT media_type FROM objects WHERE hash=?')
          .get(hash) as any;
        if (!object) continue;
        if (
          database.db
            .prepare('SELECT 1 FROM entry_attachments WHERE entry_id=? AND object_hash=? LIMIT 1')
            .get(documentId, hash)
        )
          continue;
        const file = database.db
          .prepare('SELECT name FROM files WHERE object_hash=? LIMIT 1')
          .get(hash) as any;
        database.db
          .prepare('INSERT OR IGNORE INTO entry_attachments VALUES(?,?,?,?,?)')
          .run(
            documentId,
            'inline-' + hash,
            file?.name ?? hash,
            hash,
            object.media_type.startsWith('image/') ? 'image' : 'attachment',
          );
      }
      database.db
        .prepare('INSERT INTO entry_revision_sources VALUES(?,?,?,?,?)')
        .run(documentId, row.revision, row.source_file_id, row.source_hash, row.source_uri);
      database.db
        .prepare(
          'INSERT INTO entry_revision_attachments SELECT entry_id,?,id,name,object_hash,role FROM entry_attachments WHERE entry_id=?',
        )
        .run(row.revision, documentId);
      if (options.parsed) {
        const { plan, jobId, segments } = options.parsed;
        // Machine paths and credential references belong to operational jobs, not
        // portable knowledge provenance. Providers supply a safe public summary.
        database.db
          .prepare('INSERT INTO parse_generations VALUES(?,?,?,?,?,?)')
          .run(
            documentId,
            row.revision,
            jobId,
            JSON.stringify({
              format: plan.format,
              parser: plan.parser,
              provenance: plan.provenance,
            }),
            JSON.stringify(segments ?? []),
            row.updated_at,
          );
        if (options.parsed.blocks) database.db.prepare('INSERT INTO parse_blocks VALUES(?,?,?)').run(documentId, row.revision, JSON.stringify(options.parsed.blocks));
        if (options.parsed.assessment) database.db.prepare('INSERT INTO parse_assessments VALUES(?,?,?)').run(documentId, row.revision, JSON.stringify(options.parsed.assessment));
      }
      const priorParsing = database.db
        .prepare(
          'SELECT parse_revision FROM entry_revision_parsing WHERE entry_id=? AND revision=?',
        )
        .get(documentId, options.restoreRevision ?? old?.revision ?? 0) as any;
      database.db
        .prepare('INSERT INTO entry_revision_parsing VALUES(?,?,?)')
        .run(
          documentId,
          row.revision,
          options.parsed ? row.revision : (priorParsing?.parse_revision ?? null),
        );
      return this.row(row, vaultId);
    });
    this.files.events?.emit('knowledge.updated', { vaultId });
    return result;
  }
  async read(
    documentId: string,
    offset = 0,
    limit = 12000,
    vaultId?: string,
    reader?: ResourceReader,
  ) {
    const record = await this.find(documentId, vaultId, reader),
      database = await this.files.database(record.vaultId);
    const text = (database.db.prepare('SELECT body FROM entries WHERE id=?').get(documentId) as any)
      .body as string;
    const attachments = database.db
      .prepare(
        'SELECT entry_attachments.id,name,object_hash AS hash,role,bytes,media_type AS mediaType FROM entry_attachments JOIN objects ON object_hash=hash WHERE entry_id=?',
      )
      .all(documentId);
    const original = record.sourceFileId
      ? database.db
          .prepare(
            'SELECT files.id,files.name,objects.hash,objects.media_type AS mediaType,objects.bytes FROM files JOIN objects ON objects.hash=COALESCE(?,files.object_hash) WHERE files.id=?',
          )
          .get(record.sourceHash ?? null, record.sourceFileId)
      : undefined;
    const generation = database.db
      .prepare(
        'SELECT g.revision,plan,segments FROM parse_generations g JOIN entry_revision_parsing p ON p.entry_id=g.entry_id AND p.parse_revision=g.revision WHERE p.entry_id=? AND p.revision=?',
      )
      .get(documentId, record.revision) as any;
    return {
      ...record,
      ...(original ? { original } : {}),
      content: text.slice(offset, offset + limit),
      offset,
      totalChars: text.length,
      nextOffset: offset + limit < text.length ? offset + limit : null,
      attachments,
      ...(generation
        ? {
            parsing: { revision: generation.revision, ...JSON.parse(generation.plan) },
            assessment: JSON.parse((database.db.prepare('SELECT assessment FROM parse_assessments WHERE entry_id=? AND revision=?').get(documentId, generation.revision) as any)?.assessment ?? 'null'),
            segments: JSON.parse(generation.segments),
            blocks: JSON.parse((database.db.prepare('SELECT blocks FROM parse_blocks WHERE entry_id=? AND revision=?').get(documentId, generation.revision) as any)?.blocks ?? '[]'),
          }
        : {}),
    };
  }
}
