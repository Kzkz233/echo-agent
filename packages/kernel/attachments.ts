import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, basename, resolve, extname, relative } from 'node:path';
import { invariant, type ModelInput } from '../contracts/index.ts';
import type { Attachment } from '../contracts/execution.ts';
import type { Store } from './store.ts';
import { within } from '../backends/project-root.ts';

const maxBytes = 8 * 1024 * 1024;
function safeName(input: string) {
  const name = basename(input).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 140).replace(/[. ]+$/, '');
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? 'attachment-' + (name || 'file') : name;
}

async function matchingProjectFile(project: string, candidate: string | undefined, bytes: Buffer) {
  if (!candidate) return;
  const root = await realpath(project);
  invariant(!relative(project, root), 'project_path', '工作目录的位置已变化。');
  const actual = await realpath(candidate).catch(() => undefined);
  if (!actual || !within(root, actual)) return;
  const info = await stat(actual);
  if (info.isFile() && info.size === bytes.length && (await readFile(actual)).equals(bytes)) return actual;
}

export class Attachments {
  readonly root: string;
  constructor(readonly store: Store) {
    this.root = join(dirname(store.path), 'chat-attachments');
  }
  private path(id: string) {
    invariant(/^[a-f0-9]{64}$/.test(id), 'attachment_id', '附件编号无效。');
    return join(this.root, id);
  }
  async add(conversationId: string, name: string, mediaType: string, data: string, options: { original?: boolean; projectPath?: string; copyToProject?: boolean } = {}) {
    invariant(this.store.conversation(conversationId), 'conversation_missing', '会话不存在。');
    const raw = Buffer.from(data, 'base64');
    invariant(
      raw.length > 0 && raw.length <= 8 * 1024 * 1024 && raw.toString('base64') === data,
      'attachment_size',
      '附件必须是有效编码且不超过 8 MB。',
    );
    const bytes = raw;
    let kind: Attachment['kind'];
    if (!options.original && mediaType.startsWith('image/')) {
      const { default: sharp } = await import('sharp');
      await sharp(raw, { limitInputPixels: 40000000 }).resize(1, 1).toBuffer();
      kind = 'image';
    } else {
      kind = 'file';
      if (!options.original && raw.length <= 256 * 1024 && !raw.includes(0) && mediaType !== 'application/pdf' && !name.toLowerCase().endsWith('.pdf')) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(raw);
          kind = 'text';
          mediaType = 'text/plain';
        } catch { /* Binary documents stay available in their original format. */ }
      }
    }
    const id = createHash('sha256')
      .update(conversationId + '\0' + safeName(name) + '\0' + kind + '\0')
      .update(bytes)
      .digest('hex');
    const existing = this.store.document<Attachment>('chat-attachments', id);
    let projectPath = options.projectPath ?? existing?.projectPath;
    const project = this.store.conversation(conversationId)?.permissions?.projectDirectory;
    if (kind === 'file' && options.copyToProject && project) projectPath = await matchingProjectFile(project, projectPath, bytes);
    if (kind === 'file' && options.copyToProject && project && !projectPath) {
      const root = await realpath(project);
      invariant(!relative(project, root), 'project_path', '工作目录的位置已变化。');
      const dir = await mkdtemp(join(root, 'echo-input-'));
      projectPath = join(dir, safeName(name));
      await writeFile(projectPath, bytes, { flag: 'wx' });
    }
    const saved: Attachment = {
      id,
      conversationId,
      name: safeName(name),
      ...(projectPath ? { projectPath } : {}),
      mediaType,
      bytes: bytes.length,
      kind,
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.root, { recursive: true });
    if (!existing) {
      const temp = join(this.root, randomUUID() + '.tmp');
      try {
        await writeFile(temp, bytes, { flag: 'wx' });
        await rename(temp, this.path(id));
      } finally { await rm(temp, { force: true }); }
    }
    this.store.put('chat-attachments', id, saved);
    return saved;
  }
  metadata(ids: string[], conversationId: string) {
    invariant(ids.length <= 4, 'attachment_limit', '每条消息最多附加 4 个文件。');
    return ids.map((id) => {
      const item = this.store.document<Attachment>('chat-attachments', id);
      invariant(
        item?.conversationId === conversationId,
        'attachment_owner',
        '附件不属于当前会话。',
      );
      return item;
    });
  }
  async content(
    ids: string[],
    conversationId: string,
  ): Promise<Pick<ModelInput, 'text' | 'images'>> {
    const images: NonNullable<ModelInput['images']> = [],
      texts: string[] = [];
    for (const item of this.metadata(ids, conversationId)) {
      if (item.kind === 'file') {
        texts.push('文件附件 ' + JSON.stringify({ name: item.name, attachmentId: item.id, projectPath: item.projectPath }));
        continue;
      }
      const bytes = await readFile(this.path(item.id));
      texts.push('附件 ' + JSON.stringify({ name: item.name, attachmentId: item.id }));
      if (item.kind === 'image') {
        const { default: sharp } = await import('sharp');
        const preview = await sharp(bytes, { limitInputPixels: 40000000 }).rotate()
          .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        images.push({ data: preview.toString('base64'), mimeType: 'image/jpeg' });
      } else texts.push(bytes.toString('utf8'));
    }
    return { text: texts.join('\n\n'), ...(images.length ? { images } : {}) };
  }
  async prepareInputFiles(ids: string[], conversationId: string) {
    for (const file of this.metadata(ids, conversationId)) {
      if (file.kind !== 'file') continue;
      await this.add(conversationId, file.name, file.mediaType, (await readFile(this.path(file.id))).toString('base64'),
        { original: true, copyToProject: true });
    }
  }
  async shareInputs(ids: string[], parentId: string, workerId: string, writable: boolean) {
    const worker = this.store.conversation(workerId);
    const root = worker?.permissions?.projectDirectory;
    const result: string[] = [];
    for (const item of this.metadata(ids, parentId)) {
      const bytes = await readFile(this.path(item.id));
      const projectPath = item.kind === 'file' && root ? await matchingProjectFile(root, item.projectPath, bytes) : undefined;
      invariant(item.kind !== 'file' || projectPath || (root && writable), 'attachment_workspace', '此文件需要子任务可读的原件或已授权写入的工作目录。');
      const copy = await this.add(workerId, item.name, item.mediaType, bytes.toString('base64'),
        { original: item.kind === 'file', projectPath, copyToProject: writable });
      result.push(copy.id);
    }
    return result;
  }
  async reveal(conversationId: string, id: string) {
    invariant(process.platform === 'win32', 'platform', '文件位置仅在 Windows 桌面端可用。');
    const [item] = this.metadata([id], conversationId);
    const parent = join(dirname(this.root), 'exports', 'chat-files');
    await mkdir(parent, { recursive: true });
    const bytes = await readFile(this.path(id));
    let folder = join(parent, id);
    await mkdir(folder, { recursive: true });
    invariant(await realpath(folder) === folder, 'attachment_path', '附件导出目录的位置已变化。');
    let path = join(folder, safeName(item.name));
    try { await writeFile(path, bytes, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await realpath(path) !== path || (await stat(path)).size !== bytes.length || !(await readFile(path)).equals(bytes)) {
        folder = await mkdtemp(join(parent, 'file-'));
        path = join(folder, safeName(item.name));
        await writeFile(path, bytes, { flag: 'wx' });
      }
    }
    const explorer = execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [folder], { windowsHide: true });
    await new Promise<void>((resolve, reject) => { explorer.once('spawn', resolve); explorer.once('error', reject); });
    return { opened: true };
  }
  async download(conversationId: string, id: string) {
    const [item] = this.metadata([id], conversationId);
    return { name: item.name, data: (await readFile(this.path(id))).toString('base64') };
  }
  async projectFile(conversationId: string, path: string, original = false) {
    const configured = this.store.conversation(conversationId)?.permissions?.projectDirectory;
    invariant(configured, 'project_required', '请先为会话配置项目目录。');
    const root = await realpath(configured);
    invariant(!relative(configured, root), 'project_path', '工作目录的位置已变化。');
    const actual = await realpath(resolve(root, path));
    invariant(within(root, actual), 'project_path', '请选择当前项目目录内的文件。');
    const info = await stat(actual);
    invariant(
      info.isFile() && info.size > 0 && info.size <= maxBytes,
      'attachment_size',
      '单个项目附件须为非空文件且不超过 8 MB。',
    );
    return this.add(
      conversationId,
      basename(actual),
      extname(actual).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream',
      (await readFile(actual)).toString('base64'),
      { original, projectPath: actual },
    );
  }
  async cleanupOrphans() {
    for (const item of this.store.documents<Attachment>('chat-attachments'))
      if (!this.store.conversation(item.conversationId)) {
        try {
          await unlink(this.path(item.id));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        }
        this.store.remove('chat-attachments', item.id);
      }
  }
}
