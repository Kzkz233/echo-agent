import { parsedDocument } from '../../packages/contracts/documents.ts';
import { Events } from '../../packages/kernel/events.ts';
import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { mkdir, open, readFile, writeFile, rename, realpath, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, relative, isAbsolute, join, extname, dirname } from 'node:path';
import { Entries } from './entries.ts';
import { LibraryDatabase } from './database.ts';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import type { Plugin } from '../../packages/kernel/registry.ts';
import { operations } from '../shared.ts';
import {
  privateLibraryOwners,
  type ResourceReader,
} from '../../packages/kernel/resource-access.ts';
import { maxReplyImageBytes } from '../../packages/kernel/reply-images.ts';
export type Vault = {
  id: string;
  name: string;
  path: string;
  owner?: string;
  registeredBy?: string;
  writePolicy?: 'user' | 'plugin';
};
export type FileRecord = {
  kind: 'source' | 'derived';
  id: string;
  vaultId: string;
  relativePath: string;
  name: string;
  hash: string;
  bytes: number;
  source?: string;
  updatedAt: string;
  revision: number;
  mediaType: string;
};
/** Explicitly registered roots; shared storage mechanics, no knowledge/media semantics. */
export class Files {
  readonly entries = new Entries(this);
  private databases = new Map<string, LibraryDatabase>();
  private active = false;
  private generation = 0;
  private mediaTickets = new Map<string, { vaultId: string; hash: string; expires: number }>();
  private mediaLife = new AbortController();
  constructor(
    readonly store: Store,
    readonly defaultRoot?: string,
    readonly events?: Events,
  ) {}
  roots() {
    return this.store.documents<Vault>('vaults');
  }
  assertWrite(vaultId: string, writer?: string) {
    const vault = this.roots().find((v) => v.id === vaultId);
    invariant(vault, 'vault_missing', '知识库不存在');
    invariant(
      !vault.owner || vault.owner === writer,
      'library_managed',
      '此知识库由所属插件管理，请通过对应功能修改。',
    );
  }
  async managed(owner: string, name: string) {
    const id = 'managed-' + owner,
      existing = this.roots().find((v) => v.id === id);
    if (existing) {
      invariant(existing.owner === owner, 'library_owner', '知识库归属不一致');
      return existing;
    }
    return this.register({
      id,
      name,
      path: join(dirname(this.store.path), 'Libraries', owner),
      owner,
      writePolicy: 'plugin',
      registeredBy: owner,
    });
  }
  get available() {
    return this.active;
  }
  async register(vault: Vault) {
    invariant(this.active, 'plugin_disabled', 'Files 插件未启用');
    const generation = this.generation;
    await mkdir(vault.path, { recursive: true });
    const path = await realpath(vault.path);
    invariant(this.active && generation === this.generation, 'plugin_disabled', 'Files 插件已停止');
    invariant(
      !this.roots().some((r) => r.id !== vault.id && r.path.toLowerCase() === path.toLowerCase()),
      'library_duplicate',
      '此目录已注册',
    );
    const old = this.store.document<Vault>('vaults', vault.id);
    invariant(
      !old || old.path.toLowerCase() === path.toLowerCase(),
      'library_rebind',
      '请用新的目录编号注册不同知识库',
    );
    const db = new LibraryDatabase(join(path, 'library.sqlite'));
    let recordedOwner: string | undefined;
    try {
      recordedOwner = (
        db.db.prepare("SELECT value FROM library_meta WHERE key='owner'").get() as any
      )?.value;
      invariant(
        !recordedOwner || !vault.owner || recordedOwner === vault.owner,
        'library_owner',
        '不能更改知识库所属插件',
      );
      if (vault.owner && !recordedOwner)
        db.db.prepare("INSERT INTO library_meta VALUES('owner',?)").run(vault.owner);
    } finally {
      db.close();
    }
    const owner = recordedOwner ?? vault.owner ?? old?.owner;
    const value = {
      ...vault,
      path,
      owner,
      registeredBy: old?.registeredBy ?? vault.registeredBy ?? owner ?? 'manual',
      writePolicy: owner ? ('plugin' as const) : ('user' as const),
    };
    this.store.put('vaults', vault.id, value);
    try {
      await this.database(vault.id);
    } catch (e) {
      if (!old) this.store.remove('vaults', vault.id);
      throw e;
    }
    this.events?.emit('files.roots.changed', {});
    return value;
  }
  async database(vaultId: string) {
    invariant(this.active, 'plugin_disabled', 'Files 插件未启用');
    const cached = this.databases.get(vaultId);
    if (cached) return cached;
    const generation = this.generation;
    const path = await this.path(vaultId, 'library.sqlite');
    invariant(this.active && generation === this.generation, 'plugin_disabled', 'Files 插件已停止');
    let db = this.databases.get(vaultId);
    if (!db) {
      db = new LibraryDatabase(path);
      this.databases.set(vaultId, db);
    }
    return db;
  }
  async records(vaultId?: string): Promise<FileRecord[]> {
    const result: FileRecord[] = [];
    for (const root of this.roots().filter((r) => !vaultId || r.id === vaultId)) {
      const database = await this.database(root.id);
      const rows = database.db
        .prepare(
          'SELECT files.*,objects.path,objects.bytes,objects.media_type FROM files JOIN objects ON object_hash=hash',
        )
        .all() as any[];
      result.push(
        ...rows.map((row) => ({
          id: row.id,
          vaultId: root.id,
          name: row.name,
          kind: row.kind,
          hash: row.object_hash,
          relativePath: row.path,
          bytes: row.bytes,
          source: row.source_uri ?? undefined,
          updatedAt: row.updated_at,
          revision: row.revision,
          mediaType: row.media_type,
        })),
      );
    }
    return result;
  }
  async record(id: string) {
    const matches: FileRecord[] = [];
    for (const vault of this.roots()) {
      const db = await this.database(vault.id),
        row = db.db
          .prepare(
            'SELECT files.*,objects.path,objects.bytes,objects.media_type FROM files JOIN objects ON object_hash=hash WHERE files.id=?',
          )
          .get(id) as any;
      if (row)
        matches.push({
          id: row.id,
          vaultId: vault.id,
          name: row.name,
          kind: row.kind,
          hash: row.object_hash,
          relativePath: row.path,
          bytes: row.bytes,
          source: row.source_uri ?? undefined,
          updatedAt: row.updated_at,
          revision: row.revision,
          mediaType: row.media_type,
        });
    }
    invariant(
      matches.length <= 1,
      'file_ambiguous',
      '多个知识库包含相同文件编号，请避免重复注册同一知识库副本',
    );
    return matches[0];
  }
  async page(
    v: {
      vaultId?: string;
      query: string;
      kind: 'source' | 'derived' | 'all';
      offset: number;
      limit: number;
    },
    reader?: ResourceReader,
  ) {
    const rows: FileRecord[] = [];
    let total = 0;
    for (const vault of this.roots().filter((r) => !v.vaultId || r.id === v.vaultId)) {
      if (reader?.kind === 'mcp' && privateLibraryOwners.has(vault.owner ?? '')) continue;
      const db = await this.database(vault.id),
        terms = [],
        args: any[] = [];
      if (v.kind !== 'all') {
        terms.push('files.kind=?');
        args.push(v.kind);
      }
      if (v.query) {
        terms.push("lower(files.name) LIKE ? ESCAPE '\\'");
        args.push('%' + v.query.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%');
      }
      const where = terms.length ? ' WHERE ' + terms.join(' AND ') : '';
      total += Number(
        (db.db.prepare('SELECT count(*) n FROM files' + where).get(...args) as any).n,
      );
      const found = db.db
        .prepare(
          'SELECT files.*,objects.path,objects.bytes,objects.media_type FROM files JOIN objects ON object_hash=hash' +
            where +
            ' ORDER BY files.name COLLATE NOCASE,files.id LIMIT ?',
        )
        .all(...args, v.offset + v.limit) as any[];
      rows.push(
        ...found.map((row) => ({
          id: row.id,
          vaultId: vault.id,
          name: row.name,
          kind: row.kind,
          hash: row.object_hash,
          relativePath: row.path,
          bytes: row.bytes,
          source: row.source_uri ?? undefined,
          updatedAt: row.updated_at,
          revision: row.revision,
          mediaType: row.media_type,
        })),
      );
    }
    rows.sort((a, b) =>
      a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : a.name.toLowerCase() > b.name.toLowerCase()
          ? 1
          : a.id.localeCompare(b.id),
    );
    return {
      items: rows.slice(v.offset, v.offset + v.limit),
      total,
      hasMore: v.offset + v.limit < total,
    };
  }
  async media(vaultId: string, hash: string) {
    const db = await this.database(vaultId);
    invariant(
      db.db.prepare('SELECT hash FROM objects WHERE hash=?').get(hash),
      'file_missing',
      '媒体对象不存在',
    );
    for (const [key, v] of this.mediaTickets)
      if (v.expires < Date.now()) this.mediaTickets.delete(key);
    while (this.mediaTickets.size >= 128)
      this.mediaTickets.delete(this.mediaTickets.keys().next().value!);
    const ticket = randomBytes(24).toString('base64url'),
      expires = Date.now() + 30 * 60000;
    this.mediaTickets.set(ticket, { vaultId, hash, expires });
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }
  async resolveMedia(ticket: string) {
    const grant = this.mediaTickets.get(ticket);
    invariant(
      grant && grant.expires > Date.now(),
      'media_expired',
      '媒体授权已过期，请重新打开条目',
    );
    return this.mediaObject(grant.vaultId, grant.hash);
  }
  private async mediaObject(vaultId: string, hash: string) {
    const db = await this.database(vaultId),
      object = db.db.prepare('SELECT * FROM objects WHERE hash=?').get(hash) as any;
    invariant(
      object && object.path === `objects/${hash.slice(0, 2)}/${hash}`,
      'file_missing',
      '对象路径无效',
    );
    const path = await this.path(vaultId, object.path),
      info = await stat(path);
    invariant(
      info.isFile() && info.size === object.bytes,
      'file_changed',
      '媒体已在应用外变化，请核对',
    );
    return {
      path,
      bytes: object.bytes as number,
      mediaType: object.media_type as string,
      signal: this.mediaLife.signal,
    };
  }
  async path(vaultId: string, subpath: string) {
    const vault = this.store.document<Vault>('vaults', vaultId);
    invariant(vault, 'vault_missing', '请先注册文件目录');
    const root = await realpath(vault.path),
      candidate = resolve(root, subpath),
      rel = relative(root, candidate);
    const inside = (p: string) =>
      p !== '..' && !p.startsWith('..\\') && !p.startsWith('../') && !isAbsolute(p);
    invariant(inside(rel), 'path_escape', '路径超出授权目录');
    let current = root;
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      try {
        invariant(
          inside(relative(root, await realpath(current))),
          'path_escape',
          '目录链接指向授权范围外',
        );
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return candidate;
  }
  async write(
    vaultId: string,
    relativePath: string,
    bytes: Buffer | string | { temporaryPath: string; hash: string; size: number },
    metadata: { id?: string; source?: string; name?: string; kind?: 'source' | 'derived' } = {},
    signal?: AbortSignal,
  ) {
    invariant(this.active, 'plugin_disabled', 'Files 插件未启用');
    const generation = this.generation;
    const check = () => {
      signal?.throwIfAborted();
      invariant(
        this.active && generation === this.generation,
        'plugin_disabled',
        'Files 插件已停止',
      );
    };
    check();
    const prepared = typeof bytes === 'object' && !Buffer.isBuffer(bytes) ? bytes : undefined;
    const data = Buffer.isBuffer(bytes) ? bytes : typeof bytes === 'string' ? Buffer.from(bytes) : undefined;
    const hash = prepared?.hash ?? createHash('sha256').update(data!).digest('hex');
    const size = prepared?.size ?? data!.length;
    const objectPath = `objects/${hash.slice(0, 2)}/${hash}`;
    const path = await this.path(vaultId, objectPath);
    check();
    await mkdir(resolve(path, '..'), { recursive: true });
    check();
    const temp = prepared?.temporaryPath ?? path + '.' + randomUUID() + '.tmp';
    if (!prepared) await writeFile(temp, data!, { flag: 'wx' });
    check();
    await rename(temp, path);
    check();
    const database = await this.database(vaultId);
    check();
    const mediaType =
      (
        {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.pdf': 'application/pdf',
          '.md': 'text/markdown',
          '.txt': 'text/plain',
        } as Record<string, string>
      )[extname(metadata.name ?? relativePath).toLowerCase()] ?? 'application/octet-stream';
    const row: FileRecord = {
      kind: metadata.kind ?? 'derived',
      id: metadata.id ?? randomUUID(),
      vaultId,
      relativePath: objectPath,
      name: metadata.name ?? relativePath.split(/[\\/]/).at(-1)!,
      hash,
      bytes: size,
      source: metadata.source,
      updatedAt: new Date().toISOString(),
      revision: 1,
      mediaType,
    };
    database.transaction(() => {
      const old = database.db.prepare('SELECT revision FROM files WHERE id=?').get(row.id) as any;
      row.revision = (old?.revision ?? 0) + 1;
      database.db
        .prepare('INSERT OR IGNORE INTO objects VALUES(?,?,?,?)')
        .run(hash, objectPath, size, mediaType);
      database.db
        .prepare(
          'INSERT INTO files VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,object_hash=excluded.object_hash,source_uri=excluded.source_uri,updated_at=excluded.updated_at,revision=excluded.revision',
        )
        .run(row.id, row.name, row.kind, hash, row.source ?? null, row.updatedAt, row.revision);
    });
    this.events?.emit('files.updated', { vaultId });
    return row;
  }
  async captureVerified(
    vaultId: string, source: string, expectedHash: string, limit: number, signal: AbortSignal,
  ) {
    const physical = await realpath(source);
    const existing = (await this.records(vaultId)).find((file) =>
      file.kind === 'source' && file.source === physical);
    const temporaryPath = await this.path(vaultId, 'objects/' + randomUUID() + '.incoming');
    await mkdir(dirname(temporaryPath), { recursive: true });
    const digest = createHash('sha256');
    let size = 0;
    try {
      await pipeline(createReadStream(physical), new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          if (size > limit) return done(new Error('附件超过处理大小上限。'));
          digest.update(chunk);
          done(null, chunk);
        },
      }), createWriteStream(temporaryPath, { flags: 'wx' }), { signal });
      const hash = digest.digest('hex');
      invariant(hash === expectedHash, 'source_changed', '附件在读取期间已变化，请重新同步。');
      return await this.write(vaultId, physical, { temporaryPath, hash, size },
        { id: existing?.id, source: physical, kind: 'source' }, signal);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  }
  async import(vaultId: string, source: string, captured?: Buffer, signal?: AbortSignal) {
    const generation = this.generation;
    const check = () => {
      signal?.throwIfAborted();
      invariant(
        this.active && generation === this.generation,
        'plugin_disabled',
        'Files 插件已停止',
      );
    };
    check();
    const physical = await realpath(source),
      info = await stat(physical);
    check();
    invariant(info.isFile() && info.size <= 128000000, 'file_size', '文件需不超过128 MB');
    const old = (await this.records(vaultId)).find(
      (f) => f.kind === 'source' && f.vaultId === vaultId && f.source === physical,
    );
    const id = old?.id ?? randomUUID();
    const bytes = captured ?? (await readFile(physical, { signal }));
    check();
    return this.write(
      vaultId,
      old?.relativePath ?? `Files/${id}${extname(physical).toLowerCase()}`,
      bytes,
      { id, source: physical, name: physical.split(/[\\/]/).at(-1)!, kind: 'source' },
      signal,
    );
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(packageManifest),
      activate: async (ctx) => {
        ctx.capabilities.define({
          id: 'files.extract@1',
          description: '显式导入文档时的可选解析器',
          input: z.object({
            extension: z.string(),
            name: z.string(),
            data: z.string().max(22000000),
            requestId: z.string().optional(),
          }),
          output: parsedDocument.nullable(),
          providePermission: 'knowledge.parse',
          consumePermission: 'files.read',
          cardinality: 'one',
        });
        this.active = true;
        this.generation++;
        this.mediaLife = new AbortController();
        ctx.capabilities.provide(
          'core.reply-image@1',
          'files.reply-image',
          'File Archive',
          async ({ vaultId, hash }, signal) => {
            const { path, bytes, mediaType } = await this.mediaObject(vaultId, hash);
            invariant(
              mediaType === 'image/png' && bytes > 0 && bytes <= maxReplyImageBytes,
              'reply_image',
              '回复图片必须是受管的 PNG，且不超过 2 MB。',
            );
            signal.throwIfAborted();
            const file = await open(path, 'r');
            try {
              const data = Buffer.alloc(bytes);
              const result = await file.read({
                buffer: data,
                offset: 0,
                length: bytes,
                position: 0,
              });
              signal.throwIfAborted();
              invariant(
                result.bytesRead === bytes &&
                  createHash('sha256').update(data).digest('hex') === hash,
                'file_changed',
                '回复图片已变化。',
              );
              return data.toString('base64');
            } finally {
              await file.close();
            }
          },
        );
        ctx.dispose(() => {
          this.active = false;
          this.generation++;
          this.mediaTickets.clear();
          this.mediaLife.abort();
          for (const db of this.databases.values()) db.close();
          this.databases.clear();
        });
        if (this.defaultRoot && !this.roots().length)
          await this.register({
            id: 'local',
            name: 'Personal Knowledge',
            path: this.defaultRoot,
            registeredBy: 'knowledge',
          });
        if (!this.store.get('knowledge.personalLabel.v1', false)) {
          for (const vault of this.roots())
            if (!vault.owner && ['Local Files', '知识库', 'Knowledge Library'].includes(vault.name))
              this.store.put('vaults', vault.id, {
                ...vault,
                name: 'Personal Knowledge',
                registeredBy: 'knowledge',
              });
          this.store.set('knowledge.personalLabel.v1', true);
        }
        const op = operations(ctx, 'files');
        op(
          'media',
          'Grant access to one managed media object',
          z.object({ vaultId: id, hash: z.string().regex(/^[a-f0-9]{64}$/) }),
          'files.read',
          (v) => this.media(v.vaultId, v.hash),
          false,
        );
        op('roots', '授权目录', z.object({}), 'files.read', () => this.roots());
        op(
          'register',
          '注册文件目录',
          z.object({ id, name: z.string().min(1), path: z.string().min(1) }),
          'files.write',
          (v) => {
            invariant(
              !this.roots().find((r) => r.id === v.id)?.owner,
              'library_managed',
              '此知识库由所属插件管理',
            );
            return this.register(v);
          },
          false,
        );
        op(
          'declare',
          '插件声明自己管理的知识库',
          z.object({ name: z.string().min(1).max(160) }),
          'files.declare',
          (v, _s, caller) => {
            invariant(
              caller.kind === 'extension' && caller.pluginId,
              'library_declaration',
              '库归属由调用插件身份决定',
            );
            return this.managed(caller.pluginId, v.name);
          },
          false,
        );
        op(
          'list',
          '分页查找原件与派生文件',
          z.object({
            vaultId: id.optional(),
            query: z.string().max(500).default(''),
            kind: z.enum(['source', 'derived', 'all']).default('source'),
            offset: z.number().int().min(0).max(1000000).default(0),
            limit: z.number().int().min(1).max(200).default(50),
          }),
          'files.read',
          (v, _s, caller) => this.page(v, caller),
        );
        op(
          'read',
          '分段读取文本文件',
          z.object({
            id,
            offset: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(30000).default(12000),
          }),
          'files.read',
          async (v, _s, caller) => {
            const row = await this.record(v.id);
            invariant(row, 'file_missing', '文件不存在');
            invariant(
              caller.kind !== 'mcp' ||
                !privateLibraryOwners.has(
                  this.roots().find((root) => root.id === row.vaultId)?.owner ?? '',
                ),
              'resource_scope',
              '角色托管文件须通过所属模块读取。',
            );
            invariant(row.bytes <= 16000000, 'file_size', '请使用文档解析器处理大文件');
            const text = await readFile(await this.path(row.vaultId, row.relativePath), 'utf8');
            return {
              ...row,
              text: text.slice(v.offset, v.offset + v.limit),
              totalChars: text.length,
            };
          },
        );
        op(
          'import',
          '显式导入本地原件',
          z.object({ vaultId: id, source: z.string().min(1) }),
          'files.write',
          (v, s, caller) => {
            this.assertWrite(v.vaultId, caller.kind === 'extension' ? caller.pluginId : undefined);
            return this.import(v.vaultId, v.source, undefined, s);
          },
          false,
        );
      },
    };
  }
}
