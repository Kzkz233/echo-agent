import { statusText } from './i18n.ts';
import { locale } from './i18n.ts';
import { t } from './i18n.ts';
import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { localDay, localTime } from '../../../packages/kernel/time.ts';
import { useConfirm } from './ui.tsx';
import { AgendaFields, startAgendaDrag, useAgendaMove } from './agenda-interactions.tsx';
const dateInput = (s: string | undefined, timezone: string) =>
  s
    ? localDay(new Date(s), timezone) +
      'T' +
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(s))
    : '';
export function AgendaCalendar({ data, act }: any) {
  const confirmAction = useConfirm();
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [rows, setRows] = useState<any[]>([]),
    [fields, setFields] = useState<any[]>([]),
    [reminders, setReminders] = useState<any[]>([]),
    [form, setForm] = useState<any>({}),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false);
  const timezone =
    data.pluginSettings.agenda?.timezone ??
    data.clock?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const load = async () => {
    const [items, history, fields] = await Promise.all([
      rpc('agenda.list'),
      rpc('agenda.reminders'),
      rpc('agenda.fields'),
    ]);
    setRows(items);
    setReminders(history);
    setFields(fields);
  };
  const movement = useAgendaMove(act, load);
  useEffect(() => {
    void load();
    const cb = (e: any) => {
      if (
        ['agenda.updated', 'agenda.reminder', 'connection.ready', 'plugins.changed'].includes(
          e.detail.type,
        )
      )
        void load();
    };
    window.addEventListener('echo-event', cb);
    return () => window.removeEventListener('echo-event', cb);
  }, []);
  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      await act(async () => {
        await fn();
        await load();
      });
    } finally {
      setBusy(false);
    }
  };
  const set = (key: string, value: any) => setForm((f: any) => ({ ...f, [key]: value }));
  const begin = (day?: string) => {
    setForm({
      date: day,
      allDay: !!day,
      priority: 'normal',
      state: 'open',
      reminder: { enabled: false, minutesBefore: 0 },
    });
    setEditing(true);
  };
  const edit = (item: any) => {
    setForm({
      ...item,
      allDay: !!item.date,
      start: dateInput(item.start, timezone),
      end: dateInput(item.end, timezone),
    });
    setEditing(true);
  };
  const first = new Date(month.getFullYear(), month.getMonth(), 1),
    start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const dayOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const contains = (item: any, day: string) =>
    item.date
      ? item.date <= day && (item.dateEnd ?? item.date) >= day
      : item.start
        ? localDay(new Date(item.start), timezone) <= day &&
          localDay(new Date(item.end ?? item.start), timezone) >= day
        : false;
  return (
    <>
      <div className="page-title">
        <h1>{t('日历与提醒')}</h1>
      </div>
      <div className="row toolbar">
        {movement.undo}
        <button
          aria-label={t('Previous month')}
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          ←
        </button>
        <h2>{month.toLocaleDateString(locale(), { year: 'numeric', month: 'long' })}</h2>
        <button
          aria-label={t('Next month')}
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          →
        </button>
        <button
          onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
        >
          {' '}
          {t('Today')}{' '}
        </button>
        <button className="primary" onClick={() => begin()}>
          {' '}
          {t('New entry')}{' '}
        </button>
      </div>
      <div className="agenda-layout">
        <div className="card">
          <div className="calendar-grid">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <b className="calendar-weekday" key={d}>
                {t(d)}
              </b>
            ))}
            {days.map((day) => {
              const key = dayOf(day);
              return (
                <section
                  key={key}
                  onDragOver={movement.hover}
                  onDragLeave={movement.leave}
                  onDrop={(event) => void movement.drop(event, key)}
                  className={
                    'calendar-day ' +
                    (day.getMonth() !== month.getMonth() ? 'outside ' : '') +
                    (key === dayOf(new Date()) ? 'today' : '')
                  }
                >
                  <div className="row">
                    <time dateTime={key}>{day.getDate()}</time>
                    <button aria-label={t('Add entry on ') + key} onClick={() => begin(key)}>
                      ＋
                    </button>
                  </div>
                  {rows
                    .filter((i) => contains(i, key))
                    .map((i) => (
                      <button
                        key={i.id}
                        draggable={!busy && !movement.moving}
                        onDragStart={(event) => startAgendaDrag(event, i)}
                        className={'calendar-entry priority-' + i.priority + ' ' + i.state}
                        onClick={() => edit(i)}
                        title={i.notes}
                      >
                        {i.reminder?.enabled ? '◷ ' : ''}
                        {i.title}
                      </button>
                    ))}
                </section>
              );
            })}
          </div>
        </div>
        <div className="card">
          {!editing ? (
            <>
              <h2>{t('Entry details')}</h2>
              <p>{t('点击日期旁的 ＋ 新增条目，点击条目编辑。')}</p>
            </>
          ) : (
            <>
              <h2>{form.id ? t('Edit entry') : t('New entry')}</h2>
              <label className="field">
                <span>{t('Title')}</span>
                <input
                  aria-label={t('Calendar title')}
                  value={form.title ?? ''}
                  onChange={(e) => set('title', e.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('Notes')}</span>
                <textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
              </label>
              <AgendaFields
                fields={fields}
                value={form.extensions}
                onChange={(value: any) => set('extensions', value)}
              />
              <label className="toggle-field">
                <span>{t('All day')}</span>
                <input
                  type="checkbox"
                  checked={form.allDay ?? false}
                  onChange={(e) => {
                    set('allDay', e.target.checked);
                    if (e.target.checked && !form.date)
                      set('date', (form.start ?? dayOf(new Date())).slice(0, 10));
                  }}
                />
              </label>
              {form.allDay ? (
                <>
                  <label className="field">
                    <span>{t('Date')}</span>
                    <input
                      type="date"
                      value={form.date ?? ''}
                      onChange={(e) => set('date', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>{t('结束日期（可选）')}</span>
                    <input
                      type="date"
                      min={form.date}
                      value={form.dateEnd ?? ''}
                      onChange={(event) => set('dateEnd', event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  {['start', 'end'].map((key) => (
                    <label className="field" key={key}>
                      <span>{key === 'start' ? t('Start') : t('End')}</span>
                      <input
                        type="datetime-local"
                        value={form[key] ?? ''}
                        onChange={(e) => set(key, e.target.value)}
                      />
                    </label>
                  ))}
                </>
              )}
              {(['priority', 'state'] as const).map((key) => (
                <label className="field" key={key}>
                  <span>{key === 'priority' ? t('Priority') : t('State')}</span>
                  <select
                    aria-label={key === 'priority' ? t('Priority') : t('State')}
                    value={form[key] ?? (key === 'priority' ? 'normal' : 'open')}
                    onChange={(e) => set(key, e.target.value)}
                  >
                    {(key === 'priority'
                      ? ['low', 'normal', 'high']
                      : ['open', 'done', 'cancelled']
                    ).map((v) => (
                      <option key={v} value={v}>
                        {key === 'state'
                          ? statusText(v)
                          : t(({ low: '低', normal: '普通', high: '高' } as any)[v] ?? v)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="toggle-field">
                <span>{t('Remind me')}</span>
                <input
                  type="checkbox"
                  checked={form.reminder?.enabled ?? false}
                  onChange={(e) => set('reminder', { ...form.reminder, enabled: e.target.checked })}
                />
              </label>
              {form.reminder?.enabled && (
                <label className="field">
                  <span>
                    {t('Minutes before (all-day entries use the configured reminder hour)')}
                  </span>
                  <input
                    type="number"
                    min="0"
                    max="43200"
                    value={form.reminder?.minutesBefore ?? 0}
                    onChange={(e) =>
                      set('reminder', { ...form.reminder, minutesBefore: Number(e.target.value) })
                    }
                  />
                </label>
              )}
              <label className="field">
                <span>{t('Conversation (optional)')}</span>
                <select
                  value={form.conversationId ?? ''}
                  onChange={(e) => set('conversationId', e.target.value)}
                >
                  <option value="">{t('No per-entry binding')}</option>
                  {data.conversations.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row wrap">
                <button
                  className="primary"
                  disabled={busy || !form.title?.trim()}
                  onClick={() =>
                    void run(async () => {
                      await rpc('agenda.save', {
                        ...form,
                        date: form.allDay ? form.date || undefined : undefined,
                        dateEnd: form.allDay ? form.dateEnd || undefined : undefined,
                        start:
                          !form.allDay && form.start
                            ? new Date(
                                localTime(
                                  form.start.slice(0, 10),
                                  Number(form.start.slice(11, 13)),
                                  Number(form.start.slice(14, 16)),
                                  timezone,
                                ),
                              ).toISOString()
                            : undefined,
                        end:
                          !form.allDay && form.end
                            ? new Date(
                                localTime(
                                  form.end.slice(0, 10),
                                  Number(form.end.slice(11, 13)),
                                  Number(form.end.slice(14, 16)),
                                  timezone,
                                ),
                              ).toISOString()
                            : undefined,
                        conversationId: form.conversationId || undefined,
                      });
                      setEditing(false);
                    })
                  }
                >
                  {' '}
                  {t('Save entry')}{' '}
                </button>
                <button onClick={() => setEditing(false)}>{t('Close')}</button>
                {form.id && (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await confirmAction({
                          title: t('删除这条日程？'),
                          description: '“' + form.title + '”及其后续提醒会被移除。',
                          danger: true,
                          confirmLabel: t('删除日程'),
                        })
                      )
                        void run(async () => {
                          await rpc('agenda.remove', { id: form.id, revision: form.revision });
                          setEditing(false);
                        });
                    }}
                  >
                    {' '}
                    {t('Delete')}{' '}
                  </button>
                )}
              </div>
            </>
          )}
          <h2>{t('Unscheduled')}</h2>
          {rows
            .filter((i) => !i.date && !i.start)
            .map((i) => (
              <button className="document-row" key={i.id} onClick={() => edit(i)}>
                {i.title}
              </button>
            ))}
          <h2>{t('Recent reminders')}</h2>
          {reminders
            .slice(-10)
            .reverse()
            .map((r) => (
              <div key={r.id}>
                <b>{r.title}</b>
                <small> · {statusText(r.state)}</small>
              </div>
            ))}
          <p className="muted">
            {' '}
            {t(
              '提醒不调用模型。Notifications 可增强收件箱和已绑定会话展示；缺少它时提醒仍保存在此处。',
            )}{' '}
          </p>
        </div>
      </div>
    </>
  );
}
