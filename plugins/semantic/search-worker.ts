import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { resolvePortableSpace } from './portable-index.ts';
try {
  const { path, entries, vector } = workerData,
    db = new DatabaseSync(path, { readOnly: true });
  const space = resolvePortableSpace(db, workerData.space);
  try {
    const dimension = (
      db.prepare('SELECT dimension FROM spaces WHERE fingerprint=?').get(space) as any
    )?.dimension;
    if (dimension !== vector.length) throw Error('迁移索引的向量维度不匹配');
    const qnorm = Math.sqrt(vector.reduce((s: number, x: number) => s + x * x, 0));
    if (!qnorm) throw Error('查询向量无效');
    const best = new Map<string, any>();
    db.exec(
      'CREATE TEMP TABLE scope(vault_id TEXT,document_id TEXT,body_hash TEXT,PRIMARY KEY(vault_id,document_id)) WITHOUT ROWID',
    );
    const add = db.prepare('INSERT OR IGNORE INTO scope VALUES(?,?,?)');
    for (const e of entries) add.run(e.vaultId, e.documentId, e.bodyHash);
    const rows =
      db.prepare(`SELECT v.* FROM vectors v JOIN documents d ON d.space=v.space AND d.vault_id=v.vault_id AND d.document_id=v.document_id
      JOIN scope s ON s.vault_id=d.vault_id AND s.document_id=d.document_id AND s.body_hash=d.body_hash WHERE v.space=?`);
    for (const row of rows.iterate(space) as Iterable<any>) {
      const b = row.embedding as Uint8Array;
      if (b.byteLength !== dimension * 4) throw Error('迁移索引存在损坏向量');
      const data =
        b.byteOffset % 4
          ? new Float32Array(b.slice().buffer)
          : new Float32Array(b.buffer, b.byteOffset, dimension);
      let dot = 0,
        norm = 0;
      for (let n = 0; n < dimension; n++) {
        dot += data[n] * vector[n];
        norm += data[n] * data[n];
      }
      if (!Number.isFinite(dot) || !norm) continue;
      const score = Math.max(-1, Math.min(1, dot / (qnorm * Math.sqrt(norm)))),
        key = JSON.stringify([row.vault_id, row.document_id]);
      if (!best.has(key) || best.get(key).score < score)
        best.set(key, {
          key,
          score,
          text: row.text,
          node: {
            id: row.node_id,
            modality: row.modality,
            ...(row.parent_id ? { parentId: row.parent_id } : {}),
          },
        });
    }
    parentPort!.postMessage({ result: [...best.values()] });
  } finally {
    db.close();
  }
} catch (e) {
  parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
}
