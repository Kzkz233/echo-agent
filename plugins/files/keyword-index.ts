import type { LibraryDatabase } from './database.ts';
const prepared = new WeakSet<LibraryDatabase>();
function terms(value: string) {
  const text = value.toLowerCase(),
    result: string[] = text.replace(/\p{Script=Han}+/gu, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const block of text.match(/\p{Script=Han}+/gu) ?? []) {
    if (block.length === 1) result.push(block);
    else for (let n = 0; n < block.length - 1; n++) result.push(block.slice(n, n + 2));
  }
  return result;
}
export function prepareKeywordIndex(database: LibraryDatabase) {
  if (prepared.has(database)) return;
  database.db.function('echo_keyword_terms', { deterministic: true }, (text) =>
    terms(String(text ?? '')).join(' '),
  );
  const exists = database.db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_fts'")
    .get();
  database.transaction(() => {
    database.db
      .exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED,title,body);
      CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON entries BEGIN INSERT INTO knowledge_fts(id,title,body)VALUES(new.id,echo_keyword_terms(new.title),echo_keyword_terms(new.body));END;
      CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON entries BEGIN DELETE FROM knowledge_fts WHERE id=old.id;END;
      CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE OF title,body ON entries BEGIN DELETE FROM knowledge_fts WHERE id=old.id;INSERT INTO knowledge_fts(id,title,body)VALUES(new.id,echo_keyword_terms(new.title),echo_keyword_terms(new.body));END;`);
    if (!exists)
      database.db.exec(
        'INSERT INTO knowledge_fts(id,title,body) SELECT id,echo_keyword_terms(title),echo_keyword_terms(body) FROM entries',
      );
  });
  prepared.add(database);
}
export function keywordCandidates(database: LibraryDatabase, queries: string[], allowed: string[]) {
  prepareKeywordIndex(database);
  if (!allowed.length) return [];
  const ids = new Set<string>();
  for (const query of queries) {
    const tokens = [...new Set(terms(query))].slice(0, 80);
    if (!tokens.length) continue;
    const expression = tokens.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
    const rows = database.db
      .prepare(
        'SELECT id FROM knowledge_fts WHERE knowledge_fts MATCH ? AND id IN (' +
          allowed.map(() => '?').join(',') +
          ') ORDER BY bm25(knowledge_fts,0,4,1) LIMIT 64',
      )
      .all(expression, ...allowed) as { id: string }[];
    for (const row of rows) ids.add(row.id);
  }
  return [...ids];
}
