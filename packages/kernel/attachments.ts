import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { invariant, type ModelInput } from '../contracts/index.ts';
import type { Attachment } from '../contracts/execution.ts';
import type { Store } from './store.ts';
import { within } from '../backends/project-root.ts';

export class Attachments {
  readonly root: string;
  constructor(readonly store: Store) {
    this.root = join(dirname(store.path), 'chat-attachments');
  }
  private path(id: string) {
    invariant(/^[a-f0-9]{64}$/.test(id), 'attachment_id', '附件编号无效。');
    return join(this.root, id);
  }
  async add(conversationId: string, name: string, mediaType: string, data: string) {
    invariant(this.store.conversation(conversationId), 'conversation_missing', '会话不存在。');
    const raw = Buffer.from(data, 'base64');
    invariant(
      raw.length > 0 && raw.length <= 8 * 1024 * 1024 && raw.toString('base64') === data,
      'attachment_size',
      '附件必须是有效编码且不超过 8 MB。',
    );
    let bytes = raw,
      kind: Attachment['kind'];
    if (mediaType.startsWith('image/')) {
      const { default: sharp } = await import('sharp');
      bytes = await sharp(raw, { limitInputPixels: 40000000 })
        .rotate()
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      mediaType = 'image/jpeg';
      kind = 'image';
    } else {
      invariant(
        raw.length <= 256 * 1024 && !raw.includes(0),
        'attachment_type',
        '目前可附加图片及不超过 256 KB 的 UTF-8 文本文件。其他文件请放入项目目录供代理读取。',
      );
      new TextDecoder('utf-8', { fatal: true }).decode(raw);
      mediaType = 'text/plain';
      kind = 'text';
    }
    const id = createHash('sha256')
      .update(conversationId + '\0')
      .update(bytes)
      .digest('hex');
    const saved: Attachment = {
      id,
      conversationId,
      name: basename(name).slice(0, 160),
      mediaType,
      bytes: bytes.length,
      kind,
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.root, { recursive: true });
    await writeFile(this.path(id), bytes);
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
      const bytes = await readFile(this.path(item.id));
      if (item.kind === 'image')
        images.push({ data: bytes.toString('base64'), mimeType: 'image/jpeg' });
      else texts.push('附件 ' + item.name + '（引用资料）\n' + bytes.toString('utf8'));
    }
    return { text: texts.join('\n\n'), ...(images.length ? { images } : {}) };
  }
  async projectFile(conversationId: string, path: string) {
    const configured = this.store.conversation(conversationId)?.permissions?.projectDirectory;
    invariant(configured, 'project_required', '请先为会话配置项目目录。');
    const root = await realpath(configured),
      actual = await realpath(path);
    invariant(within(root, actual), 'project_path', '请选择当前项目目录内的文件。');
    const info = await stat(actual);
    invariant(
      info.isFile() && info.size <= 256 * 1024,
      'attachment_size',
      '项目引用目前支持不超过 256 KB 的文本文件。',
    );
    return this.add(
      conversationId,
      basename(actual),
      'text/plain',
      (await readFile(actual)).toString('base64'),
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
