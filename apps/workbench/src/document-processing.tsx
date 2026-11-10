import { CredentialInput } from './credential-input.tsx';
import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t, statusText } from './i18n.ts';
import { Button, PathInput, useUnsavedChanges, sameData } from './ui.tsx';
export default function DocumentProcessing({ data, act }: any) {
  const [value, setValue] = useState<any>(data.pluginSettings.documents ?? {}),
    [provider, setProvider] = useState('documents.mineru-api'),
    [secret, setSecret] = useState(''),
    [status, setStatus] = useState<any>(),
    [tasks, setTasks] = useState<any[]>();
  const loadStatus = () => rpc('documents.status').then(setStatus);
  useEffect(() => {
    void loadStatus().catch(() => {});
  }, [data.pluginSettings.documents]);
  useUnsavedChanges(!!secret || !sameData(value, data.pluginSettings.documents ?? {}), '文档解析');
  const set = (key: string, v: any) => setValue({ ...value, [key]: v });
  return (
    <section className="card inference-form">
      <h2>{t('文档解析连接')}</h2>
      <p className="muted">
        {t('在这里管理共享解析连接；默认解析器与每次导入的解析方式在知识库中选择。')}
      </p>
      <label className="field">
        <span>{t('解析提供方')}</span>
        <select
          aria-label={t('解析提供方')}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          {data.providers
            .filter(
              (p: any) =>
                p.point === 'files.extract@1' && p.state === 'active' && p.owner === 'documents',
            )
            .map((p: any) => (
              <option value={p.id} key={p.id}>
                {t(p.label)}
              </option>
            ))}
        </select>
      </label>
      {provider === 'documents.local' ? (
        <p>{t('代码解析提取数字文档正文，不加载模型。')}</p>
      ) : provider === 'documents.mineru-api' ? (
        <div className="form-grid">
          <label className="field">
            <span>API Base URL</span>
            <input
              value={value.endpoint ?? 'https://mineru.net'}
              onChange={(e) => set('endpoint', e.target.value)}
            />
          </label>
          <CredentialInput label="API Token" reference={value.apiKeyRef ?? value.tokenRef ?? ''} value={secret} onChange={setSecret} />
          <label className="field">
            <span>{t('解析模型')}</span>
            <select value={value.version ?? 'vlm'} onChange={(e) => set('version', e.target.value)}>
              <option value="vlm">VLM</option>
              <option value="pipeline">Pipeline</option>
            </select>
          </label>
          <label className="field">
            <span>{t('文档语言')}</span>
            <input
              value={value.language ?? 'ch'}
              onChange={(e) => set('language', e.target.value)}
            />
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={value.ocr ?? false}
              onChange={(e) => set('ocr', e.target.checked)}
            />
            {t('启用 OCR')}
          </label>
          <p className="field wide">{t('在线解析会上传所导入的原件，仅在主动导入时调用。')}</p>
          {status && (
            <p role="status" className={status.api.configured ? 'muted' : 'warning'}>
              {t(status.api.configured ? 'API 凭据已保存' : '尚未配置 API 凭据')}
            </p>
          )}
        </div>
      ) : provider === 'documents.mineru-local' ? (
        <div className="form-grid">
          <label className="field wide">
            <span>{t('mineru-kit 可执行文件')}</span>
            <PathInput
              label={t('mineru-kit 可执行文件')}
              value={value.command ?? ''}
              onChange={(v: string) => set('command', v)}
            />
          </label>
          <label className="field">
            <span>{t('运行时附加参数（每行一项）')}</span>
            <textarea
              rows={3}
              value={(value.args ?? []).join('\n')}
              onChange={(e) => set('args', e.target.value.split('\n').filter(Boolean))}
            />
          </label>
          <label className="field">
            <span>{t('解析层级')}</span>
            <select value={value.tier ?? 'standard'} onChange={(e) => set('tier', e.target.value)}>
              {['flash', 'basic', 'standard', 'advanced'].map((id) => (
                <option key={id} value={id}>
                  {id.charAt(0).toUpperCase() + id.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <p className="field wide">
            {t('使用已安装的 MinerU 4.1 命令与本地模型；导出全部页面，不自动下载模型。')}
          </p>
        </div>
      ) : null}
      {provider !== 'documents.local' && (
        <label className="field">
          <span>{t('解析超时（秒）')}</span>
          <input
            type="number"
            min="10"
            max="1800"
            value={value.timeoutSeconds ?? 600}
            onChange={(e) => set('timeoutSeconds', Number(e.target.value))}
          />
        </label>
      )}
      <div className="form-actions">
        <Button
          onClick={() =>
            act(async () => {
              let next = { ...value };
              if (secret) {
                const reference =
                  next.apiKeyRef && !next.apiKeyRef.startsWith('env:')
                    ? next.apiKeyRef
                    : 'documents-mineru';
                await rpc('credentials.save', { reference, secret });
                next.apiKeyRef = reference;
                setSecret('');
              }
              const saved = await rpc('settings.save', { pluginId: 'documents', value: next });
              setValue(saved);
              await loadStatus();
            }, t('解析设置已保存'))
          }
        >
          {t('保存解析设置')}
        </Button>
        <Button
          secondary
          onClick={() =>
            act(async () => setTasks(await rpc('documents.tasks', {})), t('状态已更新'))
          }
        >
          {t('解析任务')}
        </Button>
      </div>
      {tasks?.map((j) => (
        <div className="list-item" key={j.id}>
          <span>{j.batchId ?? j.id.slice(0, 12)}</span>
          <span>{statusText(j.state)}</span>
        </div>
      ))}
    </section>
  );
}
