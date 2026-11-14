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
