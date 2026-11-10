import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
export function CredentialInput({ label, reference = '', value, onChange }: { label: string; reference?: string; value: string; onChange: (value: string) => void }) {
  const [status, setStatus] = useState<{ configured: boolean; source?: string }>();
  useEffect(() => {
    let active = true; setStatus(undefined);
    if (reference) void rpc('credentials.status', { reference }).then((result) => { if (active) setStatus(result); }).catch(() => {});
    return () => { active = false; };
  }, [reference, value === '']);
  return <label className="field"><span>{label}</span>
    <input type="password" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)}
      placeholder={status?.configured ? t('已配置，留空保留') : reference && !status ? t('正在检查凭据') : t('输入凭据')} />
    {status?.source?.startsWith('env:') && <small>{t('凭据来源')} · {status.source}</small>}
  </label>;
}
