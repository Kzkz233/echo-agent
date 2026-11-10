import manifest from './echo-plugin.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, invariant } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { defineManifest, type Plugin } from '../../packages/kernel/registry.ts';
import { Mailbox } from '../mail/index.ts';
import { Approvals } from '../approvals/index.ts';
import { operations } from '../shared.ts';
import { requireMailbox } from '../mail/access.ts';
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const frozen = z.object({
  draftId: id,
  hash: z.string(),
  revision: z.number().int(),
  accountFingerprint: z.string(),
});
export class MailActions {
  constructor(
    readonly store: Store,
    readonly mail: Mailbox,
    readonly approvals: Approvals,
  ) {}
  plugin(): Plugin {
    return {
      manifest: defineManifest(manifest),
      activate: (ctx) => {
        ctx.capabilities.provide(
          'approvals.prepare@1',
          'mail-actions.send',
          'Send mail',
          ({ payload }) => {
            const { draftId } = z.object({ draftId: id }).parse(payload),
              draft = this.store.document<any>('mail-drafts', draftId);
            invariant(draft?.state === 'draft', 'draft_state', '草稿不处于可发送状态');
            const account = this.store.document<any>('mail-accounts', draft.accountId);
            invariant(account, 'account_missing', '账户不存在');
            return {
              title: 'Send mail',
              details: [
                { label: 'From', value: account.from },
                { label: 'To', value: draft.to.join(', ') },
                { label: 'Subject', value: draft.subject },
                { label: 'Body', value: draft.text },
              ],
              frozen: {
                draftId,
                hash: draft.hash,
                revision: draft.revision,
                accountFingerprint: fingerprint(account),
              },
            };
          },
        );
        ctx.capabilities.provide(
          'approvals.execute@1',
          'mail-actions.send',
          'Send mail',
          async (v, s) => {
            const f = frozen.parse(v.frozen),
              d = this.store.document<any>('mail-drafts', f.draftId);
            if (
              !d ||
              d.state !== 'draft' ||
              d.hash !== f.hash ||
              d.revision !== f.revision ||
              fingerprint(this.store.document('mail-accounts', d.accountId)) !==
                f.accountFingerprint
            )
              return { state: 'failed', receipt: { reason: '草稿或账户已变化，请重新准备审批' } };
            const r = await this.mail.send(f.draftId, f.hash, s);
            return { state: r.state === 'sent' ? 'succeeded' : 'unknown', receipt: r };
          },
        );
        ctx.capabilities.provide(
          'approvals.inspect@1',
          'mail-actions.send',
          'Inspect sent draft',
          (v) => {
            const f = frozen.parse(v.frozen),
              d = this.store.document<any>('mail-drafts', f.draftId);
            return {
              state: d?.state === 'sent' ? 'succeeded' : 'unknown',
              receipt: { draftId: f.draftId, state: d?.state, messageId: d?.messageId },
            };
          },
        );

        const batch = z.object({
          ids: z.array(id).min(1).max(20),
          action: z.enum(['read', 'unread', 'move', 'archive', 'trash']),
          target: z.string().optional(),
        });
        ctx.capabilities.provide(
          'approvals.prepare@1',
          'mail-actions.batch',
          'Organize mail',
          ({ payload }) => {
            const v = batch.parse(payload),
              items = [...new Set(v.ids)].map((id) => {
                const row = this.store.document<any>('mail', id);
                invariant(row && !row.removedAt, 'mail_missing', '邮件不在当前文件夹');
                const account = this.store.document<any>('mail-accounts', row.accountId);
                invariant(account, 'account_missing', '账户不存在');
                const folders = this.store.document<any>('mail-folders', account.id)?.items ?? [];
                const target =
                  v.action === 'archive' || v.action === 'trash'
                    ? folders.find(
                        (f: any) =>
                          f.specialUse === (v.action === 'archive' ? '\\Archive' : '\\Trash'),
                      )?.path
                    : v.target;
                if (['move', 'archive', 'trash'].includes(v.action))
                  invariant(
                    target && target !== row.mailbox && folders.some((f: any) => f.path === target),
                    'mail_target',
                    '先发现文件夹，再选择有效的目标；本操作不会永久删除邮件',
                  );
                const { text: _text, attachments: _attachments, ...snapshot } = row;
                return { row: snapshot, accountFingerprint: fingerprint(account), target };
              });
            return {
              title: 'Organize mail',
              details: [
                { label: 'Operation', value: v.action },
                ...items.map(({ row, target }) => ({
                  label: 'Message',
                  value: [
                    row.subject || '(No subject)',
                    row.from,
                    row.mailbox,
                    target ? '→ ' + target : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                })),
              ],
              frozen: { action: v.action, items },
            };
          },
        );
        ctx.capabilities.provide(
          'approvals.execute@1',
          'mail-actions.batch',
          'Organize mail',
          async (v, s) => {
            const f = z
              .object({
                action: batch.shape.action,
                items: z
                  .array(
                    z.object({
                      row: z.any(),
                      accountFingerprint: z.string(),
                      target: z.string().optional(),
                    }),
                  )
                  .min(1)
                  .max(20),
              })
              .parse(v.frozen);
            const results = [];
            for (const item of f.items) {
              const key = v.approvalId + '.' + item.row.id,
                prior = this.store.document<any>('mail-actions-receipts', key);
              if (prior) {
                results.push(prior.state === 'executing' ? { ...prior, state: 'unknown' } : prior);
                continue;
              }
              let result: any;
              const row = this.store.document<any>('mail', item.row.id);
              if (
                s.aborted ||
                !row ||
                row.removedAt ||
                row.validity !== item.row.validity ||
                row.uid !== item.row.uid ||
                row.mailbox !== item.row.mailbox ||
                fingerprint(this.store.document('mail-accounts', row.accountId)) !==
                  item.accountFingerprint
              )
                result = {
                  state: 'failed',
                  id: item.row.id,
                  message: '邮件、账户或执行条件已变化，请重新准备审批',
                };
              else {
                this.store.put('mail-actions-receipts', key, { state: 'executing', id: row.id });
                try {
                  result = await this.mail.remoteAction(row, f.action, item.target, s);
                } catch (e: any) {
                  result = {
                    state: 'failed',
                    id: row.id,
                    message: '未能连接邮件服务器，尚未提交操作',
                  };
                }
              }
              this.store.put('mail-actions-receipts', key, result);
              results.push(result);
            }
            return {
              state: results.some((r) => r.state === 'unknown')
                ? 'unknown'
                : results.every((r) => r.state === 'succeeded')
                  ? 'succeeded'
                  : 'failed',
              receipt: { items: results },
            };
          },
        );
        ctx.capabilities.provide(
          'approvals.inspect@1',
          'mail-actions.batch',
          'Inspect mail operations',
          (v) => {
            const f = z
              .object({ items: z.array(z.object({ row: z.object({ id }) })) })
              .parse(v.frozen);
            const items = f.items.map((i) => {
              const r = this.store.document<any>(
                'mail-actions-receipts',
                v.approvalId + '.' + i.row.id,
              );
              return !r || r.state === 'executing' ? { id: i.row.id, state: 'unknown' } : r;
            });
            return {
              state: items.some((r) => r.state === 'unknown')
                ? 'unknown'
                : items.every((r) => r.state === 'succeeded')
                  ? 'succeeded'
                  : 'failed',
              receipt: { items },
            };
          },
        );
        operations(ctx, 'mail-actions')(
          'organize',
          '提出标记、移动、归档或移至废纸篓审批',
          batch.extend({ requestId: id }),
          'mail-actions.write',
          (v, s, caller) => {
            for (const id of v.ids)
              requireMailbox(this.store, caller, this.store.document<any>('mail', id)?.accountId);
            return this.approvals.request(
              'mail-actions.batch',
              { ids: v.ids, action: v.action, target: v.target },
              v.requestId,
              s,
            );
          },
        );
        operations(ctx, 'mail-actions')(
          'propose',
          '将草稿提交到前端审批',
          z.object({ draftId: id }),
          'mail-actions.write',
          (v, s, caller) => {
            const d = this.store.document<any>('mail-drafts', v.draftId);
            invariant(d, 'draft_missing', '草稿不存在');
            requireMailbox(this.store, caller, d.accountId);
            return this.approvals.request('mail-actions.send', v, 'mail-' + d.id + '.' + d.hash, s);
          },
        );
      },
    };
  }
}
