import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, mkdtemp, open, realpath, rm, link, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Zip, ZipPassThrough, strToU8 } from 'fflate';
async function run() {
  const { directory, destination, mode, kinds, sourceLocations } = workerData,
    root = await realpath(directory),
    target = resolve(destination);
  if (!/\.zip$/i.test(target)) throw Error('Export must use a .zip filename');
  const relation = relative(root, target);
  if (
    relation === '' ||
    (!relation.startsWith('..' + sep) && relation !== '..' && !isAbsolute(relation))
  )
    throw Error('Export outside the managed library directory');
  await mkdir(dirname(target), { recursive: true });
  const temp = await mkdtemp(join(dirname(target), '.echo-export-')),
    output = join(temp, 'export.zip');
  try {
    const path = await realpath(join(root, 'library.sqlite'));
    if (relative(root, path) !== 'library.sqlite') throw Error('Library database path invalid');
    const live = new DatabaseSync(path, { readOnly: true });
    try {
      await backup(live, join(temp, 'library.sqlite'));
    } finally {
      live.close();
    }
    const database = new DatabaseSync(join(temp, 'library.sqlite'));
    let objects: any[], entries: any[], files: any[];
    try {
      database.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');
      // A derived full-text index may retain deleted terms. Rebuild on import.
      database.exec(
        'DROP TRIGGER IF EXISTS knowledge_fts_insert;DROP TRIGGER IF EXISTS knowledge_fts_delete;DROP TRIGGER IF EXISTS knowledge_fts_update;DROP TABLE IF EXISTS knowledge_fts;',
      );
      database
        .prepare('DELETE FROM entries WHERE kind NOT IN (' + kinds.map(() => '?').join(',') + ')')
        .run(...kinds);
      database.exec(
        'DELETE FROM files WHERE id NOT IN (SELECT source_file_id FROM entries WHERE source_file_id IS NOT NULL);DELETE FROM objects WHERE hash NOT IN (SELECT object_hash FROM files UNION SELECT source_hash FROM entries WHERE source_hash IS NOT NULL UNION SELECT object_hash FROM entry_attachments);',
      );
      database.exec(
        'DELETE FROM entry_revisions WHERE revision != (SELECT revision FROM entries WHERE entries.id=entry_revisions.entry_id)',
      );
      if (!sourceLocations) {
        database.exec('UPDATE entries SET source_uri=NULL;UPDATE files SET source_uri=NULL;');
      }
      database.exec('COMMIT;PRAGMA journal_mode=DELETE;VACUUM;');
      objects = database.prepare('SELECT * FROM objects').all();
      entries = database.prepare('SELECT * FROM entries').all();
      files = database.prepare('SELECT * FROM files').all();
    } finally {
      database.close();
    }
    const extensions: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'audio/wav': '.wav',
      'audio/mpeg': '.mp3',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'application/pdf': '.pdf',
      'text/markdown': '.md',
      'text/plain': '.txt',
    };
    const attachmentName = (hash: string) =>
      hash + (extensions[objects.find((o) => o.hash === hash)?.media_type] ?? '.bin');
    const out = await open(output, 'wx'),
      manifest: any[] = [];
    let writes = Promise.resolve(),
      failure: unknown,
      finished = false;
    const zip = new Zip((error, data, final) => {
      if (error) {
        failure = error;
        return;
      }
      writes = writes.then(async () => {
        let offset = 0;
        while (offset < data.length) {
          const r = await out.write(data, offset, data.length - offset);
          if (!r.bytesWritten) throw Error('Export write stalled');
          offset += r.bytesWritten;
        }
      });
      if (final) finished = true;
    });
    const flush = async () => {
      await writes;
      if (failure) throw failure;
    };
    const add = async (name: string, bytes: Uint8Array | AsyncIterable<Uint8Array>) => {
      const file = new ZipPassThrough(name),
        hash = createHash('sha256');
      let size = 0;
      zip.add(file);
      if (bytes instanceof Uint8Array) {
        hash.update(bytes);
        size = bytes.length;
        file.push(bytes, true);
        await flush();
      } else {
        for await (const chunk of bytes) {
          hash.update(chunk);
          size += chunk.length;
          file.push(chunk, false);
          await flush();
        }
        file.push(new Uint8Array(), true);
        await flush();
      }
      manifest.push({ path: name, hash: hash.digest('hex'), bytes: size });
    };
    try {
      if (mode === 'bundle')
        await add('library.sqlite', createReadStream(join(temp, 'library.sqlite')));
      else
        for (const entry of entries) {
          if (!/^[\w][\w.-]{0,159}$/.test(entry.id)) throw Error('Invalid entry ID');
          let text = entry.body as string;
          text = text.replace(
            /echo-asset:([a-f0-9]{64})/g,
            (_all, hash) => '../attachments/' + attachmentName(hash),
          );
          const header =
            '---\n' +
            Object.entries({
              id: entry.id,
              title: entry.title,
              kind: entry.kind,
              updatedAt: entry.updated_at,
              metadata: JSON.parse(entry.metadata),
            })
              .map(([k, v]) => k + ': ' + JSON.stringify(v))
              .join('\n') +
            '\n---\n\n';
          await add('entries/' + entry.id + '.md', strToU8(header + text));
        }
      for (const object of objects) {
        if (
          !/^[a-f0-9]{64}$/.test(object.hash) ||
          object.path !== `objects/${object.hash.slice(0, 2)}/${object.hash}`
        )
          throw Error('Invalid managed object');
        const path = await realpath(resolve(root, object.path));
        const rel = relative(root, path);
        if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
          throw Error('Attachment path invalid');
        const name =
          mode === 'bundle'
            ? object.path.replace(/\\/g, '/')
            : 'attachments/' + attachmentName(object.hash);
        await add(name, createReadStream(path));
        const saved = manifest.at(-1);
        if (saved.hash !== object.hash || saved.bytes !== object.bytes)
          throw Error('Attachment changed or hash mismatch');
      }
      if (mode === 'markdown')
        await add(
          'sources.json',
          strToU8(
            JSON.stringify(
              files.map((f) => ({
                id: f.id,
                name: f.name,
                hash: f.object_hash,
                source: f.source_uri,
              })),
              null,
              2,
            ),
          ),
        );
      const description = {
        format: mode === 'bundle' ? 'echo-library-bundle-v1' : 'echo-markdown-export-v1',
        createdAt: new Date().toISOString(),
        kinds,
        sourceLocations,
        files: manifest,
      };
      const file = new ZipPassThrough('manifest.json');
      zip.add(file);
      file.push(strToU8(JSON.stringify(description, null, 2)), true);
      zip.end();
      await flush();
      if (!finished) throw Error('Incomplete export');
      await out.sync();
    } finally {
      await out.close();
    }
    // Same-volume hard-link publishes only if no other file already occupies the destination.
    await link(output, target);
    await unlink(output);
    return {
      path: target,
      format: mode,
      entries: entries.length,
      objects: objects.length,
      sourceLocations,
    };
  } finally {
    const checked = resolve(temp);
    if (dirname(checked) !== dirname(target) || !basename(checked).startsWith('.echo-export-'))
      throw Error('Unsafe export cleanup');
    await rm(checked, { recursive: true, force: true });
  }
}
run().then(
  (result) => parentPort!.postMessage({ result }),
  (e) => parentPort!.postMessage({ error: e instanceof Error ? e.message : 'Export failed' }),
);
