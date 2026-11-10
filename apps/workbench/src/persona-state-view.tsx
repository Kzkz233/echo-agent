import { useEffect, useState, useRef } from 'react';
import { rpc } from './client.ts';
import { t, locale } from './i18n.ts';
import {
  Button,
  EmptyState,
  Icon,
  requestNavigation,
  useUnsavedChanges,
  sameData,
  useConfirm,
} from './ui.tsx';
export function ReflectionsView({ personaId, act, embedded = false }: any) {
  const [rows, setRows] = useState<any[]>([]),
    [draft, setDraft] = useState<any>(),
    [preview, setPreview] = useState<any>(),
    [issue, setIssue] = useState('');
  const request = useRef(0),
    dialog = useRef<HTMLDialogElement>(null),
    baseline = useRef<any>(undefined);
  const confirm = useConfirm(),
    dirty = Boolean(draft && !sameData(draft, baseline.current));
  useUnsavedChanges(dirty, '角色关切');
  const load = async () => {
    const version = ++request.current;
    try {
      const [notes, context] = await Promise.all([
        rpc('reflections.list', { personaId }),
        rpc('reflections.preview', { personaId }),
      ]);
      if (version === request.current) {
        setRows(notes);
        setPreview(context);
        setIssue('');
      }
    } catch (e) {
      if (version === request.current) setIssue((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    const update = (e: any) => {
      if (['reflections.updated', 'connection.ready'].includes(e.detail.type)) void load();
    };
    window.addEventListener('echo-event', update);
    return () => {
      request.current++;
      window.removeEventListener('echo-event', update);
    };
  }, [personaId]);
  const edit = (note?: any) => {
    const value = note
      ? {
          id: note.id,
          personaId: note.personaId,
          title: note.title,
          text: note.text,
          focus: note.focus,
          evidence: note.evidence,
          sources: note.sources,
          version: note.version,
        }
      : { personaId, title: '', text: '', focus: '', evidence: '', sources: [], version: 0 };
    baseline.current = value;
    setDraft(value);
    dialog.current?.showModal();
  };
  const save = async () => {
    if (await act(() => rpc('reflections.save', draft), t('关注已保存'))) {
      dialog.current?.close();
      setDraft(undefined);
      await load();
    }
  };
  const forget = async (note: any) => {
    if (
      !(await confirm({
        title: t('不再作为当前关注？'),
        description: t('这条内容将淡出当前会话背景，已有聊天和记忆保留。'),
        confirmLabel: t('淡出关注'),
      }))
    )
      return;
    await act(async () => {
      await rpc('reflections.forget', { personaId, id: note.id, expectedVersion: note.version });
      await load();
    });
  };
  return (
    <div className="state-workspace">
      <div className="page-title page-title-actions">
        {!embedded && <h1>{t('角色关切')}</h1>}
        <Button onClick={() => edit()}>
          <Icon name="plus" size={16} />
          {t('添加关注')}
        </Button>
      </div>
      <p className="muted">
        {t('近期惦记、想主动关心或接着聊的事。长期感受和稳定偏好仍放在记忆里。')}
      </p>
      {issue && (
        <div className="error" role="alert">
          {issue}
        </div>
      )}
      <div className="reflection-notes">
        {rows.map((note) => (
          <article className="reflection-card" key={note.id}>
            <div className="row between">
              <h2>{note.title}</h2>
              <button
                className="icon-button"
                aria-label={t('编辑关注 ') + note.title}
                onClick={() => edit(note)}
              >
                <Icon name="settings" size={15} />
              </button>
            </div>
            <p>{note.text}</p>
            {note.focus && (
              <div className="reflection-focus">
                <span>{t('想接着关注')}</span>
                {note.focus}
              </div>
            )}
            <footer>
              <time>{new Date(note.updatedAt).toLocaleDateString(locale())}</time>
              <button className="text-button" onClick={() => forget(note)}>
                {t('淡出关注')}
              </button>
            </footer>
          </article>
        ))}
        {!rows.length && <EmptyState title={t('暂时没有角色关切')} icon="personas" />}
      </div>
      <details className="card">
        <summary>{t('预览注入内容')}</summary>
        <pre className="readable-pre">{preview?.text || t('暂无内容')}</pre>
      </details>
      <dialog
        className="workspace-drawer"
        ref={dialog}
        onCancel={(e) => {
          if (dirty) {
            e.preventDefault();
            requestNavigation(() => dialog.current?.close());
          }
        }}
        onClose={() => setDraft(undefined)}
      >
        <div className="drawer-heading">
          <h2>{t(draft?.id ? '编辑关注' : '添加关注')}</h2>
          <button
            className="icon-button"
            aria-label={t('关闭')}
            onClick={() => requestNavigation(() => dialog.current?.close())}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="field">
              <span>{t('标题')}</span>
              <input
                required
                maxLength={160}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('在意的内容')}</span>
              <textarea
                required
                rows={6}
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('想接着关注')}</span>
              <textarea
                rows={3}
                value={draft.focus}
                onChange={(e) => setDraft({ ...draft, focus: e.target.value })}
              />
            </label>
            <details>
              <summary>{t('来源与依据')}</summary>
              <label className="field">
                <textarea
                  aria-label={t('来源与依据')}
                  rows={3}
                  value={draft.evidence}
                  onChange={(e) => setDraft({ ...draft, evidence: e.target.value })}
                />
              </label>
            </details>
            <Button type="submit">{t('保存')}</Button>
          </form>
        )}
      </dialog>
    </div>
  );
}
