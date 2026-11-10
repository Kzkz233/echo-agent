import { z } from 'zod';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedProcess } from '../../packages/kernel/owned-process.ts';
import { invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Secrets } from '../../packages/kernel/secrets.ts';
import { workerTask } from '../../packages/kernel/worker-task.ts';
import type { ParsedDocument } from '../../packages/contracts/documents.ts';
export const documentConfig = z
  .object({
    endpoint: z.string().url().default('https://mineru.net'),
    apiKeyRef: z.string().default(''),
    version: z.enum(['pipeline', 'vlm']).default('vlm'),
    language: z.string().default('ch'),
    ocr: z.boolean().default(false),
    command: z.string().default(''),
    args: z.array(z.string()).default([]),
    tier: z.enum(['flash', 'basic', 'standard', 'advanced']).default('standard'),
    timeoutSeconds: z.number().int().min(10).max(1800).default(600),
  })
  .strict();
function safeUrl(raw: string) {
  const u = new URL(raw);
  invariant(
    u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)),
    'insecure_endpoint',
    '解析服务需要 HTTPS，本机地址可用 HTTP',
  );
  return u;
}
async function bounded(r: Response, limit: number) {
  invariant(r.ok, 'parser_http', `解析服务 HTTP ${r.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (r.body)
    for await (const c of r.body) {
      size += c.byteLength;
      invariant(size <= limit, 'parser_size', '解析结果超过大小上限');
      chunks.push(c);
    }
  return Buffer.concat(chunks);
}
export class Mineru {
  private jobs = new Map<string, Promise<any>>();
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly secrets: Secrets,
  ) {}
  async parse(v: any, signal: AbortSignal, local = false) {
    const cfg = documentConfig.parse(this.store.get('documents.config', {})),
      id = createHash('sha256')
        .update(JSON.stringify([local, v.requestId ?? [v.data, v.name, cfg]]))
        .digest('hex');
    invariant(!this.jobs.has(id), 'parser_busy', '同一文档仍在解析，请等待当前任务完成');
    const job = this.work(id, v, cfg, signal, local);
    this.jobs.set(id, job);
    try {
      return await job;
    } finally {
      this.jobs.delete(id);
    }
  }
  private async work(
    id: string,
    v: any,
    requested: z.infer<typeof documentConfig>,
    life: AbortSignal,
    local: boolean,
  ) {
    let job = this.store.document<any>('document-tasks', id);
    if (job) {
      invariant(
        job.inputHash === createHash('sha256').update(v.data).digest('hex'),
        'idempotency_conflict',
        '解析任务对应不同原件',
      );
    } else {
      job = {
        id,
        inputHash: createHash('sha256').update(v.data).digest('hex'),
        config: requested,
        local,
        state: 'new',
        createdAt: new Date().toISOString(),
      };
      this.store.put('document-tasks', id, job);
    }
    const cfg = documentConfig.parse(job.config),
      signal = AbortSignal.any([life, AbortSignal.timeout(cfg.timeoutSeconds * 1000)]),
      dir = join(dirname(this.store.path), 'documents', id),
      result = join(dir, 'result.zip');
    await mkdir(dir, { recursive: true });
    if (job.state === 'completed')
      return workerTask<ParsedDocument>(
        this.root,
        'document-result-worker',
        'plugins/documents/result-worker.ts',
        { data: (await readFile(result)).toString('base64') },
        signal,
      );
    if (local) {
      invariant(cfg.command, 'parser_runtime', '请选择已安装的 mineru-kit 可执行文件');
      const input = join(dir, 'input' + v.extension);
      await writeFile(input, Buffer.from(v.data, 'base64'));
      await ownedProcess(
        this.root,
        cfg.command,
        [
          ...cfg.args,
          'parse',
          input,
          '-o',
          result,
          '--format',
          'zip',
          '--pages',
          'all',
          '--tier',
          cfg.tier,
        ],
        signal,
        {
          MINERU_MODEL_SOURCE: 'local',
          MINERU_INTRA_OP_NUM_THREADS: '2',
          MINERU_INTER_OP_NUM_THREADS: '1',
        },
      );
    } else {
      const base = safeUrl(cfg.endpoint).toString().replace(/\/$/, ''),
        key = cfg.apiKeyRef ? await this.secrets.get(cfg.apiKeyRef) : '';
      invariant(key, 'parser_credentials', '请保存 MinerU API Token');
      const json = async (path: string, body?: unknown) => {
        const r = await fetch(base + path, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal,
        });
        const data = JSON.parse((await bounded(r, 2000000)).toString());
        invariant(data.code === 0, 'parser_api', 'MinerU 未接受该请求');
        return data.data;
      };
      invariant(
        !['submitting', 'unknown'].includes(job.state),
        'parser_unknown',
        '上次远程提交结果未知，未自动重复提交；请在 MinerU 核对后清除此任务',
      );
      if (job.state === 'new') {
        job.state = 'submitting';
        this.store.put('document-tasks', id, job);
        try {
          const data = await json('/api/v4/file-urls/batch', {
            files: [{ name: v.name, data_id: id, is_ocr: cfg.ocr }],
            model_version: cfg.version,
            language: cfg.language,
          });
          invariant(
            data?.batch_id && data.file_urls?.length === 1,
            'parser_output',
            'MinerU 上传凭据无效',
          );
          job = {
            ...job,
            state: 'allocated',
            batchId: data.batch_id,
            uploadUrl: data.file_urls[0],
          };
          this.store.put('document-tasks', id, job);
        } catch (e) {
          job.state = 'unknown';
          this.store.put('document-tasks', id, job);
          throw e;
        }
      }
      if (job.state === 'allocated') {
        // The same bytes PUT to the same reserved object is idempotent; never reserve a second job.
        const u = safeUrl(job.uploadUrl),
          r = await fetch(u, {
            method: 'PUT',
            body: Buffer.from(v.data, 'base64'),
            redirect: 'error',
            signal,
          });
        invariant(r.ok, 'parser_upload', `原件上传 HTTP ${r.status}`);
        job.state = 'uploaded';
        delete job.uploadUrl;
        this.store.put('document-tasks', id, job);
      }
      let url: string | undefined;
      while (!url) {
        signal.throwIfAborted();
        const data = await json('/api/v4/extract-results/batch/' + encodeURIComponent(job.batchId)),
          row =
            data.extract_result?.find((r: any) => r.data_id === id) ??
            (data.extract_result?.length === 1 ? data.extract_result[0] : undefined);
        invariant(row, 'parser_output', 'MinerU 任务回执无效');
        invariant(row.state !== 'failed', 'parser_failed', 'MinerU 文档解析失败');
        if (row.state === 'done') {
          url = row.full_zip_url;
          invariant(url, 'parser_output', 'MinerU 缺少结果文件');
          break;
        }
        await delay(2000, undefined, { signal });
      }
      const r = await fetch(safeUrl(url!), { redirect: 'error', signal });
      await writeFile(result, await bounded(r, 64000000));
    }
    const parsed = await workerTask<ParsedDocument>(
      this.root,
      'document-result-worker',
      'plugins/documents/result-worker.ts',
      { data: (await readFile(result)).toString('base64') },
      signal,
    );
    signal.throwIfAborted();
    job.state = 'completed';
    job.completedAt = new Date().toISOString();
    this.store.put('document-tasks', id, job);
    return parsed;
  }
}
