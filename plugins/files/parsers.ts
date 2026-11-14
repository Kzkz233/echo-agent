import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invariant } from '../../packages/contracts/index.ts';
import {
  sourceReference,
  parserDescriptor,
  parsePlan,
  parsedContent,
  parserAccepts,
  type ParserDescriptor,
  type ParsePlan,
} from '../../packages/contracts/parsing.ts';
import type { PluginContext } from '../../packages/kernel/registry.ts';
import type { Files, FileRecord } from './index.ts';
import { mediaReference, mediaProcessor, mediaPlan } from '../../packages/contracts/ingestion.ts';
import { contentPart } from '../../packages/contracts/inference.ts';

export const textExtensions = [
  '.md',
  '.txt',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.log',
  '.html',
  '.htm',
  '.srt',
  '.vtt',
];
/** Catalog and execution share the same provider declarations. No provider-name routing. */
export class Parsers {
  private scope?: PluginContext['capabilities'];
  constructor(readonly files: Files) {}
  activate(ctx: PluginContext) {
    this.scope = ctx.capabilities;
    ctx.dispose(() => {
      this.scope = undefined;
    });
    ctx.capabilities.define({ id: 'files.media-inspect@1', description: 'Inspect a scoped archived media object without inference',
      input: z.object({ vaultId: z.string(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }),
      output: z.object({ duration: z.number().positive().max(86400), hasAudio: z.boolean().optional() }).nullable(),
      providePermission: 'knowledge.parse', consumePermission: 'files.read' });
    ctx.capabilities.define({ id: 'files.media-encode@1', description: 'Prepare one bounded native media fragment for embedding',
      input: mediaReference, output: contentPart, providePermission: 'knowledge.parse', consumePermission: 'files.read' });
    ctx.capabilities.define({ id: 'files.media-processors@1', description: 'Registered native media processors', input: z.object({}), output: mediaProcessor, providePermission: 'knowledge.parse', consumePermission: 'files.read' });
    ctx.capabilities.define({ id: 'files.prepare-media@1', description: 'Freeze processor-owned runtime options', input: z.object({}), output: z.record(z.string(), z.unknown()), providePermission: 'knowledge.parse', consumePermission: 'files.read' });
    ctx.capabilities.provide('files.media-processors@1', 'files.image', '图片', () => ({ id: 'files.image', label: '图片', version: '1', modalities: ['image'] }));
    ctx.capabilities.provide('files.prepare-media@1', 'files.image', '图片', () => ({}));
    ctx.capabilities.provide('files.media-encode@1', 'files.image', '图片', async (v, signal) => {
      invariant(v.modality === 'image', 'media_unsupported', '此提供方仅处理图片');
      const object = await this.files.mediaObject(v.vaultId, v.sourceHash);
      invariant(object.mediaType.startsWith('image/'), 'media_unsupported', '原件不是图片');
      const sharp = (await import('sharp')).default;
      const data = await sharp(object.path, { limitInputPixels: 64000000 }).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      signal.throwIfAborted();
      invariant(data.length <= 12000000, 'media_size', '图片编码超过模型输入上限');
      return { type: 'image' as const, mimeType: 'image/png', data: data.toString('base64') };
    });
    ctx.capabilities.define({
      id: 'files.parsers@1',
      description: 'Supported formats and limits of registered parsers',
      input: z.object({}),
      output: parserDescriptor,
      providePermission: 'knowledge.parse',
      consumePermission: 'files.read',
    });
    ctx.capabilities.define({
      id: 'files.prepare-parse@1',
      description: 'Freeze provider configuration before a durable parse job',
      input: sourceReference,
      output: z.record(z.string(), z.unknown()),
      providePermission: 'knowledge.parse',
      consumePermission: 'files.read',
    });
    ctx.capabilities.define({
      id: 'files.extract@3',
      description: 'Parse an immutable archived original using a frozen plan',
      input: sourceReference.extend({ plan: parsePlan }),
      output: parsedContent.nullable(),
      providePermission: 'knowledge.parse',
      consumePermission: 'files.read',
    });
    const descriptor: ParserDescriptor = {
      id: 'files.text',
      label: '文本与字幕',
      version: '1',
      contract: 'files.extract@3',
      extensions: textExtensions,
      maxBytes: 16000000,
    };
    ctx.capabilities.provide('files.parsers@1', 'files.text', descriptor.label, () => descriptor);
    const image: ParserDescriptor = { id: 'files.image', label: '原生图片', version: '1', contract: 'files.extract@3', extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'], maxBytes: 16000000 };
    ctx.capabilities.provide('files.parsers@1', image.id, image.label, () => image);
    ctx.capabilities.provide('files.extract@3', image.id, image.label, async v => {
      const source = await this.files.original(v.vaultId, v.fileId, v.sourceHash);
      invariant(parserAccepts(image, v.name, source.bytes), 'parser_unsupported', '图片格式或大小不受支持');
      return { text: '# ' + source.name + '\n\n![' + source.name.replace(/[\[\]]/g, '') + '](echo-asset:' + source.hash + ')' };
    });
    ctx.capabilities.provide(
      'files.extract@3',
      'files.text',
      descriptor.label,
      async (v, signal) => {
        const source = await this.files.original(v.vaultId, v.fileId, v.sourceHash);
        invariant(
          parserAccepts(descriptor, v.name, source.bytes),
          'parser_unsupported',
          '此解析器不支持该文件',
        );
        return { text: (await this.read(source, signal)).toString('utf8') };
      },
    );
  }
  async inspectMedia(vaultId: string, sourceHash: string, signal: AbortSignal, selected = '') {
    const providers = this.scope?.list('files.media-inspect@1').filter(p => p.state === 'active' && (!selected || p.id === selected)) ?? [];
    invariant(providers.length <= 1, 'media_provider_missing', '请在入库流程中选择可用的媒体处理提供方');
    const provider = providers[0];
    if (!provider) return null;
    return this.scope!.invoke('files.media-inspect@1', provider.id, { vaultId, sourceHash }, signal) as Promise<{ duration: number; hasAudio?: boolean } | null>;
  }
  async mediaProcessors() {
    const scope = this.scope; if (!scope) return [];
    return Promise.all(scope.list('files.media-processors@1').filter(p => p.state === 'active').map(async p => {
      const value = mediaProcessor.parse(await scope.invoke(p.point, p.id, {}));
      invariant(value.id === p.id, 'media_identity', '媒体处理声明与提供方不一致'); return value;
    }));
  }
  async freezeMedia(modality: 'image' | 'audio' | 'video', selected = '') {
    const compatible = (await this.mediaProcessors()).filter(p => p.modalities.includes(modality));
    const processor = selected ? compatible.find(p => p.id === selected) : compatible.length === 1 ? compatible[0] : undefined;
    invariant(processor, 'media_provider_missing', '请在入库流程中选择可用的媒体处理提供方');
    return mediaPlan.parse({ processor, options: await this.scope!.invoke('files.prepare-media@1', processor.id, {}) });
  }
  async encodeMedia(input: Omit<z.infer<typeof mediaReference>, 'options'>, signal: AbortSignal, frozen?: z.infer<typeof mediaPlan>) {
    const plan = frozen ?? await this.freezeMedia(input.modality);
    const processor = (await this.mediaProcessors()).find(p => p.id === plan.processor.id);
    invariant(processor?.version === plan.processor.version && processor.modalities.includes(input.modality), 'media_provider_changed', '媒体处理插件已变更，请重新预览迁移');
    return contentPart.parse(await this.scope!.invoke('files.media-encode@1', processor.id, { ...input, options: plan.options }, signal));
  }
  async list(signal?: AbortSignal) {
    const scope = this.scope;
    if (!scope) return [];
    const providers = scope.list().filter((p) => p.state === 'active');
    const declared = await Promise.all(
      providers
        .filter((p) => p.point === 'files.parsers@1')
        .map(async (p) => {
          const timeout = AbortSignal.timeout(5000);
          const descriptor = parserDescriptor.parse(
            await scope.invoke(
              p.point,
              p.id,
              {},
              signal ? AbortSignal.any([signal, timeout]) : timeout,
            ),
          );
          invariant(
            descriptor.id === p.id &&
              (!descriptor.prepare || descriptor.prepare.startsWith(p.owner + '.')),
            'parser_identity',
            '解析器声明必须属于提供插件',
          );
          return descriptor;
        })
        .map((task) => task.catch(() => null)),
    );
    const valid = declared.filter((d): d is ParserDescriptor => !!d);
    const result = valid.filter((d) =>
      providers.some((p) => p.point === d.contract && p.id === d.id),
    );
    // Older extensions remain usable under their original bounded contract. They
    // cannot silently become an automatic parser for undeclared formats.
    for (const p of providers.filter((p) =>
      ['files.extract@1', 'files.extract@2'].includes(p.point),
    ))
      if (!valid.some((d) => d.id === p.id))
        result.push({
          id: p.id,
          label: p.label,
          version: 'legacy',
          contract: p.point as ParserDescriptor['contract'],
          extensions: ['.legacy'],
          maxBytes: p.point === 'files.extract@1' ? 16000000 : 8 * 1024 ** 3,
        });
    return result;
  }
  async freeze(
    parser: ParserDescriptor,
    source: FileRecord,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ParsePlan> {
    const prepared = parser.prepare
      ? ((await this.scope!.invoke(
          'files.prepare-parse@1',
          parser.prepare,
          {
            vaultId: source.vaultId,
            fileId: source.id,
            sourceHash: source.hash,
            name: source.name,
            requestId,
          },
          signal,
        )) as Record<string, unknown>)
      : {};
    return parsePlan.parse({
      format: 'echo-parse-plan-v1',
      parser,
      options: prepared.options ?? prepared,
      provenance: prepared.provenance ?? {},
    });
  }
  async read(source: FileRecord, signal: AbortSignal) {
    const path = await this.files.path(source.vaultId, source.relativePath);
    invariant(source.bytes <= 16000000, 'parser_size', '此解析器支持的文件上限为16 MB');
    const bytes = await readFile(path, { signal });
    invariant(
      createHash('sha256').update(bytes).digest('hex') === source.hash,
      'source_changed',
      '归档原件校验失败',
    );
    return bytes;
  }
  async execute(plan: ParsePlan, source: FileRecord, requestId: string, signal: AbortSignal) {
    const scope = this.scope,
      d = plan.parser;
    invariant(scope, 'parser_missing', '知识解析已停止');
    invariant(
      scope?.list(d.contract).some((p) => p.id === d.id && p.state === 'active'),
      'parser_missing',
      '解析器已停用，请启用后继续',
    );
    const current = (await this.list(signal)).find((p) => p.id === d.id);
    invariant(
      current?.version === d.version,
      'parser_version',
      '解析器版本已变化，请新建重解析任务',
    );
    const ref = {
      vaultId: source.vaultId,
      fileId: source.id,
      sourceHash: source.hash,
      name: source.name,
      requestId,
    };
    if (d.contract === 'files.extract@3')
      return parsedContent
        .nullable()
        .parse(await scope.invoke(d.contract, d.id, { ...ref, plan }, signal));
    if (d.contract === 'files.extract@2')
      return parsedContent.nullable().parse(await scope.invoke(d.contract, d.id, ref, signal));
    const bytes = await this.read(source, signal);
    return parsedContent
      .nullable()
      .parse(
        await scope.invoke(
          d.contract,
          d.id,
          {
            extension: extname(source.name).toLowerCase(),
            name: source.name,
            data: bytes.toString('base64'),
            requestId,
          },
          signal,
        ),
      );
  }
}
