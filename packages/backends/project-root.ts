import { realpathSync, statSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
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

export async function ensureCharacterWorkspace(dataRoot: string, personaId: string) {
  const data = await realpath(dataRoot);
  invariant(dirname(data) !== data, 'project_path', '请选择一个独立的工作目录。');
  const workspaceRoot = data + '-workspaces';
  const workspace = join(workspaceRoot, 'role-' + personaId + '-files');
  invariant(dirname(workspace) === workspaceRoot, 'project_path', '默认工作目录无效。');
  for (const path of [workspaceRoot, workspace]) {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    invariant(await realpath(path) === path, 'project_path', '默认工作目录指向其他位置。');
  }
  return projectRoot(workspace, data);
}
