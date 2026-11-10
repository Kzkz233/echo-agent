import manifest from './echo-plugin.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Events } from '../../packages/kernel/events.ts';
import { defineManifest, type Plugin, type PluginContext } from '../../packages/kernel/registry.ts';
import { operations } from '../shared.ts';
const prepared = z.object({
  title: z.string().min(1).max(200),
  details: z.array(z.object({ label: z.string().max(160), value: z.string().max(100000) })).max(30),
  frozen: z.unknown(),
});
export type Approval = {
  id: string;
  executor: string;
  payloadHash: string;
  title: string;
  details: { label: string; value: string }[];
  frozen: unknown;
  state: 'pending' | 'rejected' | 'executing' | 'succeeded' | 'failed' | 'unknown';
  revision: number;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  receipt?: unknown;
  error?: string;
};
export class Approvals {
  private ctx?: PluginContext;
  constructor(
    readonly store: Store,
    readonly events: Events,
  ) {
    for (const r of store.documents<Approval>('approvals'))
      if (r.state === 'executing')
        store.put('approvals', r.id, {
          ...r,
          state: 'unknown',
          error: '进程在执行期间结束，未重放。',
        });
  }
  private save(r: Approval) {
    this.store.put('approvals', r.id, r);
    this.events.emit('approvals.updated', { id: r.id, state: r.state });
    return r;
  }
  async request(
    executor: string,
    payload: unknown,
    requestId: string,
    signal: AbortSignal,
    submittedBy?: string,
  ) {
    invariant(this.ctx, 'plugin_disabled', '审批插件未启用');
    const payloadHash = createHash('sha256')
        .update(
          JSON.stringify(submittedBy ? [executor, payload, submittedBy] : [executor, payload]),
        )
        .digest('hex'),
      old = this.store.document<Approval>('approvals', requestId);
    if (old) {
      invariant(
        old.payloadHash === payloadHash,
        'idempotency_conflict',
        '同一审批编号对应了不同内容',
      );
      return old;
    }
    const p = prepared.parse(
      await this.ctx.capabilities.invoke(
        'approvals.prepare@1',
        executor,
        { payload, submittedBy },
        signal,
      ),
    );
    signal.throwIfAborted();
    const current = this.store.document<Approval>('approvals', requestId);
    if (current) {
      invariant(current.payloadHash === payloadHash, 'idempotency_conflict', '审批编号冲突');
      return current;
    }
    return this.save({
      id: requestId,
      executor,
      payloadHash,
      ...p,
      state: 'pending',
      revision: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
  }
  async decide(
    requestId: string,
    revision: number,
    decision: 'approve' | 'reject',
    signal: AbortSignal,
  ) {
    invariant(this.ctx, 'plugin_disabled', '审批插件未启用');
    let r = this.store.document<Approval>('approvals', requestId);
    invariant(r, 'approval_missing', '审批不存在');
    if (r.state !== 'pending') return r;
    invariant(r.revision === revision, 'revision_conflict', '审批已变化，请重新核对');
    invariant(Date.parse(r.expiresAt) > Date.now(), 'approval_expired', '审批已过期，请重新准备');
    if (decision === 'reject')
      return this.save({
        ...r,
        state: 'rejected',
        revision: r.revision + 1,
        decidedAt: new Date().toISOString(),
      });
    invariant(
      this.ctx.capabilities
        .list('approvals.execute@1')
        .some((p) => p.id === r!.executor && p.state === 'active'),
      'executor_missing',
      '执行插件暂不可用，审批保持待处理',
    );
    r = this.save({
      ...r,
      state: 'executing',
      revision: r.revision + 1,
      decidedAt: new Date().toISOString(),
    });
    try {
      const result = (await this.ctx.capabilities.invoke(
        'approvals.execute@1',
        r.executor,
        { frozen: r.frozen, approvalId: r.id },
        signal,
      )) as { state: 'succeeded' | 'failed' | 'unknown'; receipt?: unknown };
      return this.save({ ...r, ...result, revision: r.revision + 1 });
    } catch {
      return this.save({
        ...r,
        state: 'unknown',
        revision: r.revision + 1,
        error: '没有取得确定执行回执；先核对，不会自动重放。',
      });
    }
  }
  async inspect(requestId: string, signal: AbortSignal) {
    invariant(this.ctx, 'plugin_disabled', '审批插件未启用');
    const r = this.store.document<Approval>('approvals', requestId);
    invariant(r?.state === 'unknown', 'approval_state', '只有未知结果需要核对');
    const result = (await this.ctx.capabilities.invoke(
      'approvals.inspect@1',
      r.executor,
      { frozen: r.frozen, approvalId: r.id },
      signal,
    )) as { state: 'succeeded' | 'failed' | 'unknown'; receipt?: unknown };
    return this.save({ ...r, ...result, revision: r.revision + 1 });
  }
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      activate: (ctx) => {
        this.ctx = ctx;
        ctx.dispose(() => {
          this.ctx = undefined;
        });
        ctx.capabilities.define({
          id: 'approvals.prepare@1',
          description: '执行方验证参数并生成供人核对的冻结操作',
          input: z.object({ payload: z.unknown(), submittedBy: z.string().optional() }),
          output: prepared,
          providePermission: 'approvals.contribute',
          consumePermission: 'approvals.execute',
          cardinality: 'one',
        });
        for (const point of ['execute', 'inspect'])
          ctx.capabilities.define({
            id: `approvals.${point}@1`,
            description:
              point === 'execute' ? '仅由已批准的冻结操作调用' : '只核对外部结果，不执行原操作',
            input: z.object({ frozen: z.unknown(), approvalId: id }),
            output: z.object({
              state: z.enum(['succeeded', 'failed', 'unknown']),
              receipt: z.unknown().optional(),
            }),
            providePermission: 'approvals.contribute',
            consumePermission: 'approvals.execute',
            cardinality: 'one',
          });
        const op = operations(ctx, 'approvals');
        op(
          'list',
          '列出审批摘要',
          z.object({
            offset: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(100).default(30),
          }),
          'approvals.read',
          (v) => {
            const all = this.store
              .documents<Approval>('approvals')
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            return {
              items: all
                .slice(v.offset, v.offset + v.limit)
                .map(({ details, frozen, ...r }) => ({ ...r, fieldCount: details.length })),
              total: all.length,
            };
          },
        );
        op('get', '读取完整待审内容', z.object({ id }), 'approvals.read', (v) =>
          this.store.document('approvals', v.id),
        );
        op(
          'request',
          '提出操作供前端审批',
          z.object({ executor: z.string(), payload: z.unknown(), requestId: id }),
          'approvals.request',
          (v, s) => this.request(v.executor, v.payload, v.requestId, s),
        );
        ctx.registry.register({
          name: 'approvals.decide',
          owner: 'approvals',
          description: '在前端核对完整操作后批准或拒绝',
          permission: 'approvals.decide',
          mcp: false,
          input: z.object({
            id,
            revision: z.number().int().min(1),
            decision: z.enum(['approve', 'reject']),
            confirmed: z.literal(true),
          }),
          output: z.unknown(),
          run: (v, c, s) => {
            invariant(c.kind === 'ui', 'approval_actor', '审批决定必须来自前端');
            return this.decide(v.id, v.revision, v.decision, s);
          },
        });
        op(
          'inspect',
          '核对未知执行的公开回执',
          z.object({ id }),
          'approvals.read',
          (v, s) => this.inspect(v.id, s),
          false,
        );
      },
    };
  }
}
