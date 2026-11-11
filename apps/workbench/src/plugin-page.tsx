import { useEffect, useRef, useState } from 'react';
import type { FrontendPageEntry } from '../../../packages/contracts/frontend.ts';
import { rpc, extensionURL } from './client.ts';
import { Button, EmptyState, sameData, useUnsavedChanges, requestNavigation } from './ui.tsx';
import { t } from './i18n.ts';

export function PluginPage({
  page,
  personaId,
  act,
  popout,
  navigate,
  embedded = false,
}: {
  page: FrontendPageEntry;
  personaId?: string;
  navigate?: (page: string, selected?: string, selection?: any) => void;
  act: (fn: () => Promise<any>, message?: string) => Promise<any>;
  popout?: () => void;
  embedded?: boolean;
}) {
  const [content, setContent] = useState<{ page: FrontendPageEntry; html?: string }>();
  const [value, setValue] = useState<Record<string, any>>({});
  const [issue, setIssue] = useState('');
  const [revision, refresh] = useState(0);
  const base = useRef<Record<string, any>>({});
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState('');
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty, page.title);
  const contextKey = page.id + ':' + (personaId ?? '');
  useUnsavedChanges(page.view.type === 'form' && !sameData(value, base.current), page.title);
  useEffect(() => {
    let active = true;
    setContent(undefined);
    setIssue('');
    setSrc('');
    void (async () => {
      const data = await rpc<{ page: FrontendPageEntry; html?: string }>('frontend.content', {
        id: page.id,
      });
      if (!active) return;
      if (data.page.view.type === 'form') {
        const loaded = await rpc('frontend.invoke', {
          pageId: page.id,
          operation: data.page.view.load,
          input: {},
          personaId,
        });
        if (!active) return;
        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded))
          throw Error(t('插件表单没有返回有效数据。'));
        base.current = loaded;
        setValue(loaded);
      }
      if (active) setContent(data);
    })().catch((error) => {
      if (active) setIssue(error.message);
    });
    return () => {
      active = false;
    };
  }, [contextKey, revision]);
  useEffect(() => {
    if (content?.page.view.type !== 'webview' || !content.html) return;
    let active = true,
      pending = 0;
    const bridge = crypto.randomUUID();
    const view = content.page.view;
    void rpc<{ ticket: string }>('frontend.mount', { id: page.id, bridge, personaId })
      .then(({ ticket }) => {
        if (active) setSrc(extensionURL(ticket));
      })
      .catch((error) => {
        if (active) setIssue(error.message);
      });
    const receive = async (event: MessageEvent) => {
      const data = event.data;
      if (
        !active ||
        event.source !== frame.current?.contentWindow ||
        !['echo:call', 'echo:host'].includes(data?.type) ||
        data.bridge !== bridge ||
        !Number.isSafeInteger(data.id)
      )
        return;
      const reply = (body: object) => {
        if (active)
          frame.current?.contentWindow?.postMessage(
            { type: 'echo:result', bridge, id: data.id, ...body },
            '*',
          );
      };
      if (
        pending >= 32 ||
        (data.type === 'echo:call' &&
          (typeof data.operation !== 'string' || !view.operations.includes(data.operation)))
      ) {
        reply({ error: t('页面未声明此操作。') });
        return;
      }
      pending++;
      try {
        if (JSON.stringify(data.input)?.length > 1_000_000)
          throw Error(t('页面请求超过大小限制。'));
        if (data.type === 'echo:host') {
          const input = data.input ?? {};
          if (data.method === 'pickPath') {
            if (!('__TAURI_INTERNALS__' in window)) throw Error(t('请粘贴本地文件路径。'));
            const dialog = await import('@tauri-apps/plugin-dialog');
            const options = {
              title: String(input.label ?? page.title).slice(0, 200),
              defaultPath: typeof input.value === 'string' ? input.value : undefined,
            };
            reply({
              result: input.save
                ? await dialog.save(options)
                : await dialog.open({
                    ...options,
                    directory: input.directory === true,
                    multiple: false,
                  }),
            });
          } else if (data.method === 'navigate') {
            if (typeof input.page !== 'string') throw Error('Invalid page');
            requestNavigation(() => navigate?.(input.page, input.selected, input.selection));
            reply({ result: true });
          } else if (data.method === 'dirty') {
            setDirty(input.dirty === true);
            reply({ result: true });
          } else if (data.method === 'media') {
            const grant = await rpc('frontend.invoke', {
              pageId: page.id,
              operation: 'files.media',
              input,
              personaId,
            });
            const response = await fetch(
              extensionURL('').replace(/\/extension-view\/$/, '') +
                '/media/' +
                encodeURIComponent(grant.ticket),
            );
            if (!response.ok) throw Error('Media unavailable');
            const blob = await response.blob();
            if (blob.size > 32_000_000) throw Error('Media too large');
            const result = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            reply({ result });
          } else throw Error('Unsupported page request');
          return;
        }
        const result = await rpc('frontend.invoke', {
          pageId: page.id,
          operation: data.operation,
          input: data.input,
          personaId,
        });
        reply({ result });
      } catch (error) {
        reply({ error: (error as Error).message });
      } finally {
        pending--;
      }
    };
    addEventListener('message', receive);
    const changed = (event: Event) =>
      frame.current?.contentWindow?.postMessage(
        { type: 'echo:event', bridge, event: (event as CustomEvent).detail },
        '*',
      );
    addEventListener('echo-event', changed);
    return () => {
      active = false;
      setDirty(false);
      removeEventListener('message', receive);
      removeEventListener('echo-event', changed);
    };
  }, [content, contextKey]);
  const view = content?.page.view;
  const frameless = view?.type === 'webview' && view.frameless;
  return (
    <section
      className={'plugin-page' + (frameless ? ' plugin-page-full' : '')}
      data-plugin-page={page.id}
    >
      {!frameless && (
        <div className="page-title page-title-actions">
          {embedded ? <h3>{page.title}</h3> : <h1>{page.title}</h1>}
          <div className="row">
            <Button secondary onClick={() => requestNavigation(() => refresh((n) => n + 1))}>
              {t('刷新')}
            </Button>
            {popout && (
              <Button secondary onClick={popout}>
                {t('在独立窗口打开')}
              </Button>
            )}
          </div>
        </div>
      )}
      {issue ? (
        <p className="error" role="alert">
          {issue}
        </p>
      ) : !view ? (
        <EmptyState>{t('正在打开…')}</EmptyState>
      ) : view.type === 'webview' ? (
        <iframe
          key={contextKey}
          ref={frame}
          className="plugin-webview"
          title={page.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={src || undefined}
        />
      ) : (
        <form
          className="card"
          onSubmit={(event) => {
            event.preventDefault();
            if (view.save)
              void act(async () => {
                const saved = await rpc('frontend.invoke', {
                  pageId: page.id,
                  operation: view.save,
                  input: value,
                  personaId,
                });
                base.current = value;
                return saved;
              });
          }}
        >
          <div className="form-grid">
            {view.fields.map((field) => (
              <label
                className={field.type === 'boolean' ? 'inline-toggle' : 'field'}
                key={field.key}
              >
                <span>{field.label}</span>
                {field.type === 'textarea' ? (
                  <textarea
                    value={value[field.key] ?? ''}
                    readOnly={!view.save}
                    onChange={(event) => setValue({ ...value, [field.key]: event.target.value })}
                  />
                ) : field.type === 'select' ? (
                  <select
                    value={value[field.key] ?? ''}
                    disabled={!view.save}
                    onChange={(event) => setValue({ ...value, [field.key]: event.target.value })}
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={
                      field.type === 'boolean'
                        ? 'checkbox'
                        : field.type === 'number'
                          ? 'number'
                          : 'text'
                    }
                    min={field.min}
                    max={field.max}
                    value={field.type === 'boolean' ? undefined : (value[field.key] ?? '')}
                    checked={field.type === 'boolean' ? Boolean(value[field.key]) : undefined}
                    disabled={!view.save}
                    onChange={(event) =>
                      setValue({
                        ...value,
                        [field.key]:
                          field.type === 'boolean'
                            ? event.target.checked
                            : field.type === 'number'
                              ? Number(event.target.value)
                              : event.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))}
          </div>
          {view.save && (
            <div className="form-actions">
              <Button type="submit">{t('保存')}</Button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
