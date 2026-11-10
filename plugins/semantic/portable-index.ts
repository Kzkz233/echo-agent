import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SearchRecord } from '../../packages/kernel/retrieval.ts';
/** Exact structural nodes and float32 vectors survive import; no re-chunking or re-embedding. */
export function openPortableIndex(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS spaces(fingerprint TEXT PRIMARY KEY,dimension INTEGER NOT NULL,provenance TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS space_aliases(logical TEXT PRIMARY KEY,target TEXT NOT NULL REFERENCES spaces(fingerprint));
    CREATE TABLE IF NOT EXISTS documents(space TEXT NOT NULL REFERENCES spaces(fingerprint),vault_id TEXT NOT NULL,document_id TEXT NOT NULL,body_hash TEXT NOT NULL,PRIMARY KEY(space,vault_id,document_id));
    CREATE TABLE IF NOT EXISTS vectors(space TEXT NOT NULL,vault_id TEXT NOT NULL,document_id TEXT NOT NULL,node_id TEXT NOT NULL,modality TEXT NOT NULL,parent_id TEXT,text TEXT NOT NULL,embedding BLOB NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(space,vault_id,node_id),FOREIGN KEY(space,vault_id,document_id) REFERENCES documents(space,vault_id,document_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS vectors_document ON vectors(space,vault_id,document_id);`);
  return db;
}
export const documentKey = (r: Pick<SearchRecord, 'vaultId' | 'documentId'>) =>
  JSON.stringify([r.vaultId, r.documentId]);
export function resolvePortableSpace(db: DatabaseSync, logical: string) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='space_aliases'").get();
  return exists
    ? ((db.prepare('SELECT target FROM space_aliases WHERE logical=?').get(logical) as any)
        ?.target ?? logical)
    : logical;
}
export function portableNodeCount(path: string, space: string, covered: Set<string>) {
  if (!covered.size) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    space = resolvePortableSpace(db, space);
    const count = db.prepare(
      'SELECT count(*) n FROM vectors WHERE space=? AND vault_id=? AND document_id=?',
    );
    return [...covered].reduce((sum, key) => {
      const [vault, doc] = JSON.parse(key);
      return sum + (count.get(space, vault, doc) as any).n;
    }, 0);
  } finally {
    db.close();
  }
}
export function portableCoverage(path: string, space: string, records: SearchRecord[]) {
  if (!existsSync(path)) return new Set<string>();
  const current = new Map(
    records
      .filter((r) => r.documentId && r.vaultId && r.bodyHash)
      .map((r) => [documentKey(r), r.bodyHash]),
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    space = resolvePortableSpace(db, space);
    return new Set(
      (
        db
          .prepare('SELECT vault_id,document_id,body_hash FROM documents WHERE space=?')
          .all(space) as any[]
      )
        .filter((r) => current.get(JSON.stringify([r.vault_id, r.document_id])) === r.body_hash)
        .map((r) => JSON.stringify([r.vault_id, r.document_id])),
    );
  } finally {
    db.close();
  }
}
