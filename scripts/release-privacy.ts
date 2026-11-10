import { open, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

type PrivateReference = { names: string[]; text: string[]; assets: Set<string>; mailAddresses?: string[] };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const normalize = (text: string) => text.replaceAll('\\n', '\n').replace(/\s+/g, '');

/** Read-only, local comparison. Never serialize the private reference or matches. */
export async function privateReference(directory?: string): Promise<PrivateReference> {
  const result: PrivateReference = { names: [], text: [], assets: new Set() };
  if (!directory) return result;
  const db = new DatabaseSync(join(directory, 'echo.sqlite'), { readOnly: true });
  try {
    const mailConfig = db.prepare("SELECT value FROM kv WHERE key='mail.config'").get();
    const accounts = db.prepare("SELECT data FROM documents WHERE namespace='mail-accounts'").all();
    const mailReference = [mailConfig?.value, ...accounts.map(row => row.data)].join(' ');
    result.mailAddresses = [...new Set(mailReference.toLowerCase().match(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}/g) ?? [])];
    const rows = db
      .prepare(
        "SELECT namespace,id,data FROM documents WHERE namespace='personas' OR namespace LIKE 'character-settings.%'",
      )
      .all() as { namespace: string; id: string; data: string }[];
    const roles = rows
      .filter((row) => row.namespace === 'personas' && !row.id.startsWith('example-'))
      .map((row) => ({ id: row.id, ...JSON.parse(row.data) }));
    for (const role of roles) {
      if (role.name && role.name !== 'Echo' && role.name.length > 2) result.names.push(role.name);
      const prompt = normalize(String(role.prompt ?? ''));
      for (let i = 0; i + 160 <= prompt.length; i += 160)
        result.text.push(prompt.slice(i, i + 160));
      if (typeof role.portrait === 'string' && role.portrait.startsWith('data:'))
        result.text.push(role.portrait.slice(-300));
    }
    const directories = new Set<string>();
    const collect = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (['assetDirectory', 'meshDirectory'].includes(key) && typeof item === 'string' && item)
          directories.add(item);
        else if (item && typeof item === 'object') collect(item);
      }
    };
    for (const row of rows)
      if (
        row.namespace.startsWith('character-settings.') &&
        roles.some((role) => role.id === row.id)
      )
        collect(JSON.parse(row.data));
    for (const row of db
      .prepare("SELECT value FROM kv WHERE key = 'avatar.config'")
      .all() as { value: string }[])
      collect(JSON.parse(row.value));
    for (const directory of directories) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries)
        if (entry.isFile() && /\.(png|webp|jpe?g|json)$/i.test(entry.name))
          result.assets.add(digest(await readFile(join(directory, entry.name))));
    }
  } finally {
    db.close();
  }
  return result;
}

export async function auditReleaseTree(
  root: string,
  reference: PrivateReference = { names: [], text: [], assets: new Set() },
  rules: { forbidden?: RegExp; forbiddenBinary?: RegExp; approvedAssets?: ReadonlySet<string> } = {},
) {
  const home = [homedir(), homedir().replaceAll('\\', '/'), homedir().replaceAll('\\', '\\\\')].map(s => s.toLowerCase());
  const containsHome = (value: string) => {
    const normalized = value.toLowerCase();
    return home.some(prefix => normalized.includes(prefix));
  };
  const findings: { file: string; reason: string }[] = [];
  let files = 0;
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      const firstParty = !/(^|\/)(node_modules|licenses|\$PLUGINSDIR)\//i.test(name);
      const issue = (reason: string) => findings.push({ file: name, reason });
      if (rules.forbidden?.test(name)) {
        findings.push({ file: '(withheld)', reason: 'excluded release content in path' });
        continue;
      }
      if (entry.isSymbolicLink()) {
        issue('symbolic link');
        continue;
      }
      if (
        /(?:^|\/)\.env(?:[./]|$)|\.(?:db3?|sqlite3?(?:-wal|-shm)?|enl[xw]?|jsonl|ndjson|key|pem|pfx)$/i.test(name) ||
        (firstParty &&
          /(?:^|\/)(?:credentials|vaults?|libraries|observations|avatar-assets|private|harnesses|backups|exports|test-results|connection\.json|instance\.lock)(?:\/|$)/i.test(name))
      ) {
        issue('runtime/private data path');
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files++;
      if (!firstParty) continue;
      if (rules.approvedAssets && /\.(?:zip|7z|rar|gz|tgz|tar|bak|pdf|docx|xlsx|pptx|ris|map)$/i.test(name)) {
        issue('unapproved embedded archive or document');
        continue;
      }
      const prefix = Buffer.alloc(16);
      const handle = await open(path, 'r');
      try {
        await handle.read(prefix, 0, prefix.length, 0);
      } finally {
        await handle.close();
      }
      if (prefix.toString() === 'SQLite format 3\0') {
        issue('embedded database');
        continue;
      }
      const textual =
        /\.(?:ts|tsx|rs|js|mjs|cjs|json|md|txt|ya?ml|toml|ps1|cmd|html|css|svg|xml)$/i.test(name) ||
        entry.name === '.npmrc';
      if (textual) {
        const contents = await readFile(path, 'utf8');
        const compact = normalize(contents);
        if (containsHome(contents) || /[a-z]:[\\/]+Users[\\/]+(?!Public[\\/]+)[\w.-]+[\\/]/i.test(contents))
          issue('local user path');
        if (rules.forbidden?.test(contents)) issue('excluded release content');
        if (/(?:sk-[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|_authToken\s*=\s*[^$\s]+)/.test(contents))
          issue('credential-like content');
        if (reference.names.some(value => contents.includes(value)) || reference.text.some(value => compact.includes(value)))
          issue('private character content');
        if (reference.mailAddresses?.some(address => contents.toLowerCase().includes(address)))
          issue('private mail address');
      }
      const forbiddenBinary = rules.forbiddenBinary ?? rules.forbidden;
      if (forbiddenBinary && /\.(?:exe|dll)$/i.test(name)) {
        const binary = await readFile(path);
        const strings = [binary.toString('utf8'), binary.toString('utf16le'), binary.subarray(1).toString('utf16le')];
        if (strings.some(value => forbiddenBinary.test(value) || containsHome(value)))
          issue('excluded content or local user path in executable');
      }
      const media = /\.(?:png|webp|jpe?g|ico|gif|svg|bmp|mp[34]|wav|webm|ogg)$/i.test(name);
      if ((rules.approvedAssets && media) ||
          (reference.assets.size && (media || /\.json$/i.test(name)) && (await stat(path)).size < 50000000)) {
        const hash = digest(await readFile(path));
        if (reference.assets.has(hash)) issue('private character asset');
        if (rules.approvedAssets && media && !rules.approvedAssets.has(hash)) issue('unapproved public media asset');
      }
    }
  }
  await walk(root);
  if (findings.length) throw Error('Release privacy audit failed: ' + JSON.stringify(findings));
  return {
    files,
    privateReferenceUsed: reference.names.length > 0 || reference.text.length > 0 || reference.assets.size > 0,
    findings: 0,
  };
}
