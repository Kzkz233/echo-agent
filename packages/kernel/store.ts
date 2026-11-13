import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Binding, Conversation, Message, Run } from '../contracts/index.ts';
import { persistentTranscript, transcriptText, type TranscriptMessage } from '../contracts/transcript.ts';
import { normalizeHistory } from './conversation-history.ts';

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(conversation_id,seq));
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,seq);
      CREATE INDEX IF NOT EXISTS messages_run ON messages(json_extract(data,'$.runId'));
      CREATE INDEX IF NOT EXISTS messages_human_time ON messages(conversation_id,json_extract(data,'$.createdAt')) WHERE json_extract(data,'$.source')='human' AND json_extract(data,'$.role')='user';
      CREATE TABLE IF NOT EXISTS bindings (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_source_time ON runs(json_extract(data,'$.source'),json_extract(data,'$.createdAt'));
      CREATE TABLE IF NOT EXISTS documents (namespace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace,id));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS queued_inputs ON receipts(json_extract(data,'$.input.conversationId'),json_extract(data,'$.createdAt'))
        WHERE json_extract(data,'$.kind')='input' AND json_extract(data,'$.state')='queued';
    `);
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_entries (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      run_id TEXT, data TEXT, UNIQUE(conversation_id,seq));
      CREATE INDEX IF NOT EXISTS session_entries_run ON session_entries(conversation_id,run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS session_entries_message ON session_entries(message_id);`);
    if (!this.get('session.transcript.v1', false)) this.transaction(() => {
      // Add references; never rewrite original messages, sequence numbers or data.
      const insert = this.db.prepare(`INSERT OR IGNORE INTO session_entries
        (id,conversation_id,seq,message_id,run_id) VALUES (?,?,
        (SELECT COALESCE(MAX(seq),0)+1 FROM session_entries WHERE conversation_id=?),?,?)`);
      for (const row of this.db.prepare('SELECT id,conversation_id,data FROM messages ORDER BY conversation_id,seq').all() as
        { id: string; conversation_id: string; data: string }[])
        insert.run('message:' + row.id, row.conversation_id, row.conversation_id, row.id, JSON.parse(row.data).runId ?? null);
      this.set('session.transcript.v1', true);
    });
    // The reference and message are committed atomically, including old callers
    // that append through Store rather than a particular backend or feature.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS session_message_insert AFTER INSERT ON messages BEGIN
      INSERT INTO session_entries (id,conversation_id,seq,message_id,run_id)
      VALUES ('message:'||NEW.id, NEW.conversation_id,
        (SELECT COALESCE(MAX(seq),0)+1 FROM session_entries WHERE conversation_id=NEW.conversation_id),
        NEW.id,json_extract(NEW.data,'$.runId')); END;`);
    for (const run of this.unresolved())
      if (run.state === 'running')
        this.updateRun({
          ...run,
          state: 'unknown',
          error: '进程在执行期间结束；需要核对后端结果，未自动重放。',
        });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      this.db.exec('COMMIT');
      return v;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  get<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as
      { value: string } | undefined;
    return r ? JSON.parse(r.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  keys(prefix: string) {
    return (
      this.db
        .prepare('SELECT key FROM kv WHERE substr(key,1,?)=? ORDER BY key')
        .all(prefix.length, prefix) as { key: string }[]
    ).map((row) => row.key);
  }
  document<T>(ns: string, id: string): T | undefined {
    const r = this.db
      .prepare('SELECT data FROM documents WHERE namespace=? AND id=?')
      .get(ns, id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  documents<T>(ns: string): T[] {
    return (
      this.db.prepare('SELECT data FROM documents WHERE namespace=? ORDER BY id').all(ns) as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  put(ns: string, id: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO documents VALUES (?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data',
      )
      .run(ns, id, JSON.stringify(value));
  }
  remove(ns: string, id: string) {
    this.db.prepare('DELETE FROM documents WHERE namespace=? AND id=?').run(ns, id);
  }
  conversations(): Conversation[] {
    return (
      this.db.prepare('SELECT data FROM conversations ORDER BY rowid DESC').all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  conversation(id: string): Conversation | undefined {
    const r = this.db.prepare('SELECT data FROM conversations WHERE id=?').get(id) as
      { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  latestHumanAt(conversationIds?: string[]) {
    if (conversationIds && !conversationIds.length) return undefined;
    const scope = conversationIds
      ? ' AND conversation_id IN (' + conversationIds.map(() => '?').join(',') + ')'
      : '';
    const row = this.db
      .prepare(
        "SELECT MAX(json_extract(data,'$.createdAt')) AS at FROM messages WHERE json_extract(data,'$.source')='human' AND json_extract(data,'$.role')='user'" +
          scope,
      )
      .get(...(conversationIds ?? [])) as { at: string | null };
    return row.at ?? undefined;
  }
  saveConversation(value: Conversation) {
    this.db
      .prepare(
        'INSERT INTO conversations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(value.id, JSON.stringify(value));
  }
  deleteConversation(id: string) {
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT id FROM runs WHERE conversation_id=?').all(id) as {
        id: string;
      }[])
        this.db.prepare('DELETE FROM documents WHERE namespace=?').run('execution.' + row.id);
      this.db
        .prepare(
          "DELETE FROM receipts WHERE json_extract(data,'$.conversationId')=? OR json_extract(data,'$.input.conversationId')=?",
        )
        .run(id, id);
      this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM runs WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM bindings WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      this.remove('conversation-compactions', id);
      this.db.prepare('DELETE FROM kv WHERE key=?').run('review.watermark.' + id);
    });
  }
  messages(id: string, after = 0, limit = 10000): Message[] {
    return (
      this.db
        .prepare('SELECT data FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?')
        .all(id, after, limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  allMessages(id: string, after = 0): Message[] {
    return (
      this.db
        .prepare('SELECT data FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq')
        .all(id, after) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  appendTranscript(conversationId: string, runId: string, value: TranscriptMessage): string {
    const id = 'native-' + randomUUID();
    const data = persistentTranscript(value);
    this.db.prepare(`INSERT INTO session_entries (id,conversation_id,seq,run_id,data)
      VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM session_entries WHERE conversation_id=?),?,?)`)
      .run(id, conversationId, conversationId, runId, JSON.stringify(data));
    return id;
  }
  /** Model history is a projection of input/delivery facts and native messages.
   * A rendered reply does not duplicate the same run's native assistant action. */
  modelMessages(id: string, after = 0, limit = 10000, recent = false): Message[] {
    const rows = this.db.prepare(`SELECT e.id,e.seq,e.run_id,e.data,m.data AS message
      FROM session_entries e LEFT JOIN messages m ON m.id=e.message_id
      WHERE e.conversation_id=? AND e.seq>? AND NOT (
        m.id IS NOT NULL AND json_extract(m.data,'$.role')='assistant' AND EXISTS (
          SELECT 1 FROM session_entries n WHERE n.conversation_id=e.conversation_id AND n.run_id=e.run_id AND n.data IS NOT NULL))
      ORDER BY e.seq ${recent ? 'DESC' : 'ASC'} LIMIT ?`).all(id, after, limit) as
      { id: string; seq: number; run_id: string | null; data: string | null; message: string | null }[];
    if (recent) rows.reverse();
    return normalizeHistory(rows.map(row => {
      if (row.message) {
        const message = JSON.parse(row.message) as Message;
        return { ...message, seq: row.seq, meta: { ...message.meta, canonicalSeq: message.seq } };
      }
      const native = JSON.parse(row.data!) as TranscriptMessage;
      return { id: row.id, conversationId: id, seq: row.seq,
        role: native.role === 'assistant' ? 'assistant' as const : 'tool' as const,
        source: 'tool' as const, runId: row.run_id ?? undefined,
        createdAt: new Date(native.timestamp).toISOString(), text: transcriptText(native), meta: { native } };
    }));
  }
  modelPosition(id: string): number | undefined {
    const row = this.db.prepare('SELECT seq FROM session_entries WHERE id=? OR message_id=?').get(id, id) as
      { seq: number } | undefined;
    return row?.seq;
  }
  legacyModelPosition(conversationId: string, through: number): number {
    const row = this.db.prepare(`SELECT e.seq FROM messages m JOIN session_entries e ON e.message_id=m.id
      WHERE m.conversation_id=? AND m.seq<=? ORDER BY m.seq DESC LIMIT 1`).get(conversationId, through) as
      { seq: number } | undefined;
    return row?.seq ?? 0;
  }
  recentMessages(id: string, limit = 1000): Message[] {
    return (
      this.db
        .prepare('SELECT data FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT ?')
        .all(id, limit) as { data: string }[]
    )
      .reverse()
      .map((row) => JSON.parse(row.data));
  }
  historyPage(id: string, limit: number, before?: number): Message[] {
    const rows =
      before === undefined
        ? this.db
            .prepare('SELECT data FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT ?')
            .all(id, limit)
        : this.db
            .prepare(
              'SELECT data FROM messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
            )
            .all(id, before, limit);
    return (rows as { data: string }[]).reverse().map((row) => JSON.parse(row.data));
  }
  message(id: string): Message | undefined {
    const r = this.db.prepare('SELECT data FROM messages WHERE id=?').get(id) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  assistantForRun(id: string): Message | undefined {
    const r = this.db
      .prepare(
        "SELECT data FROM messages WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.role')='assistant' AND COALESCE(json_extract(data,'$.meta.replyPhase'),'final')='final' ORDER BY seq DESC LIMIT 1",
      )
      .get(id) as any;
    return r ? JSON.parse(r.data) : undefined;
  }
  channelFinalsForRun(run: Pick<Run, 'id' | 'conversationId'>): Message[] {
    const rows = this.db.prepare(
      "SELECT data FROM messages WHERE conversation_id=? AND json_extract(data,'$.runId')=? AND json_extract(data,'$.meta.replyPhase')='final' ORDER BY seq",
    ).all(run.conversationId, run.id) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
  }
  unresolved(conversationId?: string): Run[] {
    const sql = "SELECT data FROM runs WHERE json_extract(data,'$.state') IN ('running','unknown')";
    const rows = (
      conversationId
        ? this.db.prepare(sql + ' AND conversation_id=?').all(conversationId)
        : this.db.prepare(sql).all()
    ) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data));
  }
  append(
    conversationId: string,
    role: Message['role'],
    source: Message['source'],
    text: string,
    runId?: string,
    meta: Record<string, unknown> = {},
  ): Message {
    const seq = Number(
      (
        this.db
          .prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE conversation_id=?')
          .get(conversationId) as { n: number }
      ).n,
    );
    const message: Message = {
      id: randomUUID(),
      conversationId,
      seq,
      role,
      source,
      text,
      runId,
      meta,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO messages VALUES (?,?,?,?)')
      .run(message.id, conversationId, seq, JSON.stringify(message));
    return message;
  }
  binding(id: string): Binding | undefined {
    const r = this.db.prepare('SELECT data FROM bindings WHERE conversation_id=?').get(id) as
      { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  saveBinding(binding: Binding) {
    this.db
      .prepare(
        'INSERT INTO bindings VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET data=excluded.data',
      )
      .run(binding.conversationId, JSON.stringify(binding));
  }
  runs(): Run[] {
    return (
      this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC LIMIT 500').all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  sourceRunsSince(source: Run['source'], since: string): Run[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM runs WHERE json_extract(data,'$.source')=? AND json_extract(data,'$.createdAt')>=? ORDER BY rowid",
        )
        .all(source, since) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  run(id: string): Run | undefined {
    const r = this.db.prepare('SELECT data FROM runs WHERE id=? OR request_id=?').get(id, id) as
      { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  createRun(run: Run) {
    this.db
      .prepare('INSERT INTO runs VALUES (?,?,?,?)')
      .run(run.id, run.requestId, run.conversationId, JSON.stringify(run));
  }
  updateRun(run: Run) {
    this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id);
  }
  receipt(id: string): Record<string, any> | undefined {
    const r = this.db.prepare('SELECT data FROM receipts WHERE id=?').get(id) as
      { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  saveReceipt(id: string, data: Record<string, unknown>) {
    this.db
      .prepare('INSERT INTO receipts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(id, JSON.stringify(data));
  }
  receipts() {
    return (
      this.db.prepare('SELECT id,data FROM receipts').all() as { id: string; data: string }[]
    ).map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
  }
  queuedInput(conversationId: string) {
    const row = this.db
      .prepare(
        `
      SELECT id,data FROM receipts
      WHERE json_extract(data,'$.kind')='input' AND json_extract(data,'$.state')='queued'
        AND json_extract(data,'$.input.conversationId')=?
      ORDER BY json_extract(data,'$.createdAt'),rowid LIMIT 1
    `,
      )
      .get(conversationId) as { id: string; data: string } | undefined;
    return row && { id: row.id, ...JSON.parse(row.data) };
  }
  pendingDeliveries() {
    return (this.db.prepare('SELECT id,data FROM receipts').all() as { id: string; data: string }[])
      .map((r) => ({ id: r.id, ...JSON.parse(r.data) }))
      .filter((r) => r.kind === 'bubble' && r.state === 'pending');
  }
  close() {
    this.db.close();
  }
}
