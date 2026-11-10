import { snapshotDatabase } from '../../packages/kernel/storage.ts';
import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, relative, isAbsolute, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
async function run() {
  const { database, destination } = workerData;
  await mkdir(destination, { recursive: true });
  await snapshotDatabase(database, join(destination, 'echo.sqlite'));
  const snapshot = new DatabaseSync(join(destination, 'echo.sqlite'), { readOnly: true });
  const manifest: { path: string; hash: string; bytes: number }[] = [];
  const safe = (p: string) =>
    p !== '..' && !p.startsWith('..\\') && !p.startsWith('../') && !isAbsolute(p);
  const save = async (sub: string, bytes: Buffer) => {
    const target = resolve(destination, sub);
    if (!safe(relative(destination, target))) throw Error('无效备份路径');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    manifest.push({
      path: sub,
      hash: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  };
  const recordFile = async (sub: string, path: string, copy = false, expected?: string) => {
    const target = resolve(destination, sub);
    if (!safe(relative(destination, target))) throw Error('无效备份路径');
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let bytes = 0;
    const input = createReadStream(path);
    if (copy)
      await pipeline(
        input,
        new Transform({
          transform(data, _enc, cb) {
            hash.update(data);
            bytes += data.length;
            cb(null, data);
          },
        }),
        createWriteStream(target, { flags: 'wx' }),
      );
    else
      for await (const data of input) {
        hash.update(data);
        bytes += data.length;
      }
    const digest = hash.digest('hex');
    if (expected && digest !== expected) throw Error('Attachment hash mismatch');
    manifest.push({ path: sub, hash: digest, bytes });
  };
  try {
    const rows = (namespace: string) =>
      (
        snapshot.prepare('SELECT data FROM documents WHERE namespace=?').all(namespace) as any[]
      ).map((r) => JSON.parse(r.data));
    const roots = new Map(rows('vaults').map((r) => [r.id, r.path]));
    for (const [id, configured] of roots) {
      if (!/^[\w][\w.-]*$/.test(id)) throw Error('Invalid library ID');
      const root = await realpath(configured),
        database = await realpath(join(root, 'library.sqlite'));
      if (!safe(relative(root, database))) throw Error('Library database outside authorized root');
      const folder = join(destination, 'vaults', id);
      await mkdir(folder, { recursive: true });
      await snapshotDatabase(database, join(folder, 'library.sqlite'));
      const library = new DatabaseSync(join(folder, 'library.sqlite'), { readOnly: true });
      try {
        for (const object of library.prepare('SELECT * FROM objects').all() as any[]) {
          const path = await realpath(resolve(root, object.path));
          if (!safe(relative(root, path))) throw Error('Attachment path outside authorized root');
          await recordFile(
            `vaults/${id}/${object.path.replace(/\\/g, '/')}`,
            path,
            true,
            object.hash,
          );
        }
      } finally {
        library.close();
      }
      await recordFile(`vaults/${id}/library.sqlite`, join(folder, 'library.sqlite'));
    }
  } finally {
    snapshot.close();
  }
  const index = join(dirname(database), 'semantic/index.sqlite');
  if (existsSync(index)) {
    await mkdir(join(destination, 'semantic'), { recursive: true });
    await snapshotDatabase(index, join(destination, 'semantic/index.sqlite'));
    await recordFile('semantic/index.sqlite', join(destination, 'semantic/index.sqlite'));
  }
  const raw = join(dirname(database), 'observations');
  const attachments=join(dirname(database),'chat-attachments');
  for(const file of await readdir(attachments).catch(()=>[]))if(/^[a-f0-9]{64}$/.test(file))
    await save('chat-attachments/'+file,await readFile(join(attachments,file)));
  for (const file of await readdir(raw).catch(() => []))
    if (/^\d{4}-\d\d-\d\d\.jsonl$/.test(file))
      await save('observations/' + file, await readFile(join(raw, file)));
  const bytes = await readFile(join(destination, 'echo.sqlite'));
  manifest.push({
    path: 'echo.sqlite',
    hash: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
  await writeFile(
    join(destination, 'manifest.json'),
    JSON.stringify(
      {
        format: 'echo-backup-v1',
        createdAt: new Date().toISOString(),
        credentialsIncluded: false,
        files: manifest,
      },
      null,
      2,
    ),
  );
  return {
    directory: destination,
    files: manifest.length,
    bytes: manifest.reduce((n, f) => n + f.bytes, 0),
  };
}
run().then(
  (result) => parentPort!.postMessage({ result }),
  (e) => parentPort!.postMessage({ error: e instanceof Error ? e.message : '备份失败' }),
);
