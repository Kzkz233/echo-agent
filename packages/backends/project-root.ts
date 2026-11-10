import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { invariant } from '../contracts/index.ts';

export function within(parent: string, child: string) {
  const path = relative(parent, child);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

export function projectRoot(value: string, dataRoot: string) {
  invariant(isAbsolute(value), 'project_path', '请选择一个项目目录的绝对路径。');
  const root = realpathSync(value);
  const privateRoot = realpathSync(dataRoot);
  invariant(
    statSync(root).isDirectory() && !within(root, privateRoot) && !within(privateRoot, root),
    'project_path',
    '项目目录须与 Echo 数据目录分开。',
  );
  return root;
}
