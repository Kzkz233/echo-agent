import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { Button, PathInput, useConfirm } from './ui.tsx';
import { t } from './i18n.ts';
export function StorageSettings({ act }: any) {
  const [status, setStatus] = useState<any>(), [destination, setDestination] = useState(''), [plan, setPlan] = useState<any>();
  const confirm = useConfirm();
  const refresh = () => rpc('storage.status').then(setStatus);
  useEffect(() => { void refresh(); }, []);
  return <section className="storage-settings">
    <label className="field"><span>{t('当前数据目录')}</span><input readOnly value={status?.root ?? ''} /></label>
    {status?.migration?.state === 'pending' && <div className="card"><p>{t('待执行迁移')} · {status.migration.destination}</p>
      <Button secondary onClick={() => act(async () => { await rpc('storage.cancel'); await refresh(); setPlan(undefined); }, t('已取消数据迁移'))}>{t('取消迁移')}</Button></div>}
    {status?.migration?.state === 'failed' && <p className="warning">{t('上次迁移未完成，仍使用原数据目录。')} {status.migration.error}</p>}
    <p className="muted">{t('迁移包含会话、设置、凭据与受管文件；外部资料和项目保留原位置。')}</p>
    <PathInput directory label={t('新的数据目录')} value={destination} onChange={(value: string) => { setDestination(value); setPlan(undefined); }} />
    <div className="form-actions"><Button secondary disabled={!destination} onClick={() => act(async () => setPlan(await rpc('storage.plan', { destination })))}>{t('检查迁移')}</Button></div>
    {plan && <div className="card"><p>{t('待复制')} · {plan.files} {t('个文件')} · {(plan.bytes / 1024 / 1024).toFixed(1)} MB</p>
      <p>{t('完整重启后复制并校验，成功后切换位置。原数据保留，可回退；当前位置不立即改变。')}</p>
      <Button onClick={async () => { if (await confirm({ title: t('迁移应用数据？'), description: <code>{plan.destination}</code>, confirmLabel: t('登记迁移') }))
        await act(async () => { await rpc('storage.migrate', { destination: plan.destination, confirmed: true }); await refresh(); setPlan(undefined); }, t('已登记，下次完整重启时迁移')); }}>{t('登记迁移')}</Button>
    </div>}
  </section>;
}
export function PluginPackageInstaller({ act }: any) {
  const [path, setPath] = useState(''), [preview, setPreview] = useState<any>();
  const confirm = useConfirm();
  return <section className="card"><h3>{t('安装插件包')}</h3>
    <PathInput label={t('插件包（.echo-plugin）')} value={path} onChange={(value: string) => { setPath(value); setPreview(undefined); }} />
    <Button secondary disabled={!path} onClick={() => act(async () => setPreview(await rpc('plugins.package.inspect', { path })))}>{t('检查插件包')}</Button>
    {preview && <><h4>{preview.manifest.name} · {preview.manifest.version}</h4><p>{preview.manifest.description}</p>
      <p>{t('所需权限')} · {preview.manifest.permissions.join(', ') || t('无')}</p>
      {!!preview.missingDependencies.length && <p>{t('待安装依赖')} · {preview.missingDependencies.join(', ')}</p>}
      <Button onClick={async () => { if (await confirm({ title: t('安装此插件包？'), description: t('插件可运行本机代码。文件校验保证包的完整性，不证明发布者身份。'), confirmLabel: t('信任并安装') }))
        await act(() => rpc('plugins.package.install', { path, sha256: preview.sha256, confirmed: true }), t('插件包已安装，更新在完整重启后生效')); }}>{t('安装插件包')}</Button></>}
  </section>;
}
