import { useState } from 'react';
import { chatServicePresets, localChatModel } from '../../../packages/contracts/chat-setup.ts';
import { t } from './i18n.ts';
import { rpc } from './client.ts';
import { Button } from './ui.tsx';
import { CredentialInput } from './credential-input.tsx';

export function QuickModel({ onReady, localRuntime }: { onReady: (id: string) => Promise<void> | void; localRuntime: boolean }) {
  const [provider, setProvider] = useState<keyof typeof chatServicePresets | 'custom'>('deepseek');
  const [secret, setSecret] = useState(''), [endpoint, setEndpoint] = useState('');
  const [protocol, setProtocol] = useState('openai-completions'), [model, setModel] = useState('');
  const [choices, setChoices] = useState<string[]>([]), [busy, setBusy] = useState(false), [issue, setIssue] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const input = { provider, secret, ...(provider === 'custom' ? { endpoint, protocol } : {}) };
  const run = async (action: () => Promise<void>) => {
    setIssue(''); setBusy(true);
    try { await action(); } catch (err) { setIssue((err as Error).message); } finally { setBusy(false); }
  };
  const save = async (id: string) => {
    const saved = await rpc('models.setupChat', { ...input, requestId, model: id });
    setSecret(''); await onReady(saved.id);
  };
  return <fieldset disabled={busy} className="card form-grid"><legend>{t('连接聊天模型')}</legend>
    <label className="field"><span>{t('服务提供商')}</span><select value={provider} onChange={e => {
      setProvider(e.target.value as typeof provider); setSecret(''); setChoices([]); setModel(''); setIssue(''); setRequestId(crypto.randomUUID());
    }}>{Object.entries(chatServicePresets).map(([id, entry]) => <option key={id} value={id}>{entry.name}</option>)}<option value="custom">{t('自定义连接')}</option></select></label>
    {provider === 'custom' && <><label className="field"><span>API Base URL</span><input value={endpoint} onChange={e => { setEndpoint(e.target.value); setChoices([]); setSecret(''); }} /></label>
      <label className="field"><span>{t('API 协议')}</span><select value={protocol} onChange={e => { setProtocol(e.target.value); setChoices([]); }}>
        <option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label></>}
    {provider !== 'ollama' && <CredentialInput label="API Key" value={secret} onChange={setSecret} />}
    <label className="field"><span>{t('模型 ID')}</span><input list={'models-' + requestId} value={model} onChange={e => setModel(e.target.value)} />
      <datalist id={'models-' + requestId}>{choices.map(id => <option key={id} value={id} />)}</datalist></label>
    <div className="row wrap"><Button secondary onClick={() => run(async () => {
      const entries = await rpc('models.setupCatalog', input); setChoices(entries.map((x: any) => x.id));
      if (!model && entries.length === 1) setModel(entries[0].id);
      if (!entries.length) setIssue(t('目录为空，可手动填写模型 ID。'));
    })}>{t('读取模型列表')}</Button><Button disabled={!model.trim()} onClick={() => run(() => save(model.trim()))}>{t('使用此模型')}</Button></div>
    {provider === 'ollama' && localRuntime && <div><p>{t('可选本地聊天模型 Qwen3 4B，下载约 2.5 GB。建议至少 8 GB 内存，需先启动本机 Ollama。')}</p>
      <a href="https://ollama.com/download/windows" target="_blank" rel="noreferrer">{t('获取 Ollama')}</a>{' '}
      <Button secondary onClick={() => run(async () => {const result = await rpc('local-models.installChat', {confirmed:true}); await save(result.model);})}>{t('下载并使用')} {localChatModel}</Button></div>}
    {busy && <span role="status">{t('正在处理…')}</span>}{issue && <p role="alert" className="warning">{issue}</p>}
  </fieldset>;
}
