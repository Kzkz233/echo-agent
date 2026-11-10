import { useEffect, useRef, useState } from 'react';
import type { FrontendPageEntry } from '../../../packages/contracts/frontend.ts';
import { rpc, extensionURL } from './client.ts';
import { Button, EmptyState, sameData, useUnsavedChanges, requestNavigation } from './ui.tsx';
import { t } from './i18n.ts';

export function PluginPage({ page, personaId, act, popout, embedded = false }: { page: FrontendPageEntry; personaId?: string;
  act: (fn: () => Promise<any>, message?: string) => Promise<any>; popout?: () => void; embedded?: boolean }) {
  const [content, setContent] = useState<{ page: FrontendPageEntry; html?: string }>();
  const [value, setValue] = useState<Record<string, any>>({});
  const [issue, setIssue] = useState('');
  const [revision, refresh] = useState(0);
  const base = useRef<Record<string, any>>({});
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState('');
  const contextKey = page.id + ':' + (personaId ?? '');
  useUnsavedChanges(page.view.type === 'form' && !sameData(value, base.current), page.title);
  useEffect(() => {
    let active = true;
    setContent(undefined); setIssue(''); setSrc('');
    void (async () => {
      const data = await rpc<{ page: FrontendPageEntry; html?: string }>('frontend.content', { id: page.id });
      if (!active) return;
      if (data.page.view.type === 'form') {
        const loaded = await rpc('frontend.invoke', { pageId: page.id, operation: data.page.view.load, input: {}, personaId });
        if (!active) return;
        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw Error(t('插件表单没有返回有效数据。'));
        base.current = loaded; setValue(loaded);
      }
      if (active) setContent(data);
    })().catch((error) => { if (active) setIssue(error.message); });
    return () => { active = false; };
  }, [contextKey, revision]);
  useEffect(() => {
    if (content?.page.view.type !== 'webview' || !content.html) return;
    let active = true, pending = 0;
    const bridge = crypto.randomUUID();
    const view = content.page.view;
    void rpc<{ ticket: string }>('frontend.mount', { id: page.id, bridge, personaId })
      .then(({ ticket }) => { if (active) setSrc(extensionURL(ticket)); })
      .catch((error) => { if (active) setIssue(error.message); });
    const receive = async (event: MessageEvent) => {
      const data = event.data;
      if (!active || event.source !== frame.current?.contentWindow || data?.type !== 'echo:call' || data.bridge !== bridge || !Number.isSafeInteger(data.id)) return;
      const reply = (body: object) => { if (active) frame.current?.contentWindow?.postMessage({ type: 'echo:result', bridge, id: data.id, ...body }, '*'); };
      if (typeof data.operation !== 'string' || !view.operations.includes(data.operation) || pending >= 32) { reply({ error: t('页面未声明此操作。') }); return; }
      pending++;
      try {
        if (JSON.stringify(data.input)?.length > 1_000_000) throw Error(t('页面请求超过大小限制。'));
        const result = await rpc('frontend.invoke', { pageId: page.id, operation: data.operation, input: data.input, personaId });
        reply({ result });
      } catch (error) { reply({ error: (error as Error).message }); }
      finally { pending--; }
    };
    addEventListener('message', receive);
    return () => { active = false; removeEventListener('message', receive); };
  }, [content, contextKey]);
  const view = content?.page.view;
  return <section className="plugin-page" data-plugin-page={page.id}>
    <div className="page-title page-title-actions">{embedded ? <h3>{page.title}</h3> : <h1>{page.title}</h1>}<div className="row">
      <Button secondary onClick={() => requestNavigation(() => refresh((n) => n + 1))}>{t('刷新')}</Button>
      {popout && <Button secondary onClick={popout}>{t('在独立窗口打开')}</Button>}
    </div></div>
    {issue ? <p className="error" role="alert">{issue}</p> : !view ? <EmptyState>{t('正在打开…')}</EmptyState> : view.type === 'webview' ?
      <iframe key={contextKey} ref={frame} className="plugin-webview" title={page.title} sandbox="allow-scripts" referrerPolicy="no-referrer" src={src || undefined} /> :
      <form className="card" onSubmit={(event) => { event.preventDefault(); if (view.save) void act(async () => {
        const saved = await rpc('frontend.invoke', { pageId: page.id, operation: view.save, input: value, personaId });
        base.current = value; return saved;
      }); }}>
        <div className="form-grid">{view.fields.map((field) => <label className={field.type === 'boolean' ? 'inline-toggle' : 'field'} key={field.key}>
          <span>{field.label}</span>
          {field.type === 'textarea' ? <textarea value={value[field.key] ?? ''} readOnly={!view.save} onChange={(event) => setValue({ ...value, [field.key]: event.target.value })} /> :
            field.type === 'select' ? <select value={value[field.key] ?? ''} disabled={!view.save} onChange={(event) => setValue({ ...value, [field.key]: event.target.value })}>
              {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select> : <input type={field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : 'text'}
              min={field.min} max={field.max} value={field.type === 'boolean' ? undefined : value[field.key] ?? ''}
              checked={field.type === 'boolean' ? Boolean(value[field.key]) : undefined} disabled={!view.save}
              onChange={(event) => setValue({ ...value, [field.key]: field.type === 'boolean' ? event.target.checked : field.type === 'number' ? Number(event.target.value) : event.target.value })} />}
        </label>)}</div>
        {view.save && <div className="form-actions"><Button type="submit">{t('保存')}</Button></div>}
      </form>}
  </section>;
}
