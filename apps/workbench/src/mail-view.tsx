import { CredentialInput } from './credential-input.tsx';
import { t, locale, statusText } from './i18n.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from './client.ts';
import { mailProviders } from '../../../plugins/mail/providers.ts';
import { Button, EmptyState, Icon, sameData, requestNavigation, useUnsavedChanges } from './ui.tsx';
const date = (value: string) =>
  Number.isNaN(Date.parse(value))
    ? value
    : new Date(value).toLocaleString(locale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
export function MailView({ data, act, setPage }: any) {
  const [tab, setTab] = useState('inbox'),
    [rows, setRows] = useState<any>({ accounts: [], messages: [], drafts: [] }),
    [account, setAccount] = useState(''),
    [query, setQuery] = useState(''),
    [folder, setFolder] = useState(''),
    [checked, setChecked] = useState<string[]>([]),
    [moveTarget, setMoveTarget] = useState(''),
    [selected, setSelected] = useState<any>(),
    [loading, setLoading] = useState(true),
    [reading, setReading] = useState(false),
    [issue, setIssue] = useState(''),
    [editing, setEditing] = useState<any>(),
    [draft, setDraft] = useState<any>();
  const revision = useRef(0),
    readRevision = useRef(0),
    accountBaseline = useRef<any>(undefined),
    draftBaseline = useRef<any>(undefined);
  const accountDirty = Boolean(editing && !sameData(editing, accountBaseline.current));
  const draftDirty = Boolean(draft && !sameData(draft, draftBaseline.current));
  useUnsavedChanges(accountDirty || draftDirty, '邮件');
  const leave = (action: () => void) =>
    requestNavigation(() => {
      setEditing(undefined);
      setDraft(undefined);
      action();
    });
  const load = useCallback(
    async (more = false) => {
      const version = ++revision.current;
      setLoading(true);
      setIssue('');
      try {
        const result = await rpc('mail.list', {
          accountId: account || undefined,
          mailbox: folder || undefined,
          query,
          before: more ? rows.cursor : undefined,
        });
        if (version === revision.current)
          setRows((old: any) => ({
            ...result,
            messages: more ? [...old.messages, ...result.messages] : result.messages,
          }));
      } catch (e) {
        if (version === revision.current) setIssue((e as Error).message);
      } finally {
        if (version === revision.current) setLoading(false);
      }
    },
    [account, query, folder, rows.cursor],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void loadRef.current();
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      revision.current++;
    };
  }, [account, query, folder]);
  useEffect(() => {
    const listener = (event: any) => {
      if (['connection.ready', 'mail.updated'].includes(event.detail.type)) void loadRef.current();
    };
    window.addEventListener('echo-event', listener);
    return () => window.removeEventListener('echo-event', listener);
  }, []);
  const run = async (fn: () => Promise<any>, message: string) => {
    const result = await act(fn, message);
    if (result) await loadRef.current();
    return result;
  };
  const beginAccount = (value?: any) =>
    leave(() => {
      const initial = value
        ? { ...value }
        : {
            id: crypto.randomUUID(),
            provider: 'qq',
            name: '',
            user: '',
            from: '',
            mailbox: 'INBOX',
            syncSent: true,
            imap: { ...mailProviders[0].imap },
            smtp: { ...mailProviders[0].smtp },
          };
      accountBaseline.current = initial;
      setEditing(initial);
    });
  useEffect(() => {
    if (editing)
      document
        .querySelector('.account-editor')
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [Boolean(editing)]);
  const beginDraft = (value?: any) =>
    leave(() => {
      const initial = value
        ? { ...value, to: value.to.join(', ') }
        : { accountId: account || rows.accounts[0]?.id, to: '', subject: '', text: '' };
      draftBaseline.current = initial;
      setDraft(initial);
      setTab('drafts');
    });
  const field = (label: string, key: string, type = 'text', required = false) => (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type={type}
        required={required}
        value={editing?.[key] ?? ''}
        onChange={(e) => {
          const next = { ...editing, [key]: e.target.value };
          if (key === 'user' && (!editing.from || editing.from === editing.user))
            next.from = e.target.value;
          setEditing(next);
        }}
      />
    </label>
  );
  return (
    <div className="mail-page">
      <div className="page-title page-title-actions">
        <div>
          <h1>{t('邮箱工作台')}</h1>
        </div>
        <Button disabled={!rows.accounts.length} onClick={() => beginDraft()}>
          <Icon name="plus" size={16} />
          {t('写邮件')}
        </Button>
      </div>
      <div className="view-tabs" role="tablist" aria-label={t('邮件视图')}>
        {[
          ['inbox', '收件箱'],
          ['drafts', '草稿与发送'],
          ['accounts', '账户设置'],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'selected' : ''}
            onClick={() => leave(() => setTab(id))}
          >
            {t(label)}
            {id === 'drafts' && rows.drafts.length > 0 && (
              <span className="count-badge">{rows.drafts.length}</span>
            )}
          </button>
        ))}
      </div>
      {issue && (
        <div className="error" role="alert">
          {issue}
        </div>
      )}
      {tab === 'inbox' && (
        <>
          <div className="mail-tools">
            <label className="search-control">
              <Icon name="search" size={16} />
              <input
                aria-label={t('搜索邮件')}
                placeholder={t('搜索主题、发件人或已读正文')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select
              aria-label={t('邮件账户筛选')}
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setFolder('');
                setChecked([]);
                setSelected(undefined);
              }}
            >
              <option value="">{t('全部账户')}</option>
              {rows.accounts.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {account && (
              <select
                aria-label={t('邮件文件夹')}
                value={folder}
                onChange={(e) => {
                  setFolder(e.target.value);
                  setChecked([]);
                  setSelected(undefined);
                }}
              >
                <option value="">{t('全部已同步文件夹')}</option>
                {(rows.accounts.find((a: any) => a.id === account)?.folders ?? []).map((f: any) => (
                  <option key={f.path} value={f.path}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
            <Button
              secondary
              disabled={!account || loading}
              title={!account ? t('先选择一个账户') : ''}
              onClick={() =>
                run(
                  () => rpc('mail.sync', { accountId: account, mailbox: folder || undefined }),
                  t('元数据已同步'),
                )
              }
            >
              <Icon name="review" size={15} />
              {t('同步')}
            </Button>
            <Button secondary disabled={loading} onClick={() => loadRef.current()}>
              {t('刷新')}
            </Button>
          </div>
          {checked.length > 0 && (
            <div className="selection-toolbar">
              <strong>
                {t('已选择')} {checked.length}
              </strong>
              {['read', 'unread', 'archive', 'trash'].map((action) => (
                <Button
                  secondary
                  key={action}
                  disabled={!data.plugins.some((p: any) => p.id === 'mail-actions' && p.enabled)}
                  onClick={() =>
                    run(async () => {
                      const a = await rpc('mail-actions.organize', {
                        ids: checked,
                        action,
                        requestId: crypto.randomUUID(),
                      });
                      setChecked([]);
                      setPage('approvals');
                      return a;
                    }, t('已提交审批'))
                  }
                >
                  {t(
                    (
                      {
                        read: '标为已读',
                        unread: '标为未读',
                        archive: '归档邮件',
                        trash: '移至废纸篓',
                      } as any
                    )[action],
                  )}
                </Button>
              ))}
              <select
                aria-label={t('目标文件夹')}
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
              >
                <option value="">{t('选择目标文件夹')}</option>
                {(rows.accounts.find((a: any) => a.id === account)?.folders ?? []).map((f: any) => (
                  <option key={f.path} value={f.path}>
                    {f.name}
                  </option>
                ))}
              </select>
              <Button
                secondary
                disabled={!moveTarget}
                onClick={() =>
                  run(async () => {
                    const a = await rpc('mail-actions.organize', {
                      ids: checked,
                      action: 'move',
                      target: moveTarget,
                      requestId: crypto.randomUUID(),
                    });
                    setPage('approvals');
                    setChecked([]);
                    return a;
                  }, t('已提交审批'))
                }
              >
                {t('移动')}
              </Button>
            </div>
          )}
          <div className="mail-layout">
            <div className="mail-items" aria-busy={loading}>
              {rows.messages.map((mail: any) => (
                <div className="mail-select-row" key={mail.id}>
                  <input
                    type="checkbox"
                    aria-label={t('选择邮件') + ' ' + mail.subject}
                    checked={checked.includes(mail.id)}
                    onChange={(e) =>
                      setChecked(
                        e.target.checked
                          ? [...checked, mail.id].slice(0, 20)
                          : checked.filter((id) => id !== mail.id),
                      )
                    }
                  />
                  <button
                    key={mail.id}
                    className={
                      'mail-item ' +
                      (selected?.id === mail.id ? 'selected ' : '') +
                      (Array.isArray(mail.flags) && !mail.flags.includes('\\Seen') ? 'unread' : '')
                    }
                    onClick={async () => {
                      const version = ++readRevision.current;
                      setSelected(mail);
                      setReading(true);
                      const full = await act(() => rpc('mail.read', { id: mail.id }), '');
                      if (version === readRevision.current) {
                        if (full) setSelected(full);
                        setReading(false);
                      }
                    }}
                  >
                    <div className="row between">
                      <strong>{mail.from.replace(/<.*>/, '').trim() || mail.from}</strong>
                      <time>{date(mail.date)}</time>
                    </div>
                    <b>{mail.subject || t('（无主题）')}</b>
                    <small>
                      {rows.accounts.find((a: any) => a.id === mail.accountId)?.name}
                      {mail.bodyCached ? t(' · 已缓存正文') : ''}
                      {mail.attachmentCount ? ' · ' + mail.attachmentCount + t(' 个附件') : ''}
                    </small>
                  </button>
                </div>
              ))}
              {!rows.messages.length && !loading && (
                <EmptyState
                  icon="mail"
                  title={rows.accounts.length ? t('没有匹配的邮件') : t('还没有邮件账户')}
                >
                  {rows.accounts.length
                    ? t('选择账户同步元数据，或换个检索词。')
                    : t('在“账户设置”添加一个账户。')}
                </EmptyState>
              )}
              {loading && (
                <div className="chat-loading">
                  <span className="spinner" />
                  {t('正在读取邮件列表')}
                </div>
              )}
              {rows.hasMore && (
                <Button secondary disabled={loading} onClick={() => loadRef.current(true)}>
                  {t('加载更多缓存记录')}
                </Button>
              )}
              <div className="mail-list-footer">
                <span>
                  {rows.messages.length} {t('封已加载')}
                </span>
                {account && (
                  <button
                    className="text-button"
                    onClick={() =>
                      run(
                        () =>
                          rpc('mail.backfill', {
                            accountId: account,
                            mailbox: folder || undefined,
                          }),
                        t('已向前加载一批历史元数据'),
                      )
                    }
                  >
                    {t('补载历史元数据')}
                  </button>
                )}
              </div>
            </div>
            <div className="mail-reader">
              {selected ? (
                <>
                  <div className="mail-reader-heading">
                    <span className="eyebrow">{t('邮件正文')}</span>
                    <h2>{selected.subject || t('（无主题）')}</h2>
                    <p>
                      {t('发件人：')}
                      {selected.from}
                    </p>
                    {selected.to && (
                      <p>
                        {t('收件人：')}
                        {selected.to}
                      </p>
                    )}
                    <p>{date(selected.date)}</p>
                  </div>
                  {reading ? (
                    <div className="chat-loading">
                      <span className="spinner" />
                      {t('正在读取正文')}
                    </div>
                  ) : selected.text !== undefined ? (
                    <pre className="mail-body">{selected.text || t('（空正文）')}</pre>
                  ) : (
                    <EmptyState title={t('正文未能读取')} icon="mail">
                      {t('重新选择此邮件可以再试一次。')}
                    </EmptyState>
                  )}
                </>
              ) : (
                <EmptyState title={t('选择一封邮件')} icon="mail">
                  {t('只在你打开邮件时读取正文，不自动加载外部图片。')}
                </EmptyState>
              )}
            </div>
          </div>
        </>
      )}
      {tab === 'accounts' && (
        <div className="mail-account-layout">
          <div className="card">
            <div className="row between">
              <h2>{t('已配置账户')}</h2>
              <Button secondary onClick={() => beginAccount()}>
                <Icon name="plus" size={14} />
                {t('添加')}
              </Button>
            </div>
            {rows.accounts.map((a: any) => (
              <div className="account-entry" key={a.id}>
                <button className="account-row" onClick={() => beginAccount(a)}>
                  <span className="account-avatar">
                    <Icon name="mail" size={18} />
                  </span>
                  <span>
                    <b>{a.name}</b>
                    <small>
                      {a.user} ·{' '}
                      {t(mailProviders.find((p) => p.id === a.provider)?.name ?? '其他 IMAP 邮箱')}
                    </small>
                    <small>
                      {a.status ? statusText(a.status.state) : t('尚未同步')}
                      {a.status?.finishedAt ? ' · ' + date(a.status.finishedAt) : ''}
                    </small>
                    {a.status?.message && <span className="warning">{t(a.status.message)}</span>}
                  </span>
                  <Icon name="chevron" size={14} />
                </button>
                <div className="row account-entry-actions">
                  <Button
                    secondary
                    onClick={() =>
                      run(() => rpc('mail.test', { accountId: a.id }), t('IMAP 与 SMTP 认证通过'))
                    }
                  >
                    {t('检查连接')}
                  </Button>
                  <Button
                    secondary
                    onClick={() =>
                      run(() => rpc('mail.folders', { accountId: a.id }), t('文件夹已更新'))
                    }
                  >
                    {t('发现文件夹')}
                  </Button>
                </div>
              </div>
            ))}
            {!rows.accounts.length && (
              <EmptyState title={t('添加你的第一个账户')} icon="mail">
                {t('使用邮箱提供的应用密码连接 IMAP 和 SMTP。')}
              </EmptyState>
            )}
          </div>
          {editing && (
            <div className="card account-editor">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const result = await run(
                    () =>
                      rpc('mail.configure', {
                        ...editing,
                        name: editing.name.trim() || editing.user,
                      }),
                    t('账户已保存'),
                  );
                  if (result) setEditing(undefined);
                }}
              >
                <h2>
                  {rows.accounts.some((a: any) => a.id === editing.id)
                    ? t('编辑账户')
                    : t('新账户')}
                </h2>
                <label className="field">
                  <span>{t('邮箱类型')}</span>
                  <select
                    value={editing.provider ?? 'custom'}
                    onChange={(e) => {
                      const p = mailProviders.find((p) => p.id === e.target.value)!;
                      setEditing({
                        ...editing,
                        provider: p.id,
                        imap: { ...p.imap },
                        smtp: { ...p.smtp },
                      });
                    }}
                  >
                    {mailProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {t(p.name)}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="setup-instruction">
                  {t(
                    mailProviders.find((p) => p.id === editing.provider)?.help ??
                      mailProviders[3].help,
                  )}{' '}
                  {mailProviders.find((p) => p.id === editing.provider)?.url && (
                    <a
                      href={mailProviders.find((p) => p.id === editing.provider)!.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('设置说明')} ↗
                    </a>
                  )}
                </p>
                <div className="form-grid">
                  {field(t('账户名称'), 'name', 'text')}
                  {field(t('登录用户名'), 'user', 'text', true)}
                  {field(t('发件地址'), 'from', 'email', true)}
                  <CredentialInput label={t('授权码或应用密码')} reference={editing.passwordRef ?? ''} value={editing.password ?? ''} onChange={(password: string) => setEditing({ ...editing, password })} />
                </div>
                <label className="field">
                  <span>{t('网络连接')}</span>
                  <select
                    value={editing.network ?? 'direct'}
                    onChange={(e) => setEditing({ ...editing, network: e.target.value })}
                  >
                    <option value="direct">{t('直连')}</option>
                    <option value="environment-proxy">{t('HTTP(S) 环境代理')}</option>
                  </select>
                </label>
                <details
                  className="mail-server-settings"
                  open={['custom', 'institution'].includes(editing.provider)}
                >
                  <summary>{t('服务器设置')} · IMAP / SMTP</summary>
                  <div className="form-grid">
                    {(['imap', 'smtp'] as const).map((kind) => (
                      <fieldset key={kind}>
                        <legend>{kind.toUpperCase()}</legend>
                        <label className="field">
                          <span>{t('服务器')}</span>
                          <input
                            aria-label={kind.toUpperCase() + t(' 服务器')}
                            required
                            value={editing[kind].host}
                            onChange={(e) =>
                              setEditing({
                                ...editing,
                                [kind]: { ...editing[kind], host: e.target.value },
                              })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>{t('端口')}</span>
                          <input
                            type="number"
                            min="1"
                            max="65535"
                            required
                            value={editing[kind].port}
                            onChange={(e) =>
                              setEditing({
                                ...editing,
                                [kind]: { ...editing[kind], port: Number(e.target.value) },
                              })
                            }
                          />
                        </label>
                        <label className="toggle-field">
                          <span>{t('直接 TLS 连接')}</span>
                          <input
                            type="checkbox"
                            checked={editing[kind].secure}
                            onChange={(e) =>
                              setEditing({
                                ...editing,
                                [kind]: { ...editing[kind], secure: e.target.checked },
                              })
                            }
                          />
                        </label>
                      </fieldset>
                    ))}
                  </div>
                </details>
                <details>
                  <summary>{t('更多选项')}</summary>
                  {field(t('IMAP 文件夹'), 'mailbox')}
                  <label className="toggle-field">
                    <span>{t('同步已发送文件夹')}</span>
                    <input type="checkbox" checked={editing.syncSent ?? true}
                      onChange={(e) => setEditing({ ...editing, syncSent: e.target.checked })} />
                  </label>
                </details>
                <div className="form-actions">
                  <Button type="submit">{t('保存账户')}</Button>
                  <Button secondary onClick={() => setEditing(undefined)}>
                    {t('取消')}
                  </Button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
      {tab === 'drafts' && (
        <div className="mail-account-layout">
          <div className="card">
            <h2>{t('草稿与发送回执')}</h2>
            {rows.drafts.map((d: any) => (
              <button className="document-row" key={d.id} onClick={() => beginDraft(d)}>
                <div>
                  <b>{d.subject || t('（无主题）')}</b>
                  <small>
                    {d.to.join(', ')} · {statusText(d.state)}
                  </small>
                </div>
                <Icon name="chevron" size={14} />
              </button>
            ))}
            {!rows.drafts.length && (
              <EmptyState title={t('还没有草稿')} icon="mail">
                {t('写好内容后保存，发送前仍需核对审批。')}
              </EmptyState>
            )}
          </div>
          <div className="card">
            {draft ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const result = await run(
                    () =>
                      rpc('mail.draft', {
                        ...draft,
                        to: draft.to
                          .split(/[,;；，]/)
                          .map((s: string) => s.trim())
                          .filter(Boolean),
                      }),
                    t('草稿已保存'),
                  );
                  if (result) {
                    const saved = { ...result, to: result.to.join(', ') };
                    draftBaseline.current = saved;
                    setDraft(saved);
                  }
                }}
              >
                <h2>{draft.id ? t('查看与编辑草稿') : t('撰写邮件')}</h2>
                <label className="field">
                  <span>{t('发件账户')}</span>
                  <select
                    disabled={draft.state && draft.state !== 'draft'}
                    value={draft.accountId}
                    onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
                  >
                    {rows.accounts.map((a: any) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t('收件人')}</span>
                  <input
                    type="email"
                    multiple
                    required
                    aria-label={t('邮件收件人')}
                    disabled={draft.state && draft.state !== 'draft'}
                    value={draft.to}
                    placeholder={t('多个地址以英文逗号分隔')}
                    onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t('主题')}</span>
                  <input
                    aria-label={t('邮件主题')}
                    disabled={draft.state && draft.state !== 'draft'}
                    value={draft.subject}
                    onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>{t('正文')}</span>
                  <textarea
                    aria-label={t('邮件正文')}
                    disabled={draft.state && draft.state !== 'draft'}
                    rows={10}
                    value={draft.text}
                    onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                  />
                </label>
                {(!draft.state || draft.state === 'draft') && (
                  <div className="form-actions">
                    <Button type="submit">{t('保存草稿')}</Button>
                    {draft.id && (
                      <Button
                        secondary
                        disabled={
                          draftDirty ||
                          !data.plugins.some((p: any) => p.id === 'mail-actions' && p.enabled)
                        }
                        onClick={async () => {
                          const result = await run(
                            () => rpc('mail-actions.propose', { draftId: draft.id }),
                            t('已提交审批'),
                          );
                          if (result) setPage('approvals');
                        }}
                      >
                        {t('申请发送审批')}
                        <Icon name="arrow" size={14} />
                      </Button>
                    )}
                  </div>
                )}
                {draft.state === 'unknown' && (
                  <p className="warning">
                    {t('发送结果待核对，不会自动重发。请到审批页检查回执。')}
                  </p>
                )}
                {draftDirty && draft.id && (
                  <p className="muted">{t('修改后请先保存，再申请审批。')}</p>
                )}
              </form>
            ) : (
              <EmptyState title={t('继续一封草稿，或写一封新邮件')} icon="mail">
                {t('这里不会直接发送，最后一步由你在审批页确认。')}
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
