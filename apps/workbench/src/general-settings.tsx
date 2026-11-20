import { useEffect, useState } from 'react';
import { defaultNetworkSettings, networkSettings, type NetworkSettings } from '../../../packages/contracts/network-settings.ts';
import type { Connection } from '../../../packages/contracts/inference.ts';
import { LoginStartup } from './login-startup.tsx';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, useUnsavedChanges } from './ui.tsx';

export function GeneralSettings({ connections }: { connections: Connection[] }) {
  const [saved, setSaved] = useState<NetworkSettings>();
  const [mode, setMode] = useState<NetworkSettings['mode']>(defaultNetworkSettings.mode);
  const [proxy, setProxy] = useState('');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  const [message, setMessage] = useState('');
  const services = connections.filter(c => ['core.api', 'core.pi'].includes(c.adapterId));
  const [service, setService] = useState('');
  const selected = services.some(c => c.id === service) ? service : services[0]?.id;
  function display(value: NetworkSettings) {
    setSaved(value);
    setMode(value.mode);
    if (value.mode === 'manual') setProxy(value.proxy);
  }
  useEffect(() => {
    let active = true;
    void rpc<NetworkSettings>('network.settings').then(value => { if (active) display(value); })
      .catch(error => { if (active) setIssue(error.message); });
    return () => { active = false; };
  }, []);
  const parsed = networkSettings.safeParse(mode === 'manual' ? {mode, proxy} : {mode});
  const changed = !!saved && (!parsed.success || JSON.stringify(saved) !== JSON.stringify(parsed.data));
  useUnsavedChanges(changed, '网络代理');
  async function submit(test: boolean) {
    setBusy(true); setMessage(''); setIssue('');
    try {
      if (test) {
        if (!selected || changed) return;
        const result = await rpc('connections.test', {id:selected, generation:false});
        if (!result.ok || result.verified !== 'upstream') throw Error(t('无法验证模型目录。'));
        setMessage(t('模型目录连接成功。'));
      } else if (parsed.success && saved) {
        display(await rpc<NetworkSettings>('network.save', {settings:parsed.data, expected:saved}));
        setMessage(t('已保存，下次请求生效。'));
      }
    } catch (error) { setIssue((error as Error).message); }
    finally { setBusy(false); }
  }
  const resetFeedback = () => { setIssue(''); setMessage(''); };
  return <div className="stack">
    <header className="page-heading"><h1>{t('常规')}</h1></header>
    {("__TAURI_INTERNALS__" in window) && <LoginStartup />}
    <section className="card stack">
      <details className="setup-capability"><summary>{t('网络代理')} · {t(mode === 'system' ? '跟随系统' : mode === 'manual' ? '手动代理' : '直接连接')}</summary>
      <p className="muted">{t('内置模型服务共用此设置，适用于聊天、后台任务、上下文压缩和向量请求。本机回环地址始终直连。')}</p>
      <label className="field"><span>{t('模型连接方式')}</span>
        <select disabled={!saved || busy} value={mode} onChange={e => {setMode(e.target.value as NetworkSettings['mode']); resetFeedback();}}>
          <option value="system">{t('跟随系统')}</option><option value="direct">{t('直接连接')}</option><option value="manual">{t('手动代理')}</option>
        </select>
      </label>
      {mode === 'system' && <p className="muted">{t('优先使用 HTTP(S) 代理环境变量，Windows 桌面也支持系统自动代理规则（PAC）。')}</p>}
      {mode === 'manual' && <label className="field"><span>{t('代理地址')}</span>
        <input value={proxy} disabled={busy} placeholder="http://127.0.0.1:7890" onChange={e => {setProxy(e.target.value); resetFeedback();}}/>
        <small>{t('填写 HTTP 或 HTTPS 代理的地址和端口。')}</small>
      </label>}
      {mode === 'manual' && proxy && !parsed.success && <p className="warning">{t('请输入有效的 HTTP 或 HTTPS 代理地址。')}</p>}
      <div><Button disabled={!changed || !parsed.success || busy} onClick={() => submit(false)}>{t('保存设置')}</Button></div>
      {!!services.length && <div className="row wrap"><label className="field"><span>{t('验证模型服务')}</span>
        <select value={selected} disabled={busy} onChange={e => {setService(e.target.value); resetFeedback();}}>
          {services.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label><Button secondary disabled={busy || changed || !saved} onClick={() => submit(true)}>{t('测试连接')}</Button></div>}
      {message && <p role="status">{message}</p>}{issue && <p role="alert" className="warning">{issue}</p>}
      </details>
    </section>
  </div>;
}
