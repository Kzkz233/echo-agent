import { readFile, readdir, stat } from 'node:fs/promises';
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
) {
  const home = [homedir(), homedir().replaceAll('\\', '/'), homedir().replaceAll('\\', '\\\\')];
  const findings: { file: string; reason: string }[] = [];
  let files = 0;
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        name = relative(root, path).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        findings.push({ file: name, reason: 'symbolic link' });
        continue;
      }
      if (
        /(^|\/)(?:\.env|echo\.sqlite(?:-wal|-shm)?|credentials|Vault|observations|avatar-assets|private)(?:\/|$)/i.test(
          name,
        ) &&
        !name.startsWith('node_modules/')
      ) {
        findings.push({ file: name, reason: 'runtime/private data path' });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files++;
      const firstParty = !name.startsWith('node_modules/') && !name.startsWith('licenses/');
      const textual =
        /\.(?:ts|tsx|rs|js|mjs|json|md|txt|ya?ml|toml|ps1|cmd)$/i.test(name) ||
        entry.name === '.npmrc';
      if (textual && firstParty) {
        const contents = await readFile(path, 'utf8'),
          compact = normalize(contents);
        if (home.some((prefix) => contents.includes(prefix)))
          findings.push({ file: name, reason: 'local user path' });
        if (
          /(?:sk-[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|_authToken\s*=\s*[^$\s]+)/.test(
            contents,
          )
        )
          findings.push({ file: name, reason: 'credential-like content' });
        if (
          reference.names.some((name) => contents.includes(name)) ||
          reference.text.some((text) => compact.includes(text))
        )
          findings.push({ file: name, reason: 'private character content' });
        if (reference.mailAddresses?.some(address => contents.toLowerCase().includes(address)))
          findings.push({ file: name, reason: 'private mail address' });
      }
      if (
        firstParty &&
        reference.assets.size &&
        /\.(png|webp|jpe?g|json)$/i.test(name) &&
        (await stat(path)).size < 50000000
      )
        if (reference.assets.has(digest(await readFile(path))))
          findings.push({ file: name, reason: 'private character asset' });
    }
  }
  await walk(root);
  if (findings.length) throw Error('Release privacy audit failed: ' + JSON.stringify(findings));
  return {
    files,
    privateReferenceUsed:
      reference.names.length > 0 || reference.text.length > 0 || reference.assets.size > 0,
    findings: 0,
  };
}
