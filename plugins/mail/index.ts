import { characterEnabled, characterFeature } from '../../packages/kernel/characters.ts';
import { Events } from '../../packages/kernel/events.ts';
import packageManifest from './echo-plugin.json' with { type: 'json' };
import { defineManifest } from '../../packages/kernel/registry.ts';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { id, invariant, SafeTaskFailure } from '../../packages/contracts/index.ts';
import { Store } from '../../packages/kernel/store.ts';
import { Secrets } from '../../packages/kernel/secrets.ts';
import { MaterialSources } from '../../packages/kernel/materials.ts';
import type { Plugin } from '../../packages/kernel/registry.ts';
import { operations } from '../shared.ts';
import { mailProviders, inferMailProvider } from './providers.ts';
import { mailProxy } from './network.ts';
import { arrivalsContract, recordArrival, trimArrivals } from './arrivals.ts';
import { mailAccounts, mailCallerAccounts, mailGrants, requireMailbox } from './access.ts';
const server = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(true),
});
export const accountSchema = z.object({
  provider: z.enum(['qq', 'gmail', 'institution', 'custom']).default('custom'),
  network: z.enum(['direct', 'environment-proxy']).default('direct'),
  id,
  personaId: id.optional(),
  name: z.string().min(1),
  user: z.string().min(1),
  passwordRef: z.string().min(1),
  from: z.string().email(),
  mailbox: z.string().default('INBOX'),
  syncSent: z.boolean().optional(),
  imap: server,
  smtp: server,
});
type Account = z.infer<typeof accountSchema>;
type Mail = {
  id: string;
  accountId: string;
  personaId?: string;
  mailbox: string;
  uid: number;
  validity: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  seenAt: string;
  size: number;
  text?: string;
  attachments?: { name: string; bytes: number; type: string }[];
  flags?: string[];
  removedAt?: string;
};
const draftSchema = z.object({
  id: id.optional(),
  accountId: id,
  to: z.array(z.string().email()).min(1).max(20),
  subject: z.string().max(500),
  text: z.string().max(100000),
  revision: z.number().int().min(0).default(0),
});
type Draft = z.infer<typeof draftSchema> & {
  id: string;
  revision: number;
  hash: string;
  state: 'draft' | 'sending' | 'sent' | 'unknown';
  messageId?: string;
};
const local = (host: string) => ['127.0.0.1', 'localhost', '::1'].includes(host);
const mailConfigSchema = z.object({
  syncSent: z.boolean().default(true),
  reviewLookbackDays: z.number().int().min(1).max(3650).default(7),
});
export class Mailbox {
  private clients = new Set<any>();
  private syncing = new Set<string>();
  constructor(
    readonly store: Store,
    readonly secrets: Secrets,
    readonly materials: MaterialSources,
    readonly events?: Events,
  ) {
    for (const d of store.documents<Draft>('mail-drafts'))
      if (d.state === 'sending') store.put('mail-drafts', d.id, { ...d, state: 'unknown' });
  }
  config() {
    return mailConfigSchema.parse(this.store.get('mail.config', {}));
  }
  private account(id: string) {
    const a = this.store.document<Account>('mail-accounts', id);
    invariant(a, 'account_missing', '邮件账户不存在');
    return a;
  }
  private async connect(a: Account, signal: AbortSignal) {
    signal.throwIfAborted();
    const { ImapFlow } = await import('imapflow');
    const pass = await this.secrets.get(a.passwordRef);
    invariant(pass, 'mail_credential', '请先保存此账户的凭据');
    const client = new ImapFlow({
      ...a.imap,
      proxy: mailProxy(a.network, a.imap.host),
      auth: { user: a.user, pass },
      doSTARTTLS: !a.imap.secure && !local(a.imap.host) ? true : undefined,
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 30000,
      socketTimeout: 30000,
    });
    client.on('error', () => {});
    const abort = () => client.close();
    this.clients.add(client);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect();
      return {
        client,
        close: async () => {
          signal.removeEventListener('abort', abort);
          this.clients.delete(client);
          await client.logout().catch(() => client.close());
        },
      };
    } catch (e) {
      signal.removeEventListener('abort', abort);
      this.clients.delete(client);
      client.close();
      throw e;
    }
  }
  async sync(accountId: string, signal: AbortSignal, history = false, mailbox?: string) {
    invariant(!this.syncing.has(accountId), 'mail_busy', '此账户正在同步');
    const original = this.account(accountId),
      a = { ...original, mailbox: mailbox ?? original.mailbox };
    this.syncing.add(accountId);
    this.store.put('mail-status', accountId, {
      state: 'running',
      phase: 'connecting',
      startedAt: new Date().toISOString(),
      mailbox: a.mailbox,
    });
    let connection: Awaited<ReturnType<Mailbox['connect']>> | undefined;
    try {
      connection = await this.connect(a, signal);
      this.store.put('mail-status', accountId, {
        state: 'running',
        phase: 'headers',
        mailbox: a.mailbox,
      });
      const c = connection.client,
        lock = await c.getMailboxLock(a.mailbox);
      try {
        invariant(c.mailbox, 'mailbox_missing', '邮箱未打开');
        const validity = String(c.mailbox.uidValidity),
          key = `mail.watermark.${a.id}.${a.mailbox}.${validity}`,
          historyKey = `mail.historyBefore.${a.id}.${a.mailbox}.${validity}`,
          last = this.store.get<number>(key, 0),
          before = this.store.get<number>(historyKey, last ? 1 : Infinity);
        const baselineKey = `mail.arrivalBaseline.${a.id}.${a.mailbox}.${validity}`;
        const hasBaseline = this.store.get<boolean>(baselineKey, false);
        if (history && before <= 1) {
          this.store.put('mail-status', accountId, {
            state: 'succeeded',
            mailbox: a.mailbox,
            count: 0,
            finishedAt: new Date().toISOString(),
          });
          return { count: 0, remaining: false };
        }
        const range = history
          ? Number.isFinite(before)
            ? `1:${before - 1}`
            : '1:*'
          : `${last + 1}:*`;
        const remote = [
          ...new Set((await c.search({ uid: range }, { uid: true })) as number[]),
        ].filter((n) => (history ? n > 0 && n < before : n > last));
        const cached = new Set(
          this.store
            .documents<Mail>('mail')
            .filter(
              (m) => m.accountId === a.id && m.mailbox === a.mailbox && m.validity === validity,
            )
            .map((m) => m.uid),
        );
        const pending = remote.filter((n) => !cached.has(n)).sort((x, y) => x - y);
        const ids = pending.slice(-200);
        if (!history && pending.length > ids.length)
          this.store.set(historyKey, Math.max(this.store.get<number>(historyKey, 1), ids[0]));
        if (history) ids.reverse();
        let count = 0;
        for (const uid of ids) {
          signal.throwIfAborted();
          const m = await c.fetchOne(
            uid,
            { uid: true, envelope: true, size: true, flags: true },
            { uid: true },
          );
          if (!m) continue;
          const env = m.envelope ?? {},
            row: Mail = {
              id: createHash('sha256')
                .update([a.id, a.mailbox, validity, uid].join('\0'))
                .digest('hex'),
              accountId: a.id,
              personaId: a.personaId,
              mailbox: a.mailbox,
              uid,
              validity,
              subject: env.subject ?? '',
              from: (env.from ?? []).map((x: any) => x.address).join(', '),
              to: (env.to ?? []).map((x: any) => x.address).join(', '),
              date:
                env.date && Number.isFinite(new Date(env.date).getTime())
                  ? new Date(env.date).toISOString()
                  : new Date().toISOString(),
              seenAt: new Date().toISOString(),
              size: m.size ?? 0,
              flags: [...(m.flags ?? [])],
            };
          this.store.transaction(() => {
            const old = this.store.document<Mail>('mail', row.id);
            this.store.put('mail', row.id, { ...old, ...row });
            if (!history && hasBaseline && !old) recordArrival(this.store, row);
            if (!history) this.store.set(key, Math.max(this.store.get<number>(key, 0), uid));
          });
          count++;
        }
        if (history) this.store.set(historyKey, ids.length ? Math.min(...ids) : 1);
        else
          this.store.set(
            key,
            remote.reduce((maximum, uid) => Math.max(maximum, uid), last),
          );
        if (!history) this.store.set(baselineKey, true);
        trimArrivals(this.store);
        this.store.put('mail-status', accountId, {
          state: 'succeeded',
          mailbox: a.mailbox,
          count,
          finishedAt: new Date().toISOString(),
        });
        return { count, remaining: this.store.get<number>(historyKey, 1) > 1 };
      } finally {
        lock.release();
      }
    } catch (error: any) {
      this.store.put('mail-status', accountId, {
        state: 'failed',
        mailbox: a.mailbox,
        code: String(error.authenticationFailed ? 'authentication' : (error.code ?? 'imap_read')),
        message: error.authenticationFailed
          ? '认证失败，请核对授权码与服务开关'
          : '读取未完成，已保留同步进度',
        finishedAt: new Date().toISOString(),
      });
      // IMAP metadata fetches do not mutate the mailbox. Completed local UID
      // checkpoints are idempotent, so a future scheduled slot may resume safely.
      throw new SafeTaskFailure(
        'mail_sync_incomplete',
        'IMAP 同步未完成；已保留进度，下个周期可继续。',
      );
    } finally {
      await connection?.close();
      this.syncing.delete(accountId);
      this.events?.emit('mail.updated', { accountId });
    }
  }
  async syncAccount(accountId: string, signal: AbortSignal) {
    try {
      this.store.put('mail-status', accountId, {
        state: 'running',
        phase: 'folders',
        startedAt: new Date().toISOString(),
      });
      const folders = await this.folders(accountId, signal),
        a = this.account(accountId),
        sent = folders.find((f: any) => f.specialUse === '\\Sent');
      const paths = [
        ...new Set([
          a.mailbox,
          ...((a.syncSent ?? this.config().syncSent) && sent ? [sent.path] : []),
        ]),
      ];
      const results = [];
      for (const mailbox of paths) {
        signal.throwIfAborted();
        results.push({ mailbox, ...(await this.sync(accountId, signal, false, mailbox)) });
      }
      return { count: results.reduce((n, r) => n + r.count, 0), folders: results };
    } catch (error: any) {
      if (error instanceof SafeTaskFailure) throw error;
      this.store.put('mail-status', accountId, {
        state: 'failed',
        phase: 'folders',
        code: String(error?.authenticationFailed ? 'authentication' : (error?.code ?? 'imap_read')),
        message: error?.authenticationFailed
          ? '认证失败，请核对授权码与服务开关'
          : '读取未完成，已保留同步进度',
        finishedAt: new Date().toISOString(),
      });
      // Folder discovery and cancellation between folders are read-only too.
      // A future slot may resume; the current receipt must never be replayed.
      throw new SafeTaskFailure(
        'mail_sync_incomplete',
        'IMAP 同步未完成；已保留进度，下个周期可继续。',
      );
    } finally {
      this.events?.emit('mail.updated', { accountId });
    }
  }
  async read(id: string, signal: AbortSignal) {
    const row = this.store.document<Mail>('mail', id);
    invariant(row, 'mail_missing', '邮件不存在');
    if (row.text !== undefined) return row;
    invariant(row.size <= 5000000, 'mail_size', '正文按需读取上限5MB');
    const a = this.account(row.accountId),
      connection = await this.connect(a, signal);
    try {
      const c = connection.client,
        lock = await c.getMailboxLock(row.mailbox);
      try {
        invariant(
          c.mailbox && String(c.mailbox.uidValidity) === row.validity,
          'mail_epoch',
          '邮箱UID版本已变化，请重新同步',
        );
        const m = await c.fetchOne(row.uid, { source: true }, { uid: true });
        invariant(m && m.source && m.source.length <= 5000000, 'mail_size', '正文不可用或超过5MB');
        const { simpleParser } = await import('mailparser');
        const parsed = await simpleParser(m.source, {
          skipHtmlToText: false,
          skipTextToHtml: true,
        });
        signal.throwIfAborted();
        const updated = {
          ...row,
          seenAt: new Date(Math.max(Date.now(), Date.parse(row.seenAt) + 1)).toISOString(),
          text: String(parsed.text ?? ''),
          attachments: (parsed.attachments ?? []).map((f: any) => ({
            name: f.filename ?? '',
            bytes: f.size,
            type: f.contentType,
          })),
        };
        this.store.put('mail', id, updated);
        this.events?.emit('mail.updated', { accountId: row.accountId });
        return updated;
      } finally {
        lock.release();
      }
    } finally {
      await connection.close();
    }
  }

  async folders(accountId: string, signal: AbortSignal) {
    const a = this.account(accountId),
      connection = await this.connect(a, signal);
    try {
      const folders = (await connection.client.list())
        .filter((f: any) => !f.flags?.has('\\Noselect'))
        .map((f: any) => ({
          path: f.path,
          name: f.name,
          specialUse: f.specialUse ?? '',
          delimiter: f.delimiter,
        }));
      this.store.put('mail-folders', accountId, {
        id: accountId,
        items: folders,
        updatedAt: new Date().toISOString(),
      });
      return folders;
    } finally {
      await connection.close();
    }
  }
  async testAccount(accountId: string, signal: AbortSignal) {
    const a = this.account(accountId),
      started = Date.now();
    const folders = await this.folders(accountId, signal);
    const { default: nodemailer } = await import('nodemailer'),
      pass = await this.secrets.get(a.passwordRef);
    const transport = nodemailer.createTransport({
      ...a.smtp,
      proxy: mailProxy(a.network, a.smtp.host),
      requireTLS: !a.smtp.secure && !local(a.smtp.host),
      auth: { user: a.user, pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
      logger: false,
    });
    const abort = () => transport.close();
    this.clients.add(transport);
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await transport.verify();
      signal.throwIfAborted();
      return { imap: true, smtp: true, folders, elapsedMs: Date.now() - started };
    } finally {
      signal.removeEventListener('abort', abort);
      this.clients.delete(transport);
      transport.close();
    }
  }
  validateAccount(value: Account) {
    const old = this.store.document<Account>('mail-accounts', value.id);
    if (old && this.store.documents<Mail>('mail').some((m) => m.accountId === value.id))
      invariant(
        JSON.stringify([old.imap, old.user, old.mailbox]) ===
          JSON.stringify([value.imap, value.user, value.mailbox]),
        'mail_identity',
        '已有同步数据的 IMAP 身份不能原地替换，请新增账户',
      );
    return value;
  }
  /** A frozen single-message action. Never reconnect/replay after a mutating command. */
  async remoteAction(
    row: Mail,
    action: 'read' | 'unread' | 'move' | 'archive' | 'trash',
    target: string | undefined,
    signal: AbortSignal,
  ) {
    const connection = await this.connect(this.account(row.accountId), signal);
    let issued = false;
    try {
      const c = connection.client,
        lock = await c.getMailboxLock(row.mailbox);
      try {
        invariant(
          c.mailbox && String(c.mailbox.uidValidity) === row.validity,
          'mail_epoch',
          '邮箱 UID 版本已变化，请重新同步并审批',
        );
        const current = await c.fetchOne(row.uid, { uid: true, flags: true }, { uid: true });
        invariant(current, 'mail_missing', '远端邮件已不存在');
        signal.throwIfAborted();
        if (action === 'read' || action === 'unread') {
          issued = true;
          const ok =
            action === 'read'
              ? await c.messageFlagsAdd(row.uid, ['\\Seen'], { uid: true })
              : await c.messageFlagsRemove(row.uid, ['\\Seen'], { uid: true });
          invariant(ok !== false, 'mail_action', '服务器未确认标记操作');
          const flags = new Set<string>(current.flags ?? []);
          action === 'read' ? flags.add('\\Seen') : flags.delete('\\Seen');
          this.store.put('mail', row.id, {
            ...this.store.document<Mail>('mail', row.id),
            flags: [...flags],
          });
        } else {
          invariant(target && target !== row.mailbox, 'mail_target', '请选择其他目标文件夹');
          issued = true;
          const result = await c.messageMove(row.uid, target, { uid: true });
          invariant(result !== false, 'mail_action', '服务器未确认移动操作');
          this.store.put('mail', row.id, {
            ...this.store.document<Mail>('mail', row.id),
            removedAt: new Date().toISOString(),
          });
        }
        return { state: 'succeeded' as const, id: row.id, action, target };
      } finally {
        lock.release();
      }
    } catch (e: any) {
      return {
        state: issued ? ('unknown' as const) : ('failed' as const),
        id: row.id,
        code: e.code ?? 'mail_action',
        message: issued ? '没有取得确定回执，请在邮箱中核对；不会自动重放' : String(e.message),
      };
    } finally {
      await connection.close();
    }
  }
  draft(value: unknown) {
    const v = draftSchema.parse(value);
    this.account(v.accountId);
    const id = v.id ?? randomUUID(),
      old = this.store.document<Draft>('mail-drafts', id);
    invariant(!old || old.state === 'draft', 'draft_state', '已发送或未知草稿不能重新编辑投递');
    invariant((old?.revision ?? 0) === v.revision, 'revision_conflict', '草稿已变化');
    const hash = createHash('sha256')
      .update(JSON.stringify([v.accountId, v.to, v.subject, v.text]))
      .digest('hex');
    const d: Draft = { ...v, id, revision: v.revision + 1, hash, state: 'draft' };
    this.store.put('mail-drafts', id, d);
    this.events?.emit('mail.updated', {});
    return d;
  }
  async send(draftId: string, hash: string, signal: AbortSignal) {
    const d = this.store.document<Draft>('mail-drafts', draftId);
    invariant(
      d?.state === 'draft' && d.hash === hash,
      'draft_state',
      '草稿已变化或已尝试发送，请重新核对',
    );
    const a = this.account(d.accountId),
      pass = await this.secrets.get(a.passwordRef);
    invariant(pass, 'mail_credential', '凭据不存在');
    signal.throwIfAborted();
    const { default: nodemailer } = await import('nodemailer');
    const transport = nodemailer.createTransport({
      ...a.smtp,
      proxy: mailProxy(a.network, a.smtp.host),
      requireTLS: !a.smtp.secure && !local(a.smtp.host),
      auth: { user: a.user, pass },
      logger: false,
      debug: false,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 30000,
    });
    const abort = () => transport.close();
    this.clients.add(transport);
    signal.addEventListener('abort', abort, { once: true });
    const messageId = `<echo-${d.id}@localhost>`;
    this.store.transaction(() => {
      const current = this.store.document<Draft>('mail-drafts', d.id);
      invariant(
        current?.state === 'draft' && current.hash === hash,
        'draft_state',
        '草稿已被处理或发生变化',
      );
      this.store.put('mail-drafts', d.id, { ...d, state: 'sending', messageId });
    });
    try {
      const receipt = await transport.sendMail({
        from: a.from,
        to: d.to.join(', '),
        subject: d.subject,
        text: d.text,
        messageId,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      invariant(receipt.accepted?.length === d.to.length, 'mail_partial', '部分收件人未明确接受');
      this.store.put('mail-drafts', d.id, { ...d, state: 'sent', messageId });
      return { state: 'sent', messageId };
    } catch {
      this.store.put('mail-drafts', d.id, { ...d, state: 'unknown', messageId });
      return {
        state: 'unknown',
        messageId,
        message: '未取得完整发送回执，请核对已发送邮件；不会自动补发。',
      };
    } finally {
      signal.removeEventListener('abort', abort);
      this.clients.delete(transport);
      transport.close();
      this.events?.emit('mail.updated', {});
    }
  }
  plugin(): Plugin {
    const character = characterFeature(
      this.store,
      'mail',
      mailGrants,
      [{ key: 'accountIds', label: '可访问邮箱', type: 'multi', resource: 'mailAccount' }],
    );
    return {
      config: { schema: mailConfigSchema },
      manifest: defineManifest(packageManifest),
      character: {
        ...character,
        read: (personaId) => ({
          accountIds: mailAccounts(this.store, personaId).map((account) => account.id),
        }),
      },
      activate: (ctx) => {
        arrivalsContract(this.store, ctx);
        const op = operations(ctx, 'mail');
        op(
          'list',
          '账户、邮件与草稿',
          z.object({
            mailbox: z.string().optional(),
            query: z.string().default(''),
            accountId: id.optional(),
            limit: z.number().int().min(1).max(200).default(100),
            before: z.object({ date: z.string(), id }).optional(),
          }),
          'mail.read',
          (v, _s, caller) => {
            if (v.accountId) requireMailbox(this.store, caller, v.accountId);
            const allowed = new Set(
              mailCallerAccounts(this.store, caller).map((account) => account.id),
            );
            const found = this.store
              .documents<Mail>('mail')
              .filter(
                (m) =>
                  !m.removedAt &&
                  (caller.kind !== 'mcp' || allowed.has(m.accountId)) &&
                  (!v.mailbox || m.mailbox === v.mailbox) &&
                  (!v.accountId || m.accountId === v.accountId) &&
                  (!v.before ||
                    m.date < v.before.date ||
                    (m.date === v.before.date && m.id < v.before.id)),
              )
              .filter((m) =>
                (m.subject + ' ' + m.from + ' ' + (m.text ?? ''))
                  .toLowerCase()
                  .includes(v.query.toLowerCase()),
              )
              .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
            const page = found.slice(0, v.limit);
            const last = page.at(-1);
            return {
              accounts: this.store
                .documents<Account>('mail-accounts')
                .filter((a) => allowed.has(a.id))
                .map(({ passwordRef, ...a }) => ({
                  ...a,
                  ...(caller.kind === 'mcp' ? {} : { passwordRef }),
                  syncSent: a.syncSent ?? this.config().syncSent,
                  provider: a.provider ?? inferMailProvider(a.imap.host),
                  status: this.store.document('mail-status', a.id),
                  folders: this.store.document<any>('mail-folders', a.id)?.items ?? [],
                })),
              messages: page.map(({ text, attachments, ...header }) => ({
                ...header,
                bodyCached: text !== undefined,
                attachmentCount: attachments?.length ?? 0,
              })),
              drafts: this.store
                .documents<Draft>('mail-drafts')
                .filter((draft) => caller.kind !== 'mcp' || allowed.has(draft.accountId)),
              hasMore: found.length > v.limit,
              cursor: last ? { date: last.date, id: last.id } : undefined,
            };
          },
        );
        op(
          'sync',
          '增量同步最多200封元数据',
          z.object({ accountId: id, mailbox: z.string().optional() }),
          'mail.write',
          (v, s, caller) => {
            requireMailbox(this.store, caller, v.accountId);
            return v.mailbox
              ? this.sync(v.accountId, s, false, v.mailbox)
              : this.syncAccount(v.accountId, s);
          },
        );
        op(
          'backfill',
          '按需向前加载最多200封历史邮件元数据',
          z.object({ accountId: id, mailbox: z.string().optional() }),
          'mail.write',
          (v, s, caller) => {
            requireMailbox(this.store, caller, v.accountId);
            return this.sync(v.accountId, s, true, v.mailbox);
          },
        );
        op('providers', '邮箱接入方式', z.object({}), 'mail.read', () => mailProviders, false);
        op(
          'configure',
          '保存账户与受保护凭据',
          accountSchema.omit({ passwordRef: true }).extend({
            passwordRef: z.string().optional(),
            password: z.string().max(2000).optional(),
          }),
          'mail.write',
          async (v) => {
            const old = this.store.document<Account>('mail-accounts', v.id),
              { password, ...rest } = v;
            const next = accountSchema.parse({
              ...rest,
              personaId: rest.personaId ?? old?.personaId,
              passwordRef: password
                ? 'mail-' + v.id + '-' + randomUUID()
                : (old?.passwordRef ?? v.passwordRef),
            });
            this.validateAccount(next);
            if (password) await this.secrets.set(next.passwordRef, password);
            this.validateAccount(next);
            this.store.put('mail-accounts', next.id, next);
            return next;
          },
          false,
        );
        op(
          'folders',
          '发现邮件文件夹',
          z.object({ accountId: id }),
          'mail.read',
          (v, s) => this.folders(v.accountId, s),
          false,
        );
        op(
          'test',
          '验证 IMAP 与 SMTP 认证（不发送邮件）',
          z.object({ accountId: id }),
          'mail.read',
          (v, s) => this.testAccount(v.accountId, s),
          false,
        );
        op('read', '按需读取正文', z.object({ id }), 'mail.read', (v, s, caller) => {
          requireMailbox(this.store, caller, this.store.document<Mail>('mail', v.id)?.accountId);
          return this.read(v.id, s);
        });
        op('draft', '保存邮件草稿', draftSchema, 'mail.write', (v, _s, caller) => {
          requireMailbox(this.store, caller, v.accountId);
          if (v.id)
            requireMailbox(
              this.store,
              caller,
              this.store.document<Draft>('mail-drafts', v.id)?.accountId ?? v.accountId,
            );
          return this.draft(v);
        });
        this.materials.register(
          {
            id: 'mail',
            label: '已同步邮件（按角色）',
            streams: () =>
              this.store
                .documents<{ id: string }>('personas')
                .flatMap(({ id }) =>
                  characterEnabled(this.store, id, 'mail')
                    ? mailAccounts(this.store, id).map((account) => ({
                        id: account.id,
                        label: account.name,
                        personaId: id,
                      }))
                    : [],
                ),
            read: async (personaId, streams) => {
              if (!characterEnabled(this.store, personaId, 'mail')) return [];
              const accounts = new Set(
                mailAccounts(this.store, personaId)
                  .filter((account) => !streams || streams.includes(account.id))
                  .map((account) => account.id),
              );
              const cutoff = Date.now() - this.config().reviewLookbackDays * 86400000;
              return this.store
                .documents<Mail>('mail')
                .filter(
                  (m) =>
                    !m.removedAt &&
                    accounts.has(m.accountId) &&
                    (m.text !== undefined || Date.parse(m.date) >= cutoff),
                )
                .map((m) => ({
                  id: m.id + (m.text !== undefined ? '.body' : '.header'),
                  personaId,
                  streamId: m.accountId,
                  timestamp: m.seenAt,
                  text: `邮件：${m.subject}\n发件人：${m.from}\n${m.text ?? '（尚未读取正文）'}`,
                }));
            },
          },
          ctx.capabilities,
        );
        ctx.capabilities.provide(
          'scheduler.handlers@1',
          'mail.sync',
          '邮件增量同步',
          ({ input }, s) => this.syncAccount(z.object({ accountId: id }).parse(input).accountId, s),
        );
        ctx.dispose(() => {
          for (const c of this.clients) c.close();
          this.clients.clear();
        });
      },
    };
  }
}
