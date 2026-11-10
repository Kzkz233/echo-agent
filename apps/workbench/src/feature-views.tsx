import { CredentialInput } from './credential-input.tsx';
import { statusText } from './i18n.ts';
import { t } from './i18n.ts';
import { useState, useEffect } from 'react';
import { rpc } from './client.ts';
import { Button, Icon, EmptyState, PathInput, useConfirm } from './ui.tsx';
import { MailView } from './mail-view.tsx';
const titles: Record<string, string> = {
  files: '文件管理',
  assets: '图片与表情素材',
  agenda: '日历与提醒',
  mail: '邮箱工作台',
  scheduler: '任务调度',
  backup: '备份与恢复',
  notifications: '通知中心',
  approvals: '操作审批',
  channels: '会话通道',
  'channel-connections': '消息渠道连接',
};
function Input({ label, value, onChange, type = 'text', path = false, directory = false }: any) {
  return (
    <label className="field">
      <span>{t(label)}</span>
      {path ? (
        <PathInput label={label} value={value} onChange={onChange} directory={directory} />
      ) : type === 'textarea' ? (
        <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={4} />
      ) : (
        <input type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
export function FeaturePage(props: any) {
  return props.page === 'mail' ? <MailView {...props} /> : <UtilityPage {...props} />;
}
function UtilityPage({ page, data, act, personaId, setPage, embedded = false }: any) {
  const confirmAction = useConfirm();
  const [rows, setRows] = useState<any>([]),
    [form, setForm] = useState<any>(page === 'channel-connections' ? { qqAppId: data.pluginSettings.qq?.appId ?? '' } : {}),
    [selected, setSelected] = useState<any>(),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => { if (page === 'channels') { setForm({}); setSelected(undefined); } }, [page, personaId]);
  const set = (key: string, value: any) => setForm((f: any) => ({ ...f, [key]: value }));
  const roleConversations = personaId
    ? data.conversations.filter((c: any) => c.personaId === personaId && c.kind === 'main')
    : data.conversations;
  const targetConversation =
    form.conversationId ?? (personaId ? roleConversations[0]?.id : undefined);
  const load = async () => {
    const method =
      page === 'backup'
        ? 'backup.status'
        : page === 'channel-connections'
          ? 'channels.list'
          : page + '.list';
    const result = await rpc(method, {});
    if (page === 'channels' && personaId) {
      result.bindings = result.bindings.filter((b: any) => roleConversations.some((c: any) => c.id === b.conversationId));
      result.deliveries = result.deliveries.filter((delivery: any) => roleConversations.some((c: any) => c.id === delivery.conversationId));
    }
    setRows(result);
    setLoaded(true);
  };
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
    const cb = (e: any) => {
      if (
        e.detail.type === 'connection.ready' ||
        e.detail.type === page + '.updated' ||
        e.detail.type === 'notification.created' ||
        (['channels', 'channel-connections'].includes(page) &&
          ['qq.updated', 'channels.updated'].includes(e.detail.type))
      )
        void load().catch(() => {});
    };
    window.addEventListener('echo-event', cb);
    return () => window.removeEventListener('echo-event', cb);
  }, [page, personaId]);
  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await act(async () => {
        const result = await fn();
        await load();
        return result;
      });
    } finally {
      setBusy(false);
    }
  };
  const text = (key: string, label: string, type = 'text') => (
    <Input
      key={key}
      label={label}
      path={['path', 'directory', 'target'].includes(key)}
      directory={['path', 'directory', 'target'].includes(key)}
      value={form[key]}
      type={type}
      onChange={(v: string) => set(key, v)}
    />
  );
  return (
    <div className={'feature-page feature-' + page}>
      {!embedded && <div className="page-title"><h1>{t(titles[page])}</h1></div>}
      <div className="row toolbar">
        <Button secondary disabled={busy} onClick={() => run(load)}>
          <Icon name="review" size={15} />
          {t('刷新')}{' '}
        </Button>
        {message && <span role="status">{message}</span>}
      </div>
      <div className={page === 'approvals' ? 'approval-workspace' : 'two-column'}>
        {page !== 'approvals' && (
          <div className="card feature-form">
            {['channels', 'channel-connections'].includes(page) && (
              <>
                {page === 'channel-connections' && (
                  <>
                    <h2>{t('QQ connection')}</h2>
                    {text('qqAppId', t('QQ App ID'))}
                    <CredentialInput label="QQ App Secret" reference={data.pluginSettings.qq?.secretRef ?? ''} value={form.qqSecret ?? ''} onChange={(value: string) => set('qqSecret', value)} />
                    <Button
                      disabled={busy || !data.plugins.some((p: any) => p.id === 'qq' && p.enabled)}
                      onClick={() =>
                        run(async () => {
                          const secretRef = data.pluginSettings.qq?.secretRef || 'qq-bot-secret';
                          if (form.qqSecret) await rpc('credentials.save', { reference: secretRef, secret: form.qqSecret });
                          await rpc('settings.save', {
                            pluginId: 'qq',
                            value: {
                              ...data.pluginSettings.qq,
                              appId: form.qqAppId,
                              secretRef,
                              enabled: true,
                            },
                          });
                          set('qqSecret', '');
                        })
                      }
                    >
                      {' '}
                      {t('Connect QQ')}{' '}
                    </Button>
                  </>
                )}
                {page === 'channels' && (
                  <>
                    <h2>{t(form.id ? '编辑通道绑定' : '添加通道绑定')}</h2>
                    <Button secondary onClick={() => setPage('plugins', 'qq')}>
                      {t('管理消息渠道连接')}
                    </Button>
                    <label className="field">
                      <span>{t('通道类型')}</span>
                      <select
                        value={form.adapter ?? ''}
                        onChange={(e) => set('adapter', e.target.value)}
                      >
                        <option value="">{t('Choose an adapter')}</option>
                        {rows.adapters
                          ?.filter((a: any) => a.state === 'active')
                          .map((a: any) => (
                            <option key={a.id} value={a.id}>
                              {t(a.label)}
                            </option>
                          ))}
                      </select>
                    </label>
                    {text(
                      'peer',
                      t('External peer (QQ: c2c:openid or group:openid; desktop: local)'),
                    )}
                    <label className="field">
                      <span>{t('目标会话')}</span>
                      <select
                        aria-label={t('目标会话')}
                        value={targetConversation ?? ''}
                        disabled={Boolean(personaId)}
                        onChange={(e) => set('conversationId', e.target.value)}
                      >
                        <option value="">{t('Choose a conversation')}</option>
                        {roleConversations.map((c: any) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="toggle-field">
                      <span>{t('Also show replies in a bubble')}</span>
                      <input
                        type="checkbox"
                        checked={form.alsoBubble ?? false}
                        onChange={(e) => set('alsoBubble', e.target.checked)}
                      />
                    </label>
                    <p className="muted">{t('自动化消息的输出位置在各任务中设置。')}</p>
                    <Button
                      disabled={busy || !form.adapter || !form.peer || !targetConversation}
                      onClick={() =>
                        run(async () => {
                          await rpc('channels.bind', {
                            id: form.id,
                            adapter: form.adapter,
                            peer: form.peer,
                            conversationId: targetConversation,
                            alsoBubble: form.alsoBubble ?? false,
                            automaticSources: form.automaticSources ?? [],
                            automaticTriggerKinds: form.automaticTriggerKinds ?? [],
                            enabled: true,
                          });
                          setForm({});
                        })
                      }
                    >
                      {' '}
                      {t('Save binding')}{' '}
                    </Button>
                    <h3>{t('Discovered peers')}</h3>
                    {rows.peers?.map((p: any) => (
                      <button
                        className="document-row"
                        key={p.adapter + p.peer}
                        onClick={() => setForm({ ...form, adapter: p.adapter, peer: p.peer })}
                      >
                        {p.adapter} · {p.peer}
                      </button>
                    ))}
                    <p className="muted">
                      {' '}
                      {t(
                        '未绑定的联系人不会调用模型。Observe 不自动发送 QQ；平台对主动推送、回复时限和条数另有约束。',
                      )}{' '}
                    </p>
                  </>
                )}
              </>
            )}
            {page === 'approvals' && (
              <>
                <h2>{t('Review before execution')}</h2>
                <p>
                  {' '}
                  {t(
                    '核对完整内容后在这里批准或拒绝。邮件等插件只负责提出操作；消息通道不能代替你的审批决定。',
                  )}{' '}
                </p>
              </>
            )}
            {page === 'scheduler' && (
              <>
                <h2>{t('Scheduled task')}</h2>
                {text('name', t('Name'))}
                <label className="field">
                  <span>{t('Task handler')}</span>
                  <select
                    value={form.provider ?? ''}
                    onChange={(e) => set('provider', e.target.value)}
                  >
                    <option value="">{t('Select…')}</option>
                    {rows.providers
                      ?.filter((p: any) => p.state === 'active')
                      .map((p: any) => (
                        <option key={p.id} value={p.id}>
                          {t(p.label)}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field">
                  <span>{t('Schedule')}</span>
                  <select
                    value={form.mode ?? 'interval'}
                    onChange={(e) => set('mode', e.target.value)}
                  >
                    <option value="interval">{t('Interval')}</option>
                    <option value="daily">{t('Daily')}</option>
                  </select>
                </label>
                {form.mode === 'daily' ? (
                  <>
                    {text('hour', t('Hour'), 'number')}
                    {text('minute', t('Minute'), 'number')}
                    {text('timezone', t('Timezone (default Asia/Shanghai)'))}
                  </>
                ) : (
                  text('minutes', t('Interval minutes'), 'number')
                )}
                {text('argumentKey', t('Argument name (e.g. accountId or id)'))}
                {text('argumentValue', t('Argument value'))}
                <label className="toggle-field">
                  <input
                    type="checkbox"
                    checked={form.enabled === true}
                    onChange={(e) => set('enabled', e.target.checked)}
                  />{' '}
                  {t('Enable automatic execution')}{' '}
                </label>
                <Button
                  onClick={() =>
                    run(() =>
                      rpc('scheduler.save', {
                        id: form.id ?? crypto.randomUUID(),
                        name: form.name,
                        provider: form.provider,
                        input: {
                          ...(form.originalInput ?? {}),
                          ...(form.argumentKey ? { [form.argumentKey]: form.argumentValue } : {}),
                        },
                        enabled: form.enabled ?? false,
                        mode: form.mode ?? 'interval',
                        minutes: Number(form.minutes) || 60,
                        hour: form.hour === undefined || form.hour === '' ? 7 : Number(form.hour),
                        minute: Number(form.minute) || 0,
                        timezone: form.timezone || 'Asia/Shanghai',
                      }),
                    )
                  }
                >
                  {' '}
                  {t('Save task')}{' '}
                </Button>
              </>
            )}
            {page === 'backup' && (
              <>
                <h2>{t('Create a complete backup')}</h2>
                <p>
                  {' '}
                  {t(
                    '先在 Plugins → Backup 选择备份目录和保留数量。快照含会话、状态和受管档案，不含密钥文件。',
                  )}{' '}
                </p>
                <Button
                  disabled={busy || rows.busy}
                  onClick={() =>
                    run(async () => {
                      const r = await rpc('backup.run');
                      setMessage('Backup: ' + r.directory);
                    })
                  }
                >
                  {' '}
                  {t('Back up now')}{' '}
                </Button>
                {text('directory', t('Backup directory to verify'))}
                <Button
                  onClick={() =>
                    run(async () => {
                      const r = await rpc('backup.inspect', { directory: form.directory });
                      setMessage(r.valid ? 'Checksum verified' : 'Verification failed');
                    })
                  }
                >
                  {' '}
                  {t('Verify')}{' '}
                </Button>
                {text('target', t('New empty data directory'))}
                <Button
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirmAction({
                        title: t('恢复到新目录？'),
                        description: t(
                          '只会写入指定的新空目录，不覆盖现有数据。恢复后自动功能保持关闭。',
                        ),
                        confirmLabel: t('开始恢复'),
                      })
                    )
                      run(async () => {
                        const r = await rpc('backup.restore', {
                          directory: form.directory,
                          target: form.target,
                          confirmed: true,
                        });
                        setMessage('Restored: ' + r.directory + ' · use ECHO_DATA_DIR to open it.');
                      });
                  }}
                >
                  {' '}
                  {t('Restore to new directory')}{' '}
                </Button>
              </>
            )}
            {page === 'notifications' && (
              <>
                <h2>{t('Notification inbox')}</h2>
                <p>{t('程序通知保留独立作者与投递回执，不会冒充你的聊天消息。')}</p>
                {rows.channels?.map((c: any) => (
                  <p key={c.id}>
                    {t(c.label)} · {c.state}
                  </p>
                ))}
              </>
            )}
          </div>
        )}
        <div className="card feature-list">
          {page === 'channel-connections' && (
            <>
              <h2>{t('可用消息渠道')}</h2>
              {rows.adapters?.map((adapter: any) => (
                <p key={adapter.id}>
                  {t(adapter.label)} · {statusText(adapter.state)}
                </p>
              ))}
            </>
          )}
          {!loaded && (
            <div className="chat-loading">
              <span className="spinner" />
              {t('正在读取')}
            </div>
          )}
          {loaded &&
            ((Array.isArray(rows) && !rows.length) ||
              (page === 'approvals' && !rows.items?.length) ||
              (page === 'notifications' && !rows.items?.length) ||
              (page === 'scheduler' && !rows.jobs?.length) ||
              (page === 'backup' && !rows.last)) && (
              <EmptyState title={t('还没有记录')} icon={page}>
                {t('完成左侧的设置后，记录会显示在这里。')}
              </EmptyState>
            )}

          {page === 'channels' && (
            <>
              <h2>{t('Bindings')}</h2>
              {rows.bindings?.map((b: any) => (
                <section key={b.id}>
                  <b>
                    {b.adapter} · {b.peer}
                  </b>
                  <p>
                    {data.conversations.find((c: any) => c.id === b.conversationId)?.title ??
                      b.conversationId}{' '}
                    · {b.enabled ? t('enabled') : t('disabled')}
                  </p>
                  <button onClick={() => setForm(b)}>{t('Edit')}</button>
                  <button
                    className="text-button danger"
                    onClick={async () => {
                      if (
                        await confirmAction({
                          title: t('解除此通道绑定？'),
                          description: t(
                            '保留 Echo 会话和历史回执。解除后，这个入口不再自动调用该会话。',
                          ),
                          confirmLabel: t('解除绑定'),
                          danger: true,
                        })
                      )
                        return run(() => rpc('channels.unbind', { id: b.id, confirmed: true }));
                    }}
                  >
                    {t('解除绑定')}
                  </button>
                  <button
                    onClick={() => run(() => rpc('channels.bind', { ...b, enabled: !b.enabled }))}
                  >
                    {b.enabled ? t('Disable') : t('Enable')}
                  </button>
                </section>
              ))}
              <h2>{t('Delivery receipts')}</h2>
              {rows.deliveries?.map((d: any) => (
                <section key={d.id}>
                  <p>
                    {d.adapter} · {statusText(d.state)}
                  </p>
                  <small>{d.id}</small>
                  <div className="row">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () => setSelected(await rpc('channels.inspect', { id: d.id })))
                      }
                    >
                      {' '}
                      {t('Inspect')}{' '}
                    </Button>
                    {d.state === 'failed' && (
                      <Button
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await confirmAction({
                              title: t('补发失败的部分？'),
                              description: t('只重试明确失败的部分，已确认成功的内容会保留。'),
                              confirmLabel: t('补发'),
                            })
                          )
                            run(() => rpc('channels.retry', { id: d.id, confirmed: true }));
                        }}
                      >
                        {' '}
                        {t('Retry failed portion')}{' '}
                      </Button>
                    )}
                  </div>
                </section>
              ))}
              {selected && (
                <details>
                  <summary>{t('技术回执')}</summary>
                  <pre>{JSON.stringify(selected.receipt ?? selected, null, 2)}</pre>
                </details>
              )}
            </>
          )}
          {page === 'approvals' && (
            <>
              <h2>{t('Pending decisions and receipts')}</h2>
              {rows.items?.map((r: any) => (
                <button
                  key={r.id}
                  className="document-row"
                  onClick={() =>
                    run(async () => setSelected(await rpc('approvals.get', { id: r.id })))
                  }
                >
                  <b>{t(r.title)}</b>
                  <small>
                    {statusText(r.state)} · {r.createdAt}
                  </small>
                </button>
              ))}
              {selected && (
                <article>
                  <h3>{t(selected.title)}</h3>
                  <p>
                    {statusText(selected.state)} · {selected.executor}
                  </p>
                  {selected.details?.map((d: any, i: number) => (
                    <section key={i}>
                      <b>{t(d.label)}</b>
                      <pre>
                        {d.label === 'Operation'
                          ? t(
                              (
                                {
                                  read: '标为已读',
                                  unread: '标为未读',
                                  move: '移动',
                                  archive: '归档邮件',
                                  trash: '移至废纸篓',
                                } as any
                              )[d.value] ?? d.value,
                            )
                          : d.value}
                      </pre>
                    </section>
                  ))}
                  {selected.receipt?.items && (
                    <section className="approval-results">
                      <h3>{t('逐项执行结果')}</h3>
                      {selected.receipt.items.map((r: any, n: number) => (
                        <div className="approval-result" key={n} data-receipt-state={r.state}>
                          <b>
                            {selected.frozen?.items?.find((i: any) => i.row.id === r.id)?.row
                              .subject ?? t('邮件')}
                          </b>
                          <span className="state-pill">{statusText(r.state)}</span>
                          {r.message && <p className="warning">{t(r.message)}</p>}
                        </div>
                      ))}
                    </section>
                  )}
                  {selected.error && <p className="warning">{selected.error}</p>}
                  {!selected.error && typeof selected.receipt?.reason === 'string' && (
                    <p className="warning">{t(selected.receipt.reason)}</p>
                  )}
                  {selected.state === 'pending' && (
                    <div className="row">
                      <Button
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await confirmAction({
                              title: t('批准这项操作？'),
                              description: t('将执行已核对的内容，请确认目标和具体操作。'),
                              confirmLabel: t('批准执行'),
                            })
                          )
                            run(async () =>
                              setSelected(
                                await rpc('approvals.decide', {
                                  id: selected.id,
                                  revision: selected.revision,
                                  decision: 'approve',
                                  confirmed: true,
                                }),
                              ),
                            );
                        }}
                      >
                        {' '}
                        {t('Approve')}{' '}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          run(async () =>
                            setSelected(
                              await rpc('approvals.decide', {
                                id: selected.id,
                                revision: selected.revision,
                                decision: 'reject',
                                confirmed: true,
                              }),
                            ),
                          )
                        }
                      >
                        {' '}
                        {t('Reject')}{' '}
                      </Button>
                    </div>
                  )}
                  {selected.state === 'unknown' && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () =>
                          setSelected(await rpc('approvals.inspect', { id: selected.id })),
                        )
                      }
                    >
                      {' '}
                      {t('Inspect receipt (does not retry)')}{' '}
                    </Button>
                  )}
                </article>
              )}
            </>
          )}
          {page === 'scheduler' && (
            <>
              {rows.jobs?.map((j: any) => (
                <div className="card" key={j.id}>
                  <h3>{j.name}</h3>
                  <p>
                    {j.provider} · {j.enabled ? t('enabled') : t('disabled')}
                    {j.blocked ? t(' · blocked: reconcile unknown execution') : ''}
                  </p>
                  <button
                    onClick={() => {
                      const [first] = Object.entries(j.input ?? {});
                      setForm({
                        ...j,
                        originalInput: j.input,
                        argumentKey: first?.[0],
                        argumentValue: first?.[1],
                      });
                    }}
                  >
                    {t('Edit')}
                  </button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(() => rpc('scheduler.run', { id: j.id, requestId: crypto.randomUUID() }))
                    }
                  >
                    {' '}
                    {t('Run once')}{' '}
                  </Button>
                </div>
              ))}
              <h3>{t('Executions')}</h3>
              {rows.runs?.map((r: any) => (
                <p key={r.id}>
                  {r.startedAt} · {statusText(r.state)}
                  {r.state === 'unknown' && (
                    <button
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: t('确认已核对执行结果？'),
                            description: t('确认外部影响后结束此条未知执行，不会重新执行。'),
                            confirmLabel: t('标记已核对'),
                          })
                        )
                          run(() => rpc('scheduler.resolve', { id: r.id, confirmed: true }));
                      }}
                    >
                      {' '}
                      {t('Mark reconciled')}{' '}
                    </button>
                  )}
                </p>
              ))}
            </>
          )}
          {page === 'backup' && rows.last && (
            <>
              <h3>{t('Last complete backup')}</h3>
              <p>{rows.last.directory}</p>
              <p>
                {rows.last.files} {t('files ·')} {(rows.last.bytes / 1048576).toFixed(2)}{' '}
                {t('MB ·')} {rows.last.at}
              </p>
            </>
          )}
          {page === 'notifications' &&
            rows.items?.map((n: any) => (
              <div key={n.id}>
                <h3>{n.title}</h3>
                <p>{n.text}</p>
                <small>
                  {n.createdAt} · {statusText(n.state)}
                </small>
                <button onClick={() => run(() => rpc('notifications.read', { id: n.id }))}>
                  {' '}
                  {t('Mark read')}{' '}
                </button>
                {rows.channels
                  ?.filter((c: any) => c.state === 'active')
                  .map((c: any) => (
                    <button
                      key={c.id}
                      onClick={() =>
                        run(() => rpc('notifications.deliver', { id: n.id, provider: c.id }))
                      }
                    >
                      {t(c.label)}
                    </button>
                  ))}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
