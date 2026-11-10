import { useRef, useState, useEffect } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button } from './ui.tsx';
export function CharacterPortrait({ persona, className = '' }: any) {
  return persona?.portrait ? (
    <img className={'character-portrait ' + className} src={persona.portrait} alt="" />
  ) : (
    <span className={className}>{(persona?.name ?? 'E').slice(0, 1)}</span>
  );
}
export function PortraitEditor({ persona, onChange }: any) {
  const file = useRef<HTMLInputElement>(null),
    version = useRef(0),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState('');
  const apply = useRef(onChange);
  apply.current = onChange;
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  return (
    <div className="portrait-editor">
      <CharacterPortrait persona={persona} className="portrait-preview" />
      <div className="row wrap">
        <Button secondary disabled={busy} onClick={() => file.current?.click()}>
          {t(persona.portrait ? '更换头像' : '导入头像')}
        </Button>
        {persona.portrait && (
          <Button secondary disabled={busy} onClick={() => onChange(undefined)}>
            {t('移除头像')}
          </Button>
        )}
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          hidden
          aria-label={t('头像图片')}
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            if (!selected) return;
            const current = ++version.current;
            setBusy(true);
            setIssue('');
            try {
              if (selected.size > 5500000) throw Error(t('请选择小于 5 MB 的头像图片。'));
              const data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(Error(t('图片读取失败')));
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.readAsDataURL(selected);
              });
              const result = await rpc('persona.portrait.prepare', { data });
              if (current === version.current) apply.current(result.portrait);
            } catch (error) {
              if (current === version.current) setIssue((error as Error).message);
            } finally {
              if (current === version.current) setBusy(false);
            }
          }}
        />
      </div>
      {issue && (
        <p className="warning" role="alert">
          {issue}
        </p>
      )}
    </div>
  );
}
