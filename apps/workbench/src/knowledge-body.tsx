import { t } from './i18n.ts';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mediaURL } from './client.ts';
function ManagedAsset({ vaultId, hash, attachments, alt, autoLoad = true }: any) {
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
        <button onClick={() => void load()}>
          {t('Load')} {asset.name}
        </button>
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
  if (asset.mediaType.startsWith('audio/')) return <audio src={url} controls preload="metadata" />;
  if (asset.mediaType.startsWith('video/')) return <video src={url} controls preload="metadata" />;
  return (
    <a href={url} download={asset.name}>
      {alt || asset.name}
    </a>
  );
}
export default function KnowledgeBody({ document, onOpenEntry }: any) {
  const [raw, setRaw] = useState(false),
    asset = (uri: string, alt?: string) => (
      <ManagedAsset
        vaultId={document.vaultId}
        hash={uri.slice('echo-asset:'.length)}
        attachments={document.attachments}
        alt={alt}
      />
    );
  const displayed = document.content.replace(
    /^# ([^\r\n]+)\r?\n(?:\r?\n)?/,
    (match: string, title: string) => (title.trim() === document.title.trim() ? '' : match),
  );
  return (
    <>
      <button className="text-button markdown-toggle" onClick={() => setRaw(!raw)}>
        {raw ? t('Markdown preview') : t('Markdown source')}
      </button>
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
                  asset(href, typeof children === 'string' ? children : undefined)
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
