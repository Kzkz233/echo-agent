import { useEffect, useState, useRef } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, PathInput, useUnsavedChanges, requestNavigation } from './ui.tsx';
export default function AvatarAssets({ data, act, builtin, personaId, onSelect }: any) {
  const [libraries, setLibraries] = useState<any[]>([]);
  useEffect(() => {
    void rpc<any[]>('avatar.materials')
      .then(setLibraries)
      .catch(() => {});
  }, [data.providers]);
  const custom = libraries.find((item) => item.renderer === data.avatarConfig.renderer);
  const family = custom?.family ?? 'avatar';
  const configured = data.avatarConfig[custom?.directoryField ?? 'assetDirectory'] ?? '';
  const [assets, setAssets] = useState<any[]>([]),
    [materialPreview, setMaterialPreview] = useState<any>(),
    [selected, setSelected] = useState(''),
    [importing, setImporting] = useState(false),
    [source, setSource] = useState(''),
    [directory, setDirectory] = useState(false),
    [name, setName] = useState(''),
    [fps, setFPS] = useState(10),
    [issue, setIssue] = useState('');
  useUnsavedChanges(importing && Boolean(source || name), '桌宠素材导入');
  const loadVersion = useRef(0);
  const load = async () => {
    const n = ++loadVersion.current;
    const list = await rpc(family + '.assets');
    if (n !== loadVersion.current) return;
    setAssets(list);
    setSelected((old) =>
      old === 'external'
        ? (list.find((a: any) => a.directory === configured)?.id ?? 'external')
        : old,
    );
  };
  useEffect(() => {
    void load().catch((e) => setIssue(e.message));
    const listener = (event: any) => {
      if (event.detail.type === 'avatar.assets.changed')
        void load().catch((e) => setIssue(e.message));
    };
    window.addEventListener('echo-event', listener);
    return () => {
      loadVersion.current++;
      window.removeEventListener('echo-event', listener);
    };
  }, [family, configured]);
  useEffect(() => {
    if (!configured) setSelected('');
    else setSelected(assets.find((a) => a.directory === configured)?.id ?? 'external');
  }, [configured]);
  useEffect(() => {
    if (!custom || !['', 'external'].includes(selected)) return;
    let current = true;
    setMaterialPreview(undefined);
    void rpc(family + '.preview', {
      source: selected === 'external' ? 'current' : 'builtin',
      personaId,
    })
      .then((value) => {
        if (current) setMaterialPreview(value);
      })
      .catch((e) => {
        if (current) setIssue(e.message);
      });
    return () => {
      current = false;
    };
  }, [custom, selected, configured]);
  const asset = assets.find((a) => a.id === selected),
    active = selected === '' ? !configured : asset?.directory === configured;
  const details = asset ?? materialPreview,
    preview = asset?.preview ?? materialPreview?.preview;
  return (
    <>
      <div className="avatar-material-preview">
        {preview ? (
          <img src={preview} alt={asset?.name ?? t('素材预览')} />
        ) : custom ? (
          <span>{t('正在读取素材')}</span>
        ) : selected === 'external' ? (
          <span>{t('当前使用外部素材目录')}</span>
        ) : (
          builtin
        )}
      </div>
      <div className="material-format">
        <strong>{custom ? t(custom.label) : t('帧动画素材')}</strong>
        <code>{custom ? custom.format : 'frame-atlas-v1'}</code>
      </div>
      <label className="field">
        <span>{custom ? t(custom.label) : t('帧动画素材')}</span>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">{custom ? t(custom.builtinLabel) : t('Cute Girl · 内置帧动画')}</option>
          {assets.map((a) => (
            <option value={a.id} key={a.id}>
              {a.name}
            </option>
          ))}
          {selected === 'external' && <option value="external">{t('外部素材目录')}</option>}
        </select>
      </label>
      <p className="muted">
        {details
          ? `${details.frames ? details.frames + ' ' + t('帧') + ' · ' : ''}${details.fps} FPS${details.author ? ' · ' + details.author : ''}${details.license ? ' · ' + details.license : ''}`
          : selected === 'external'
            ? ''
            : t('pzUH · CC0-1.0')}
      </p>
      <div className="row wrap">
        <Button
          disabled={active || selected === 'external'}
          onClick={() =>
            act(
              () =>
                onSelect
                  ? onSelect(
                      custom
                        ? {
                            renderer: custom.renderer,
                            [custom.directoryField]: asset?.directory ?? '',
                            ...(custom.configurationField
                              ? {
                                  extensionConfiguration: {
                                    id: custom.family,
                                    field: custom.configurationField,
                                    value: asset?.directory ?? '',
                                  },
                                }
                              : {}),
                          }
                        : { renderer: 'frames', assetDirectory: asset?.directory ?? '' },
                    )
                  : rpc(family + '.select', { id: asset?.id ?? '', personaId }),
              t('桌宠素材已切换'),
            )
          }
        >
          {active ? t('正在使用') : t('使用此素材')}
        </Button>
        <Button
          secondary
          onClick={() =>
            requestNavigation(() => {
              if (importing) {
                setSource('');
                setName('');
              }
              setImporting(!importing);
            })
          }
        >
          {custom ? t('导入素材') : t('导入帧动画素材')}
        </Button>
      </div>
      {importing && (
        <form
          className="avatar-import-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await act(
              () =>
                rpc(family + '.import', {
                  source,
                  name: name || undefined,
                  ...(!custom ? { fps } : {}),
                  requestId: crypto.randomUUID(),
                }),
              t('桌宠素材已导入'),
            );
            if (result) {
              await load();
              setSelected(result.id);
              setSource('');
              setName('');
              setImporting(false);
            }
          }}
        >
          {!custom && (
            <div className="row wrap">
              <label className="inline-toggle">
                <input
                  type="radio"
                  name="avatar-source-type"
                  checked={!directory}
                  onChange={() => {
                    setDirectory(false);
                    setSource('');
                  }}
                />
                {t('图片或 ZIP 素材包')}
              </label>
              <label className="inline-toggle">
                <input
                  type="radio"
                  name="avatar-source-type"
                  checked={directory}
                  onChange={() => {
                    setDirectory(true);
                    setSource('');
                  }}
                />
                {t('PNG 帧或图集目录')}
              </label>
            </div>
          )}
          {custom && <p className="material-hint">{custom.hint}</p>}
          {custom && (
            <label className="inline-toggle">
              <input
                type="checkbox"
                checked={directory}
                onChange={(e) => {
                  setDirectory(e.target.checked);
                  setSource('');
                }}
              />
              {t('选择素材目录')}
            </label>
          )}
          <label className="field">
            <span>{t('素材来源')}</span>
            <PathInput
              label={t('桌宠素材来源')}
              directory={directory}
              value={source}
              onChange={setSource}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>{t('素材名称')}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {!custom && (
              <label className="field">
                <span>{t('帧序列播放速度')}</span>
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={fps}
                  onChange={(e) => setFPS(Number(e.target.value))}
                />
              </label>
            )}
          </div>
          <Button type="submit" disabled={!source.trim()}>
            {t('导入素材')}
          </Button>
        </form>
      )}
      {issue && <p className="warning">{issue}</p>}
    </>
  );
}
