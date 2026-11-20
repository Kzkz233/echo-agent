import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { t } from './i18n.ts';

type State = 'on' | 'off' | 'disabled' | 'conflict' | 'unsupported';

export function LoginStartup() {
  const [state, setState] = useState<State>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void invoke<State>('login_startup').then(value => { if (active) setState(value); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);
  async function change(enabled: boolean) {
    setBusy(true);
    setError('');
    try { setState(await invoke<State>('login_startup', { enabled })); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  if (state === 'unsupported') return null;
  return <section className="card stack">
    <label><input type="checkbox" disabled={!state || state === 'conflict' || busy}
      checked={state === 'on' || state === 'disabled'} onChange={e => void change(e.target.checked)} />
      {' '}{t('登录 Windows 后启动 Echo')}</label>
    <small>{t('登录后在系统托盘运行，点击托盘图标可打开主窗口。')}</small>
    {state === 'disabled' && <p className="warning">{t('Windows 已禁用这个启动项，可在系统的「启动应用」中重新启用。')}</p>}
    {state === 'conflict' && <p className="warning">{t('此启动项由另一份 Echo 安装或数据目录使用。')}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
