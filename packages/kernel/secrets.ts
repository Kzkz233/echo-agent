import { spawn } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { invariant } from '../contracts/index.ts';

export class Secrets {
  constructor(readonly root: string) {}
  private async dpapi(input: string, decrypt: boolean) {
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (b) => (output += b));
      child.stderr.resume();
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve(output.trim()) : reject(new Error('系统凭据保护操作失败。')),
      );
      child.stdin.end(input);
    });
  }
  private async key() {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, 'master.key');
    try {
      return await readFile(path);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      const key = randomBytes(32);
      await writeFile(path, key, { mode: 0o600, flag: 'wx' });
      return key;
    }
  }
  async set(reference: string, secret: string) {
    invariant(
      /^[\w.-]{1,100}$/.test(reference),
      'credential_name',
      '凭据名称仅使用字母、数字、点和连字符。',
    );
    await mkdir(this.root, { recursive: true });
    let sealed: string;
    if (process.platform === 'win32')
      sealed = 'dpapi:' + (await this.dpapi(Buffer.from(secret).toString('base64'), false));
    else {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
      const bytes = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      sealed = 'aes:' + Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    }
    await writeFile(join(this.root, reference + '.secret'), sealed, { mode: 0o600 });
  }
  async status(reference: string) {
    try { return { configured: !!(await this.get(reference)), source: reference.startsWith('env:') ? reference : 'local' }; }
    catch { return { configured: false, source: reference.startsWith('env:') ? reference : 'local', unavailable: true }; }
  }
  async get(reference: string) {
    if (!reference) return undefined;
    if (reference.startsWith('env:')) return process.env[reference.slice(4)];
    invariant(/^[\w.-]{1,100}$/.test(reference), 'credential_name', '凭据引用无效。');
    let sealed: string;
    try {
      sealed = await readFile(join(this.root, reference + '.secret'), 'utf8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    }
    if (sealed.startsWith('dpapi:'))
      return Buffer.from(await this.dpapi(sealed.slice(6), true), 'base64').toString('utf8');
    const data = Buffer.from(sealed.slice(4), 'base64'),
      decipher = createDecipheriv('aes-256-gcm', await this.key(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
}
