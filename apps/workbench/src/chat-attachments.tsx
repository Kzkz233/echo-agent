import { useEffect, useRef, useState } from 'react';
import { mediaURL, rpc } from './client.ts';
import { Button, PathInput, Icon } from './ui.tsx';
import { t } from './i18n.ts';
import type { Attachment } from '../../../packages/contracts/execution.ts';
import type { ReplyImage } from '../../../packages/contracts/index.ts';

export function ReplyImageView({ image }: { image: ReplyImage }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    setUrl('');
    void mediaURL(image.vaultId, image.hash).then((value) => {
      if (active) setUrl(value);
    }).catch(() => {});
    return () => { active = false; };
  }, [image.hash, image.vaultId]);
  return url ? <img className="chatstick-image" src={url} alt={image.label} loading="lazy" /> : null;
}
export function useChatAttachments(conversationId: string) {
  const [drafts, setDrafts] = useState<Record<string, Attachment[]>>({}),
    [issue, setIssue] = useState(''),
    [loading, setLoading] = useState(false);
  const upload = async (files: File[]) => {
    const target = conversationId;
    if (!target || loading) return;
    setIssue('');
    setLoading(true);
    try {
      if ((drafts[target]?.length ?? 0) + files.length > 4)
        throw Error(t('每条消息最多附加 4 个文件。'));
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024) throw Error(t('附件不能超过 8 MB'));
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const saved = await rpc('conversations.attach', {
          conversationId: target,
          name: file.name,
          mediaType: file.type || 'text/plain',
          data,
        });
        setDrafts((previous) => ({ ...previous, [target]: [...(previous[target] ?? []), saved] }));
      }
    } catch (error) {
      setIssue((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return {
    items: drafts[conversationId] ?? [],
    issue,
    loading,
    upload,
    remove: (id: string) =>
      setDrafts((old) => ({
        ...old,
        [conversationId]: (old[conversationId] ?? []).filter((item) => item.id !== id),
      })),
    clear: (target: string) => setDrafts((old) => ({ ...old, [target]: [] })),
    reference: async (path: string) => {
      const saved = await rpc('conversations.attachProjectFile', { conversationId, path });
      setDrafts((old) => ({ ...old, [conversationId]: [...(old[conversationId] ?? []), saved] }));
    },
  };
}
export function AttachmentControls({
  attachments,
  act,
  projectDirectory,
}: {
  attachments: ReturnType<typeof useChatAttachments>;
  act: any;
  projectDirectory?: string;
}) {
  const input = useRef<HTMLInputElement>(null),
    container = useRef<HTMLDivElement>(null),
    [reference, setReference] = useState(false),
    [path, setPath] = useState('');
  useEffect(() => {
    if (!reference) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setReference(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setReference(false); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [reference]);
  return (
    <div className="attachment-actions" ref={container}>
        <button
          type="button"
          className="composer-tool-button"
          aria-label={t('添加附件')}
          title={t(attachments.loading ? '正在添加…' : '添加附件')}
          aria-busy={attachments.loading}
          disabled={attachments.loading}
          onClick={() => input.current?.click()}
        >
          <Icon name="plus" size={19} />
        </button>
        <input
          hidden
          ref={input}
          type="file"
          multiple
          onChange={(e) => {
            void attachments.upload(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        {projectDirectory && (
          <button type="button" className="composer-tool-button" title={t('引用项目文件')}
            aria-label={t('引用项目文件')} aria-expanded={reference} onClick={() => setReference(!reference)}>
            <Icon name="files" size={17} />
          </button>
        )}
      {reference && (
        <div className="project-reference">
          <PathInput label={t('项目文件')} value={path} onChange={setPath} />
          <Button
            secondary
            disabled={!path || attachments.items.length >= 4}
            onClick={() =>
              act(async () => {
                await attachments.reference(path);
                setPath('');
                setReference(false);
              }, '')
            }
          >
            {t('附加引用')}
          </Button>
        </div>
      )}
    </div>
  );
}
