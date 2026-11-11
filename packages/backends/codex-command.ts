import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, dirname, join } from 'node:path';
import { EchoError } from '../contracts/index.ts';

const execute = promisify(execFile);
const executable = async (path: string) => {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};
async function installedStoreRoots(env: NodeJS.ProcessEnv) {
  if (!env.SystemRoot) return [];
  try {
    const result = await execute(
      join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation',
      ],
      { env, windowsHide: true, timeout: 10000, maxBuffer: 65536 },
    );
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve on each host start; never persist a versioned desktop/cache executable.
 * A user-specified path is respected, including its failure, without substitution. */
export async function resolveCodexCommand(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    storeRoots?: () => Promise<string[]>;
  } = {},
) {
  command = command.trim() || 'codex';
  if (!/^codex(?:\.exe)?$/i.test(command)) return { command, args };
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    const root = directory.replace(/^"|"$/g, '');
    const candidate = join(root, platform === 'win32' ? 'codex.exe' : 'codex');
    if (await executable(candidate)) return { command: candidate, args };
    if (platform === 'win32') {
      // npm's Windows shim is a batch file. Use its known JS launcher rather
      // than interpolating user arguments into cmd.exe / shell command text.
      const shim = join(root, 'codex.cmd');
      const script = join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if ((await executable(shim)) && (await executable(script)))
        return { command: process.execPath, args: [script, ...args] };
    }
  }
  if (platform === 'win32')
    for (const root of await (options.storeRoots ?? (() => installedStoreRoots(env)))()) {
      const candidate = join(root, 'app', 'resources', 'codex.exe');
      if (await executable(candidate)) return { command: candidate, args };
    }
  throw new EchoError(
    'codex_missing',
    '未找到 Codex。请安装 Codex CLI 或桌面版，或在高级启动设置中指定可执行程序。',
  );
}
