import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, opendir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { invariant } from '../contracts/index.ts';
import { within } from './project-root.ts';

const filePath = z.string().min(1).max(900);
const MAX_TEXT_BYTES = 256 * 1024;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function readText(path: string) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    invariant(
      info.isFile() && info.size <= MAX_TEXT_BYTES && info.nlink === 1,
      'project_file',
      '请选择工作区内不超过 256 KiB 的普通文本文件。',
    );
    const buffer = Buffer.allocUnsafe(MAX_TEXT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    invariant(
      bytesRead <= MAX_TEXT_BYTES && !bytes.includes(0),
      'project_file',
      '文件不是可编辑的小型文本。',
    );
    return {
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      revision: hash(bytes),
    };
  } finally {
    await file.close();
  }
}

export function projectTools(root: string, writable: boolean) {
  const pathOf = (name: string) => {
    const parts = name.replaceAll('\\', '/').split('/');
    invariant(
      name === '.' ||
        parts.every(
          (part) =>
            part &&
            part !== '.' &&
            part !== '..' &&
            !part.endsWith('.') &&
            !part.endsWith(' ') &&
            part.toLowerCase() !== '.git' &&
            !/[:\x00-\x1f]/.test(part) &&
            !/^(CON|NUL|PRN|AUX|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
        ),
      'project_path',
      '请提供项目内的相对路径。',
    );
    return resolve(root, ...parts);
  };
  const existing = async (name: string) => {
    const path = pathOf(name);
    const actual = await realpath(path);
    invariant(
      within(root, actual) &&
        !actual
          .slice(root.length)
          .split(sep)
          .some((p) => p.toLowerCase() === '.git'),
      'project_path',
      '路径超出项目目录。',
    );
    return actual;
  };
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    work: (v: z.infer<T>, signal: AbortSignal) => Promise<unknown>,
  ): {
    name: string;
    label: string;
    description: string;
    parameters: object;
    execute: (
      id: string,
      args: unknown,
      signal: AbortSignal,
    ) => Promise<{ content: { type: 'text'; text: string }[] }>;
  } => ({
    name,
    label: description,
    description,
    parameters: z.toJSONSchema(schema),
    execute: async (_id: string, args: unknown, signal: AbortSignal) => ({
      content: [
        { type: 'text' as const, text: JSON.stringify(await work(schema.parse(args), signal)) },
      ],
    }),
  });
  const tools = [
    tool(
      'project_list',
      'List up to 150 direct children of a project directory. Use . for the root.',
      z.object({ path: filePath.default('.') }),
      async ({ path }, signal) => {
        const rows = [];
        const directory = await opendir(await existing(path));
        for await (const item of directory) {
          signal.throwIfAborted();
          if (item.name.toLowerCase() === '.git' || (!item.isDirectory() && !item.isFile()))
            continue;
          rows.push({ name: item.name, kind: item.isDirectory() ? 'directory' : 'file' });
          if (rows.length >= 150) break;
        }
        return rows.sort((a, b) => a.name.localeCompare(b.name));
      },
    ),
    tool(
      'project_read',
      'Read a bounded section of a UTF-8 project file and return its revision.',
      z.object({ path: filePath, offset: z.number().int().min(0).default(0) }),
      async ({ path, offset }, signal) => {
        const { text, revision } = await readText(await existing(path));
        signal.throwIfAborted();
        const end = Math.min(text.length, offset + 24000);
        return {
          text: text.slice(offset, end),
          revision,
          nextOffset: end < text.length ? end : null,
        };
      },
    ),
  ];
  if (writable)
    tools.push(
      tool(
        'project_create',
        'Create a new UTF-8 file in an existing project directory after user approval.',
        z.object({ path: filePath, text: z.string().max(12000) }),
        async ({ path, text }, signal) => {
          const destination = pathOf(path);
          const parent = await existing(relative(root, dirname(destination)) || '.');
          const file = join(parent, basename(destination));
          signal.throwIfAborted();
          await writeFile(file, text, { flag: 'wx' });
          return { revision: hash(text) };
        },
      ),
      tool(
        'project_replace',
        'Replace one exact text occurrence in a project file, with its current revision and user approval.',
        z.object({
          path: filePath,
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          before: z.string().min(1).max(6000),
          after: z.string().max(6000),
        }),
        async (v, signal) => {
          const path = await existing(v.path);
          invariant((await lstat(path)).isFile(), 'project_file', '只能编辑普通文件。');
          const { text, revision } = await readText(path);
          invariant(revision === v.revision, 'revision_conflict', '文件已变化，请重新读取。');
          const index = text.indexOf(v.before);
          invariant(
            index >= 0 && text.indexOf(v.before, index + 1) < 0,
            'project_match',
            '要替换的原文须精确匹配一次。',
          );
          const next = text.slice(0, index) + v.after + text.slice(index + v.before.length);
          invariant(
            Buffer.byteLength(next) <= MAX_TEXT_BYTES,
            'project_file',
            '编辑后的文件超过大小限制。',
          );
          const temp = join(dirname(path), '.echo-edit-' + randomUUID());
          try {
            await writeFile(temp, next, { flag: 'wx', mode: (await lstat(path)).mode });
            invariant(
              (await readText(path)).revision === revision,
              'revision_conflict',
              '文件已变化，请重新读取。',
            );
            signal.throwIfAborted();
            await rename(temp, path);
          } finally {
            await unlink(temp).catch(() => {});
          }
          return { revision: hash(next) };
        },
      ),
    );
  return tools;
}
