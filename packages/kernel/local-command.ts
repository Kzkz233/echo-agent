import { stat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, delimiter } from 'node:path';
export async function checkLocalCommand(command: string) {
  const candidates =
    isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? [command]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .flatMap((p) =>
            process.platform === 'win32' && !/\.[a-z]+$/i.test(command)
              ? ['.exe', '.cmd', '.bat'].map((e) => join(p, command + e))
              : [join(p, command)],
          );
  for (const path of candidates)
    try {
      const resolved = await realpath(path);
      if (!(await stat(resolved)).isFile()) continue;
      await access(resolved, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
      return { ok: true, verified: 'runtime-file', detail: '运行时文件可访问；尚未加载模型' };
    } catch {}
  return { ok: false, verified: 'runtime-file', detail: '运行时程序不存在或不可访问' };
}
