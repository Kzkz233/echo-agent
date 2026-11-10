import { useEffect, useState, type FormEvent } from 'react';
import type { ReplyImage } from '../../../packages/contracts/index.ts';
import { rpc } from './client.ts';
import { ReplyImageView } from './chat-attachments.tsx';
import { t } from './i18n.ts';
import { Button, useConfirm } from './ui.tsx';

type Sticker = { key: string; label: string; meaning: string; enabled: boolean; image: ReplyImage };
const empty = { key: '', label: '', meaning: '', enabled: true };
function imageData(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ChatStickView({ personaId, embedded = false }: { personaId: string; embedded?: boolean }) {
  const [items, setItems] = useState<Sticker[]>([]),
    [draft, setDraft] = useState<typeof empty | null>(null),
    [existing, setExisting] = useState(false),
    [file, setFile] = useState<File>(),
    [pending, setPending] = useState(false),
    [issue, setIssue] = useState('');
  const confirm = useConfirm();
  const load = () => rpc<Sticker[]>('chatstick.list', { personaId }).then(setItems);
  useEffect(() => {
    void load().catch((error: Error) => setIssue(error.message));
  }, [personaId]);
  const edit = (item?: Sticker) => {
    setFile(undefined);
    setIssue('');
    setExisting(!!item);
    setDraft(item ? { key: item.key, label: item.label, meaning: item.meaning, enabled: item.enabled } : empty);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || pending) return;
    setPending(true);
    setIssue('');
    try {
      if (file && file.size > 8 * 1024 * 1024) throw Error(t('图片不能超过 8 MB。'));
      await rpc('chatstick.save', { personaId, ...draft, replace: existing, ...(file ? { data: await imageData(file) } : {}) });
      await load();
      setDraft(null);
    } catch (error) {
      setIssue((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  return <>
    <div className="page-title page-title-actions">
      {!embedded && <h1>{t('聊天表情')}</h1>}
      <Button onClick={() => edit()}>{t('添加聊天表情')}</Button>
    </div>
    {issue && <p className="warning" role="alert">{issue}</p>}
    {draft && <form className="card" onSubmit={(event) => void save(event)}>
      <h2>{t(existing ? '编辑表情' : '添加聊天表情')}</h2>
      <div className="two-column">
        <label className="field"><span>{t('表情编号')}</span>
          <input required pattern={'[a-z][a-z0-9_\\-]{0,39}'} disabled={existing} value={draft.key} placeholder="hello"
            onChange={(event) => setDraft({ ...draft, key: event.target.value })} />
        </label>
        <label className="field"><span>{t('表情名称')}</span>
          <input required maxLength={80} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
        </label>
      </div>
      <label className="field"><span>{t('适用语境')}</span>
        <textarea required maxLength={300} value={draft.meaning} onChange={(event) => setDraft({ ...draft, meaning: event.target.value })} />
      </label>
      <label className="field"><span>{t('表情图片')}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" required={!existing}
          onChange={(event) => setFile(event.target.files?.[0])} />
      </label>
      <label className="inline-toggle"><input type="checkbox" checked={draft.enabled}
        onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />{t('允许角色使用')}</label>
      <div className="row wrap">
        <Button type="submit" disabled={pending}>{t('保存')}</Button>
        <Button secondary onClick={() => setDraft(null)}>{t('取消')}</Button>
      </div>
    </form>}
    {!items.length && !draft && <p className="card">{t('这个角色还没有聊天表情。')}</p>}
    {items.map((item) => <article className="card chatstick-entry" key={item.key}>
      <ReplyImageView image={item.image} />
      <div><h3>{item.label}</h3><p>{item.meaning}</p><small>{item.key} · {t(item.enabled ? '已启用' : '已停用')}</small></div>
      <div className="row wrap">
        <Button secondary onClick={() => edit(item)}>{t('编辑')}</Button>
        <Button secondary onClick={async () => {
          if (!await confirm({ title: t('移除聊天表情'), description: item.label })) return;
          try { await rpc('chatstick.remove', { personaId, key: item.key }); await load(); }
          catch (error) { setIssue((error as Error).message); }
        }}>{t('移除')}</Button>
      </div>
    </article>)}
  </>;
}
