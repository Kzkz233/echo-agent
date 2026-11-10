import { realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { invariant, type GenerateRequest } from '../contracts/index.ts';
import { projectRoot, within } from './project-root.ts';
import { homedir } from 'node:os';

export const piNativeTools = [
  { name: 'read', description: 'Read project files and images', access: 'read' },
  { name: 'grep', description: 'Search project file contents', access: 'read' },
  { name: 'find', description: 'Find project files', access: 'read' },
  { name: 'ls', description: 'List project directories', access: 'read' },
  { name: 'edit', description: 'Edit exact text in project files', access: 'write' },
  { name: 'write', description: 'Write project files', access: 'write' },
  { name: process.platform === 'win32' ? 'powershell' : 'bash', description: 'Run an approved terminal command', access: 'terminal' },
] as const;

export function availablePiTools(permissions: GenerateRequest['permissions'], interactive = true) {
  const mode = permissions?.pi.tools ?? 'read';
  if (permissions?.pi.fullAccess) return piNativeTools.filter((tool) => tool.access === 'read' || interactive);
  if (mode === 'none' || !permissions?.projectDirectory) return [];
  return piNativeTools.filter((tool) => tool.access === 'read' ||
    (interactive && mode === 'ask' && permissions.pi.projectWrite &&
      (tool.access !== 'terminal' || permissions.pi.terminal)));
}

export async function nativePiTools(request: GenerateRequest, dataRoot: string) {
  const descriptors = request.toolPolicy === 'none' ? [] : availablePiTools(request.permissions, Boolean(request.onInteraction));
  if (!descriptors.length) return { tools: [], validate: async (_name: string, _args: any) => {} };
  const full = request.permissions?.pi.fullAccess === true;
  const root = full && !request.permissions?.projectDirectory
    ? await realpath(homedir()) : projectRoot(request.permissions!.projectDirectory, dataRoot);
  const readRoots=[root,...(request.permissions?.readRoots??[]).map((path)=>projectRoot(path,dataRoot)),...(request.permissions?.writeRoots??[]).map((path)=>projectRoot(path,dataRoot))];
  const writeRoots=[...(request.permissions?.primaryReadOnly ? [] : [root]),...(request.permissions?.writeRoots??[]).map((path)=>projectRoot(path,dataRoot))];
  const sdk = await import('@earendil-works/pi-coding-agent');
  const factories = { read: sdk.createReadTool, grep: sdk.createGrepTool,
    find: sdk.createFindTool, ls: sdk.createLsTool, edit: sdk.createEditTool,
    write: sdk.createWriteTool, bash: sdk.createBashTool,
    powershell: (directory: string) => sdk.createPowerShellTool(directory, { exposeSessionEnvironment: false }) };
  const tools = descriptors.map(({ name }) => factories[name](root));
  const validate = async (name: string, args: any) => {
    const descriptor = descriptors.find((tool) => tool.name === name);
    if (!descriptor || descriptor.access === 'terminal') return;
    const supplied = args?.path ?? '.';
    invariant(typeof supplied === 'string' && !/[\x00-\x1f]/.test(supplied) && !/^[@~]/.test(supplied), 'project_path', '请使用项目内的相对路径或绝对路径。');
    const target = isAbsolute(supplied) ? resolve(supplied) : resolve(root, supplied);
    const roots=descriptor.access==='write'?writeRoots:readRoots;
    invariant(full || (roots.some((base)=>within(base,target)) && !target.toLowerCase().split(/[\\/]/).includes('.git')),
      'project_path', '路径超出项目目录。');
    const actual = await realpath(target).catch(async (error) => {
      if (descriptor.access !== 'write' || error.code !== 'ENOENT') throw error;
      let parent = dirname(target);
      while (parent !== dirname(parent)) {
        try { return resolve(await realpath(parent), target.slice(parent.length + 1)); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent); }
      }
      throw error;
    });
    invariant(full || (roots.some((base)=>within(base,actual)) && !actual.toLowerCase().split(/[\\/]/).includes('.git')), 'project_path', '路径超出已授权目录。');
    const info = await lstat(actual).catch(() => undefined);
    invariant(full || !info?.isFile() || info.nlink === 1, 'project_path', '不能通过硬链接访问项目外的数据。');
    // Pi also expands @/~/Unicode paths. Execute the exact canonical path that
    // Echo checked, rather than interpreting the original path a second time.
    args.path = actual;
  };
  return { tools, validate };
}
