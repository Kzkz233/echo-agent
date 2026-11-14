import { t } from './i18n.ts';
import { Children, useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mediaURL } from './client.ts';
function ManagedAsset({ vaultId, hash, attachments, alt, autoLoad = true, start }: any) {
  const asset = attachments?.find((a: any) => a.hash === hash),
    [url, setURL] = useState(''),
    [error, setError] = useState('');
  const load = () =>
    mediaURL(vaultId, hash)
      .then(setURL)
      .catch((e) => setError(e.message));
  useEffect(() => {
    setURL('');
    if (autoLoad && asset?.mediaType.startsWith('image/')) void load();
  }, [vaultId, hash]);
  if (!asset)
    return (
      <span className="muted">
        {t('[Unregistered attachment:')} {alt || hash.slice(0, 12)}]
      </span>
    );
  if (!url)
    return (
      <span>
        <button onClick={() => void load()}>{alt || `${t('Load')} ${asset.name}`}</button>
        {error && <small>{error}</small>}
      </span>
    );
  if (asset.mediaType.startsWith('image/'))
    return (
      <img
        src={url}
        alt={alt || asset.name}
        loading="lazy"
        onError={() => {
          setError(t('Open again to renew access'));
          setURL('');
        }}
      />
    );
  const seek = (event: any) => {
    if (start !== undefined) {
      event.currentTarget.currentTime = start;
      void event.currentTarget.play().catch(() => {});
    }
  };
  if (asset.mediaType.startsWith('audio/'))
    return <audio src={url} controls preload="metadata" onLoadedMetadata={seek} />;
  if (asset.mediaType.startsWith('video/'))
    return <video src={url} controls preload="metadata" onLoadedMetadata={seek} />;
  return (
    <a href={url} download={asset.name}>
      {alt || asset.name}
    </a>
  );
}
export default function KnowledgeBody({ document, onOpenEntry }: any) {
  const [raw, setRaw] = useState(false),
    asset = (uri: string, alt?: string) => {
      const [hash, fragment] = uri.slice('echo-asset:'.length).split('#t=');
      const start =
        fragment !== undefined && /^\d+(?:\.\d+)?$/.test(fragment) && Number(fragment) <= 86400
          ? Number(fragment)
          : undefined;
      return (
        <ManagedAsset
          vaultId={document.vaultId}
          hash={hash}
          attachments={[
            ...(document.attachments ?? []),
            ...(document.original ? [document.original] : []),
          ]}
          alt={alt}
          start={start}
        />
      );
    };
  const displayed = document.content.replace(
    /^# ([^\r\n]+)\r?\n(?:\r?\n)?/,
    (match: string, title: string) => (title.trim() === document.title.trim() ? '' : match),
  );
  return (
    <>
      <button className="text-button markdown-toggle" onClick={() => setRaw(!raw)}>
        {raw ? t('Markdown preview') : t('Markdown source')}
      </button>
      {document.assessment?.state === 'empty' && <p className="muted">{document.assessment.reason === 'no_audio' ? t('原件没有音轨') : t('未检测到可转录语音')}{' · '}{t('原件仍可播放和检索')}</p>}
      {document.assessment?.state === 'needs_review' && <p className="muted">{t('部分转录待核对，可疑文字未纳入检索')}</p>}
      {!document.content.trim() && /^(audio|video)\//.test(document.original?.mediaType ?? '') && asset(`echo-asset:${document.original.hash}`, document.original.name)}
      {document.timeRange && asset(`echo-asset:${document.timeRange.sourceHash}#t=${document.timeRange.start}`,t('播放命中片段'))}
      {document.evidence && <details className="knowledge-attachments"><summary>{t('命中证据与上级内容')}{document.evidence.node.page ? ` · ${t('页码')} ${document.evidence.node.page}` : ''}</summary>
        <p className="preserve-lines">{document.evidence.node.text}</p>
        {document.evidence.parent?.text && <blockquote className="preserve-lines">{document.evidence.parent.text}</blockquote>}
      </details>}
      {document.attachments?.length > 0 && (
        <details className="knowledge-attachments">
          <summary>
            {t('附件')} · {document.attachments.length}
          </summary>
          {document.attachments.map((a: any) => (
            <div className="knowledge-attachment" key={a.id}>
              <ManagedAsset
                vaultId={document.vaultId}
                hash={a.hash}
                attachments={document.attachments}
                alt={a.name}
                autoLoad={false}
              />
              <small>{(a.bytes / 1024).toFixed(0)} KB</small>
            </div>
          ))}
        </details>
      )}
      {raw ? (
        <pre>{document.content}</pre>
      ) : (
        <div className="markdown-body">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            urlTransform={(uri) =>
              /^(echo-asset:[a-f0-9]{64}|echo-entry:[\w.-]+\/[\w.-]+$|https?:\/\/|mailto:|#)/.test(
                uri,
              )
                ? uri
                : ''
            }
            components={{
              img: ({ src, alt }) =>
                typeof src === 'string' && src.startsWith('echo-asset:') ? (
                  asset(src, alt)
                ) : (
                  <span className="muted">
                    {t('[External image:')} {alt}]
                  </span>
                ),
              a: ({ href, children }) =>
                href?.startsWith('echo-asset:') ? (
                  asset(
                    href,
                    Children.toArray(children)
                      .filter((child) => typeof child === 'string' || typeof child === 'number')
                      .join('') || undefined,
                  )
                ) : href?.startsWith('echo-entry:') ? (
                  <button
                    className="knowledge-link"
                    onClick={() => {
                      const [vaultId, documentId] = href.slice('echo-entry:'.length).split('/');
                      onOpenEntry({ vaultId, documentId });
                    }}
                  >
                    {children}
                  </button>
                ) : (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
            }}
          >
            {displayed}
          </Markdown>
        </div>
      )}
    </>
  );
}
