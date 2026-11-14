import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { invariant } from '../../packages/contracts/index.ts';
/** One portable library, independently of application accounts and conversations. */
export class LibraryDatabase {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    if (existsSync(path)) {
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        const meta = check
          .prepare("SELECT value FROM library_meta WHERE key='format'")
          .get() as any;
        invariant(
          meta?.value === 'echo-library-v1',
          'library_format',
          '目录中的 library.sqlite 不是受支持的 Echo 知识库',
        );
      } finally {
        check.close();
      }
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS library_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS objects(hash TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,bytes INTEGER NOT NULL,media_type TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('source','derived')),object_hash TEXT NOT NULL REFERENCES objects(hash),source_uri TEXT,updated_at TEXT NOT NULL,revision INTEGER NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS files_source ON files(source_uri) WHERE source_uri IS NOT NULL AND kind='source';
   CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL,logical_path TEXT,source_file_id TEXT UNIQUE REFERENCES files(id),source_uri TEXT,source_hash TEXT REFERENCES objects(hash),version TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}');
   CREATE INDEX IF NOT EXISTS entries_kind ON entries(kind,updated_at);
   CREATE TABLE IF NOT EXISTS entry_attachments(entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,id TEXT NOT NULL,name TEXT NOT NULL,object_hash TEXT NOT NULL REFERENCES objects(hash),role TEXT NOT NULL,PRIMARY KEY(entry_id,id));
   CREATE TABLE IF NOT EXISTS entry_revisions(entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,revision INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,metadata TEXT NOT NULL,version TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(entry_id,revision));
   CREATE TABLE IF NOT EXISTS file_versions(file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,object_hash TEXT NOT NULL REFERENCES objects(hash),PRIMARY KEY(file_id,object_hash));
   CREATE TABLE IF NOT EXISTS entry_revision_sources(entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,revision INTEGER NOT NULL,source_file_id TEXT,source_hash TEXT REFERENCES objects(hash),source_uri TEXT,PRIMARY KEY(entry_id,revision));
   CREATE TABLE IF NOT EXISTS entry_revision_attachments(entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,revision INTEGER NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,object_hash TEXT NOT NULL REFERENCES objects(hash),role TEXT NOT NULL,PRIMARY KEY(entry_id,revision,id));
   CREATE TABLE IF NOT EXISTS parse_generations(entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,revision INTEGER NOT NULL,job_id TEXT NOT NULL UNIQUE,plan TEXT NOT NULL,segments TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(entry_id,revision));
   CREATE TABLE IF NOT EXISTS parse_blocks(entry_id TEXT NOT NULL,revision INTEGER NOT NULL,blocks TEXT NOT NULL,PRIMARY KEY(entry_id,revision),FOREIGN KEY(entry_id,revision) REFERENCES parse_generations(entry_id,revision) ON DELETE CASCADE);
   CREATE TABLE IF NOT EXISTS parse_assessments(entry_id TEXT NOT NULL,revision INTEGER NOT NULL,assessment TEXT NOT NULL,PRIMARY KEY(entry_id,revision),FOREIGN KEY(entry_id,revision) REFERENCES parse_generations(entry_id,revision) ON DELETE CASCADE);
   CREATE TABLE IF NOT EXISTS entry_revision_parsing(entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,revision INTEGER NOT NULL,parse_revision INTEGER,PRIMARY KEY(entry_id,revision));
   INSERT OR IGNORE INTO file_versions SELECT id,object_hash FROM files WHERE kind='source';
   INSERT OR IGNORE INTO entry_revision_sources SELECT id,revision,source_file_id,source_hash,source_uri FROM entries;
   INSERT OR IGNORE INTO entry_revision_parsing SELECT id,revision,NULL FROM entries;
   INSERT OR IGNORE INTO entry_revision_attachments SELECT a.entry_id,e.revision,a.id,a.name,a.object_hash,a.role FROM entry_attachments a JOIN entries e ON e.id=a.entry_id;
  `);
    this.db.prepare("INSERT OR IGNORE INTO library_meta VALUES('format','echo-library-v1')").run();
    this.db.prepare("INSERT OR IGNORE INTO library_meta VALUES('id',?)").run(randomUUID());
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
