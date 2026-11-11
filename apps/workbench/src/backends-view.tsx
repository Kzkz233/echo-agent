import { CredentialInput } from './credential-input.tsx';
import { openCodexLogin } from './account-login.ts';
import { connectionForPurpose, modelDisplayName } from '../../../packages/contracts/model-services.ts';
import { useEffect } from 'react';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { ReasoningSelect } from './reasoning-select.tsx';
import type { ModelListing } from '../../../packages/contracts/reasoning.ts';
import {
  Button,
  PathInput,
  requestNavigation,
  sameData,
  useUnsavedChanges,
  useConfirm,
} from './ui.tsx';
import {
  connectionSchema,
  modelProfileSchema,
  type AdapterDescriptor,
  type ModelProfile,
  type Connection,
} from '../../../packages/contracts/inference.ts';
const modalities = { text: '文本', image: '图像', audio: '音频', video: '视频' };
const defaults = (schema: any) => {
  try {
    return z.fromJSONSchema(schema).parse({}) as any;
  } catch {
    return {};
  }
};
function Fields({ fields, value, onChange }: any) {
  return fields.map((f: any) => (
    <label className="field" key={f.key}>
      <span>{t(f.label)}</span>
      {f.type === 'boolean' ? (
        <input
          type="checkbox"
          checked={value[f.key] ?? false}
          onChange={(e) => onChange(f.key, e.target.checked)}
        />
      ) : f.type === 'path' ? (
        <PathInput
          label={t(f.label)}
          directory={f.pathMode === 'directory'}
          value={value[f.key] ?? ''}
          onChange={(v: string) => onChange(f.key, v)}
        />
      ) : ['textarea', 'string-list'].includes(f.type) ? (
        <textarea
          aria-label={t(f.label)}
          rows={3}
          value={Array.isArray(value[f.key]) ? value[f.key].join('\n') : (value[f.key] ?? '')}
          onChange={(e) =>
            onChange(f.key, f.type === 'string-list' ? e.target.value.split('\n') : e.target.value)
          }
        />
      ) : f.type === 'select' ? (
        <select
          aria-label={t(f.label)}
          value={value[f.key] ?? ''}
          onChange={(e) => onChange(f.key, e.target.value)}
        >
          {f.options.map((o: string) => (
            <option key={o} value={o}>
              {t(f.optionLabels?.[o] ?? o)}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={f.type === 'number' ? 'number' : 'text'}
          value={value[f.key] ?? ''}
          onChange={(e) =>
            onChange(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)
          }
        />
      )}
    </label>
  ));
}
function BackendServices({
  data,
  act,
  owner = 'core',
  purpose = 'generation',
  embedded = false,
}: any) {
  const allAdapters = data.inference.adapters;
  const accepts = (adapter: any) =>
    purpose === 'embedding'
      ? adapter.embedding.length > 0
      : purpose === 'reranking'
        ? !!adapter.reranking?.length
        : owner === 'core'
          ? adapter.owner === 'core' && !adapter.workerOnly
          : adapter.owner === owner;
  const selectedAdapters = allAdapters.filter(accepts);
  const visibleConnections = data.connections.filter(
    (connection: any) => {
      const adapter = selectedAdapters.find((adapter: any) => adapter.id === connection.adapterId);
      return adapter && connectionForPurpose(connection, adapter, data.inference.models, purpose);
    },
  );
  const visibleModels = data.inference.models.filter(
    (model: ModelProfile) =>
      visibleConnections.some((connection: Connection) => connection.id === model.connectionId) &&
      (purpose === 'embedding'
        ? model.embedding.enabled
        : purpose === 'reranking'
          ? model.reranking?.enabled
          : owner === 'core'
            ? model.generation.enabled
            : true),
  );
  const adapters: AdapterDescriptor[] = selectedAdapters,
    models: ModelProfile[] = visibleModels,
    connections: Connection[] = visibleConnections;
  const createConnection = (mode = 'api') => {
    const a =
      (owner !== 'core' && purpose === 'generation' ? adapters[0] : undefined) ??
      (mode === 'local' ? adapters.find((a) => a.family === 'local-runtime') : undefined) ??
      adapters.find((a) => a.id === 'core.api') ??
      adapters[0];
    if (!a)
      return connectionSchema.parse({
        id: crypto.randomUUID(),
        name: t('新的服务'),
        adapterId: 'unavailable',
      });
    return connectionSchema.parse({
      id: crypto.randomUUID(),
      name: t('新的服务'),
      adapterId: a.id,
      purposes: [purpose],
      deployment: a.workerOnly ? 'harness' : mode === 'local' ? 'local' : 'cloud',
      config: {
        ...defaults(a.connectionSchema),
        ...(mode === 'local' ? { endpoint: 'http://127.0.0.1:11434/v1' } : {}),
      },
    });
  };
  const createModel = (selected?: Connection) => {
    const c = selected ?? connections[0],
      a = adapters.find((a) => a.id === c?.adapterId);
    return modelProfileSchema.parse({
      id: crypto.randomUUID(),
      name: t('新的模型'),
      connectionId: c?.id ?? 'unselected',
      generation: {
        enabled: purpose === 'generation' && (a ? !!a.generation.length : true),
        inputs: ['text'],
      },
      embedding: {
        enabled: purpose === 'embedding' || (a ? !a.generation.length : false),
        inputs: ['text'],
      },
      ...(purpose === 'reranking' ? { reranking: { enabled: true, inputs: ['text'] } } : {}),
      options: a ? defaults(a.modelSchema) : {},
    });
  };
  const [tab, setTab] = useState('connections'),
    [references, setReferences] = useState<{ id: string; kind: string; label: string }[]>([]),
    [connection, setConnection] = useState<Connection>(connections[0] ?? createConnection()),
    [model, setModel] = useState<ModelProfile>(models[0] ?? createModel()),
    [template, setTemplate] = useState(''),
    [secret, setSecret] = useState(''),
    [auth, setAuth] = useState<any>(),
    [connectionCheck, setConnectionCheck] = useState<any>(),
    [catalog, setCatalog] = useState<Record<string, ModelListing[]>>({}),
    [catalogIssue, setCatalogIssue] = useState(''),
    [catalogLoading, setCatalogLoading] = useState(false),
    [runtime, setRuntime] = useState<any>();
  useEffect(() => {
    if (!auth?.loginId || auth.account) return;
    let alive = true;
    let checking = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 15 * 60000) {
        clearInterval(timer);
        if (alive) setAuth((value: any) => ({ ...value, loginId: undefined, authUrl: undefined }));
        return;
      }
      if (checking) return;
      checking = true;
      void rpc('connections.authenticate', { id: connection.id, action: 'status' }).then((status) => {
        if (alive && status.account) setAuth(status);
      }).catch(() => {}).finally(() => { checking = false; });
    }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [connection.id, auth?.loginId, Boolean(auth?.account)]);
  const connectionBase = useRef(connection),
    modelBase = useRef(model),
    confirm = useConfirm();
  const connectionChanged = Boolean(secret) ||
    !sameData(connection, connections.find((c) => c.id === connection.id) ?? connectionBase.current);
  const canTestGeneration = purpose === 'generation' &&
    data.inference.models.some((model: ModelProfile) => model.connectionId === connection.id && model.generation.enabled);
  useUnsavedChanges(
    connectionChanged ||
      !sameData(model, models.find((m) => m.id === model.id) ?? modelBase.current),
    '模型服务',
  );
  const pickConnection = (v: Connection) =>
    requestNavigation(() => {
      connectionBase.current = v;
      setConnection(v);
      setSecret('');
      setAuth(undefined);
      setConnectionCheck(undefined);
      setTab('connections');
    });
  const pickModel = (v: ModelProfile) =>
    requestNavigation(() => {
      setTemplate('');
      modelBase.current = v;
      setModel(v);
      const parent = connections.find((connection) => connection.id === v.connectionId);
      if (parent) {
        setConnection(parent);
        connectionBase.current = parent;
      }
      setTab('models');
    });
  const adapter = adapters.find((a) => a.id === connection.adapterId),
    modelConnection = connections.find((c) => c.id === model.connectionId),
    modelAdapter = adapters.find((a) => a.id === modelConnection?.adapterId);
  const catalogRequest = useRef(0);
  useEffect(() => {
    let active = true;
    setReferences([]);
    if (tab === 'models' && data.inference.models.some((entry: any) => entry.id === model.id))
      void rpc('inference.references', { id: model.id })
        .then((rows) => {
          if (active) setReferences(rows);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [tab, model.id]);
  const loadModels = async (id: string, refresh = false) => {
    const ticket = ++catalogRequest.current;
    setCatalogIssue('');
    setCatalogLoading(true);
    try {
      const models = await rpc<ModelListing[]>('connections.models', { id, refresh });
      if (ticket === catalogRequest.current) setCatalog((all) => ({ ...all, [id]: models }));
    } catch (error) {
      if (ticket === catalogRequest.current) setCatalogIssue((error as Error).message);
    } finally {
      if (ticket === catalogRequest.current) setCatalogLoading(false);
    }
  };
  useEffect(() => {
    if (
      tab === 'models' &&
      modelConnection &&
      modelAdapter?.modelCatalogProvider &&
      !catalog[modelConnection.id]
    )
      void loadModels(modelConnection.id);
    else {
      catalogRequest.current++;
      setCatalogIssue('');
      setCatalogLoading(false);
    }
    return () => {
      catalogRequest.current++;
    };
  }, [tab, modelConnection?.id, modelConnection?.adapterId]);
  const catalogOptions = catalog[model.connectionId] ?? [];
  const mode =
    adapter?.family === 'local-runtime' || connection.deployment === 'local'
      ? 'local'
      : adapter?.family === 'harness'
        ? 'harness'
        : 'api';

  const setCapability = (key: 'generation' | 'embedding', patch: any) =>
    setModel({ ...model, [key]: { ...model[key], ...patch } });
  const inputs = (key: 'generation' | 'embedding', supported: string[]) => (
    <div className="model-modalities">
      {Object.entries(modalities).map(([id, label]) => (
        <label className="inline-toggle" key={id}>
          <input
            type="checkbox"
            aria-label={t(key === 'generation' ? '生成输入' : '向量输入') + ' · ' + t(label)}
            checked={model[key].inputs.includes(id as any)}
            disabled={!supported.includes(id) || id === 'text'}
            onChange={(e) =>
              setCapability(key, {
                inputs: e.target.checked
                  ? [...model[key].inputs, id]
                  : model[key].inputs.filter((i) => i !== id),
              })
            }
          />
          {t(label)}
        </label>
      ))}
    </div>
  );
  return (
    <>
      {!embedded && (
        <div className="page-title">
          <h1>{t('模型服务')}</h1>
        </div>
      )}
      {!adapters.length ? (
        <p className="muted">{t('启用对应插件后即可配置服务。')}</p>
      ) : (
        <div className="inference-workspace service-workspace">
          <aside className="card inference-list">
            <div className="row between">
              <h2>
                {t(
                  purpose === 'embedding'
                    ? '语义索引模型'
                    : purpose === 'reranking'
                      ? '重排模型'
                      : owner === 'core'
                        ? '模型服务'
                        : '执行配置',
                )}
              </h2>
              <Button secondary onClick={() => pickConnection(createConnection())}>
                {t('添加服务')}
              </Button>
            </div>
            {connections.map((entry) => (
              <div
                className={'service-card ' + (entry.id === connection.id ? 'selected' : '')}
                key={entry.id}
              >
                <button className="service-card-heading" onClick={() => pickConnection(entry)}>
                  <strong>{entry.name}</strong>
                  <small>
                    {t(
                      entry.deployment === 'local'
                        ? '本地'
                        : entry.deployment === 'harness'
                          ? '外部执行器'
                          : '在线 API',
                    )}
                  </small>
                </button>
                {entry.id === connection.id && (
                  <div className="service-model-list">
                    {models
                      .filter((model) => model.connectionId === entry.id)
                      .map((item) => (
                        <button
                          key={item.id}
                          className={tab === 'models' && model.id === item.id ? 'selected' : ''}
                          onClick={() => pickModel(item)}
                        >
                          {modelDisplayName(item)}
                        </button>
                      ))}
                    <button className="text-button" onClick={() => pickModel(createModel(entry))}>
                      {t('添加模型')}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {!connections.length && <p className="muted">{t('添加服务后选择要使用的模型。')}</p>}
          </aside>
          <div className="service-editor">
            {tab === 'connections' && (
              <section className="card inference-editor">
                <h2>{t('服务设置')}</h2>
                <label className="field">
                  <span>{t('服务名称')}</span>
                  <input
                    value={connection.name}
                    onChange={(e) => setConnection({ ...connection, name: e.target.value })}
                  />
                </label>
                {!adapter?.workerOnly && (
                  <label className="field">
                    <span>{t('服务位置')}</span>
                    <select
                      aria-label={t('服务位置')}
                      value={connection.deployment === 'local' ? 'local' : 'cloud'}
                      onChange={(event) =>
                        setConnection({ ...connection, deployment: event.target.value as any })
                      }
                    >
                      <option value="cloud">{t('在线 API')}</option>
                      <option value="local">{t('本地')}</option>
                    </select>
                  </label>
                )}
                {adapters.some((entry) => entry.family === 'local-runtime') &&
                  !models.some((item) => item.connectionId === connection.id) && (
                    <label className="field">
                      <span>{t('服务类型')}</span>
                      <select
                        aria-label={t('服务类型')}
                        value={connection.adapterId}
                        onChange={(event) => {
                          const next = adapters.find((entry) => entry.id === event.target.value)!;
                          setConnection({
                            ...connection,
                            adapterId: next.id,
                            deployment:
                              next.family === 'local-runtime' ? 'local' : connection.deployment,
                            config: defaults(next.connectionSchema),
                          });
                        }}
                      >
                        {adapters
                          .filter(
                            (entry) => entry.id !== 'core.pi' || connection.adapterId === entry.id,
                          )
                          .map((entry) => (
                            <option value={entry.id} key={entry.id}>
                              {t(entry.label)}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                {mode === 'local' && (
                  <p className="muted">
                    {t('连接已有本地 API 服务，或由 Echo 按需加载支持的模型。')}
                  </p>
                )}
                {adapter && (
                  <>
                    <Fields
                      fields={adapter.connectionFields.filter(
                        (f) =>
                          f.key !== 'apiKeyRef' &&
                          (f.key !== 'protocol' || purpose === 'generation') &&
                          (adapter.workerOnly || f.key !== 'provider') &&
                          (mode !== 'harness' || !['command', 'args', 'cwd'].includes(f.key)),
                      )}
                      value={{ ...defaults(adapter.connectionSchema), ...connection.config }}
                      onChange={(key: string, v: any) =>
                        setConnection({ ...connection, config: { ...connection.config, [key]: v } })
                      }
                    />
                    {adapter.engine === 'dsh' && (
                      <p className="muted">
                        {t(
                          'DSH 的 DeepSeek 官方连接使用 Messages API。官方域名填写 /v1 时，Echo 会自动改用 /anthropic。',
                        )}
                      </p>
                    )}
                    {mode === 'harness' &&
                      adapter.connectionFields.some((f) => f.key === 'command') && (
                        <details className="advanced-settings">
                          <summary>{t('高级启动设置')}</summary>
                          <Fields
                            fields={adapter.connectionFields.filter((f) =>
                              ['command', 'args', 'cwd'].includes(f.key),
                            )}
                            value={connection.config}
                            onChange={(key: string, v: any) =>
                              setConnection({
                                ...connection,
                                config: { ...connection.config, [key]: v },
                              })
                            }
                          />
                        </details>
                      )}
                    {adapter.connectionFields.some((f) => f.key === 'apiKeyRef') && (
                      <CredentialInput
                        label="API Key"
                        reference={String(connection.config.apiKeyRef ?? '')}
                        value={secret}
                        onChange={setSecret}
                      />
                    )}
                    <div className="form-actions">
                      <Button
                        onClick={() =>
                          act(async () => {
                            let value = Array.isArray(connection.config.args)
                              ? {
                                  ...connection,
                                  config: {
                                    ...connection.config,
                                    args: connection.config.args.filter((arg) =>
                                      String(arg).trim(),
                                    ),
                                  },
                                }
                              : connection;
                            if (secret) {
                              const reference = 'connection-' + connection.id;
                              await rpc('credentials.save', { reference, secret });
                              value = {
                                ...value,
                                config: { ...value.config, apiKeyRef: reference },
                              };
                            }
                            const saved = await rpc('connections.save', value);
                            connectionBase.current = saved;
                            setConnection(saved);
                            setConnectionCheck(undefined);
                            setCatalog((entries) =>
                              Object.fromEntries(
                                Object.entries(entries).filter(([id]) => id !== saved.id),
                              ),
                            );
                            setSecret('');
                          }, t('服务已保存'))
                        }
                      >
                        {t('保存服务')}
                      </Button>
                      {connections.some((c) => c.id === connection.id) && (
                        <Button
                          secondary
                          disabled={connectionChanged}
                          onClick={() =>
                            act(
                              async () =>
                                setConnectionCheck(
                                  await rpc('connections.test', { id: connection.id }),
                                ),
                              t('连接测试完成'),
                            )
                          }
                        >
                          {t('测试连接')}
                        </Button>
                      )}
                      {canTestGeneration && ['api', 'pi'].includes(adapter.engine) && (
                        <Button secondary disabled={connectionChanged} onClick={() =>
                          act(async () => setConnectionCheck(await rpc('connections.test', {
                            id: connection.id, generation: true,
                          })), t('推理测试完成'))
                        }>{t('测试推理')}</Button>
                      )}
                      {connectionCheck && !connectionChanged && (
                        <div className="muted">
                          <span>{connectionCheck.ok ? t('连接可用') : t('连接不可用')}</span>
                          {['upstream', 'upstream+runtime'].includes(connectionCheck.verified) && (
                            <small>
                              {t('上游模型目录可访问（{count} 个模型）', {
                                count: connectionCheck.modelCount,
                              })}
                            </small>
                          )}
                          {connectionCheck.verified === 'upstream+runtime' && (
                            <small>{t('DSH SDK 初始化正常；未发送推理请求。')}</small>
                          )}
                          {connectionCheck.verified === 'generation' && (
                            <small>{connectionCheck.model} · {connectionCheck.toolCall
                              ? t('流式回复和工具调用均已验证。')
                              : t('流式回复已验证，模型未完成测试工具调用。')}</small>
                          )}
                          {connectionCheck.note && <small>{t(connectionCheck.note)}</small>}
                        </div>
                      )}
                      {connections.some((c) => c.id === connection.id) && (
                        <Button secondary onClick={() => pickModel(createModel(connection))}>
                          {t('选择可用模型')}
                        </Button>
                      )}
                      {connections.some((c) => c.id === connection.id) && (
                        <Button
                          secondary
                          onClick={async () => {
                            if (
                              await confirm({
                                title: t('删除此连接？'),
                                description: t('需先移除连接下的模型配置。'),
                                danger: true,
                                confirmLabel: t('删除连接'),
                              })
                            )
                              await act(async () => {
                                await rpc('connections.delete', { id: connection.id });
                                pickConnection(
                                  connections.find((c) => c.id !== connection.id) ??
                                    createConnection(),
                                );
                              }, t('连接已删除'));
                          }}
                        >
                          {t('删除服务')}
                        </Button>
                      )}
                    </div>
                    {adapter.engine === 'codex' &&
                      connections.some((c) => c.id === connection.id) && (
                        <section className="connection-auth">
                          <h3>{t('Codex 账号')}</h3>
                          <div className="row wrap">
                            <Button
                              secondary
                              onClick={() =>
                                act(
                                  async () =>
                                    setAuth(
                                      await rpc('connections.authenticate', {
                                        id: connection.id,
                                        action: 'status',
                                      }),
                                    ),
                                  t('账号状态已更新'),
                                )
                              }
                            >
                              {t('检查登录')}
                            </Button>
                            <Button
                              secondary
                              onClick={() =>
                                act(
                                  async () => {
                                    const login = await rpc('connections.authenticate', {
                                      id: connection.id, action: 'login',
                                    });
                                    setAuth(login);
                                    if (login.authUrl) await openCodexLogin(login.authUrl).catch(() => {});
                                  },
                                  t('登录已启动'),
                                )
                              }
                            >
                              {t('使用 ChatGPT 登录')}
                            </Button>
                          </div>
                          {auth && (
                            <p>
                              {auth.account ? t('已登录') : auth.authUrl ? t('等待浏览器登录') : t('尚未登录')}
                              {auth.authUrl && (
                                <>
                                  {' '}
                                  ·{' '}
                                  <a href={auth.authUrl} target="_blank" rel="noreferrer" onClick={(event) => {
                                    event.preventDefault();
                                    void act(() => openCodexLogin(auth.authUrl));
                                  }}>
                                    {t('打开官方登录页')}
                                  </a>
                                </>
                              )}
                            </p>
                          )}
                        </section>
                      )}
                  </>
                )}
              </section>
            )}
            {tab === 'models' && (
              <section className="card inference-editor">
                <h2>{t('模型设置')}</h2>
                {!connections.length ? (
                  <p>{t('先添加一个连接，再配置模型。')}</p>
                ) : (
                  <>
                    <label className="field">
                      <span>{t('模型配置名称')}</span>
                      <input
                        value={model.name}
                        onChange={(e) => setModel({ ...model, name: e.target.value })}
                      />
                    </label>
                    <div className="model-service-origin">
                      <span>{modelConnection?.name}</span>
                      <Button secondary onClick={() => pickConnection(modelConnection!)}>
                        {t('服务设置')}
                      </Button>
                    </div>
                    {!!modelAdapter?.presets.length && (
                      <label className="field">
                        <span>{t('模型模板')}</span>
                        <select
                          aria-label={t('模型模板')}
                          value={template}
                          onChange={(e) => {
                            const preset = modelAdapter.presets.find(
                              (p) => p.id === e.target.value,
                            );
                            setTemplate(e.target.value);
                            if (preset)
                              setModel({
                                ...model,
                                name: preset.name,
                                model: preset.model ?? model.model,
                                generation: preset.generation,
                                embedding: preset.embedding,
                                options: {
                                  ...defaults(modelAdapter.modelSchema),
                                  ...model.options,
                                  ...preset.options,
                                },
                              });
                          }}
                        >
                          <option value="">{t('自定义')}</option>
                          {modelAdapter.presets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {t(p.name)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {modelAdapter?.engine === 'codex' ? (
                      <>
                        <label className="field">
                          <span>{t('Codex 模型')}</span>
                          <select
                            aria-label={t('Codex 模型')}
                            value={model.model}
                            onChange={(e) => setModel({ ...model, model: e.target.value })}
                          >
                            <option value="">{t('跟随后端默认')}</option>
                            {model.model &&
                              !catalogOptions.some((entry) => entry.id === model.model) && (
                                <option value={model.model}>{model.model}</option>
                              )}
                            {catalogOptions.map((entry) => (
                              <option value={entry.id} key={entry.id}>
                                {entry.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="row wrap">
                          <Button
                            secondary
                            disabled={catalogLoading}
                            onClick={() => void loadModels(model.connectionId, true)}
                          >
                            {t(catalogLoading ? '读取模型中' : '刷新模型列表')}
                          </Button>
                          {catalogIssue && <small className="warning">{catalogIssue}</small>}
                        </div>
                        <details className="advanced-settings">
                          <summary>{t('手动填写模型 ID')}</summary>
                          <label className="field">
                            <span>{t('模型 ID')}</span>
                            <input
                              value={model.model}
                              onChange={(e) => setModel({ ...model, model: e.target.value })}
                            />
                          </label>
                        </details>
                      </>
                    ) : modelAdapter && ['api', 'pi', 'dsh'].includes(modelAdapter.engine) ? (
                      <>
                        <label className="field">
                          <span>{t(modelAdapter.engine === 'dsh' ? 'DSH 模型' : 'API 模型')}</span>
                          <select
                            aria-label={t(modelAdapter.engine === 'dsh' ? 'DSH 模型' : 'API 模型')}
                            value={model.model}
                            onChange={(e) => setModel({ ...model, model: e.target.value })}
                          >
                            <option value="">{t('选择模型')}</option>
                            {model.model &&
                              !catalogOptions.some((entry) => entry.id === model.model) && (
                                <option value={model.model}>{model.model}</option>
                              )}
                            {catalogOptions.map((entry) => (
                              <option value={entry.id} key={entry.id}>
                                {entry.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="row wrap">
                          <Button
                            secondary
                            disabled={catalogLoading}
                            onClick={() => void loadModels(model.connectionId, true)}
                          >
                            {t(catalogLoading ? '读取模型中' : '刷新模型列表')}
                          </Button>
                          {catalogIssue && <small className="warning">{catalogIssue}</small>}
                        </div>
                        <details className="advanced-settings">
                          <summary>{t('手动填写模型 ID')}</summary>
                          <label className="field">
                            <span>{t('模型 ID')}</span>
                            <input
                              aria-label={t('模型 ID')}
                              value={model.model}
                              onChange={(e) => setModel({ ...model, model: e.target.value })}
                            />
                          </label>
                        </details>
                      </>
                    ) : (
                      <label className="field">
                        <span>
                          {modelAdapter?.id === 'local-models.gguf'
                            ? t('GGUF 模型文件')
                            : modelAdapter?.family === 'local-runtime'
                              ? t('本地 ONNX 模型路径或 ID')
                              : t('模型 ID')}
                        </span>
                        {modelAdapter?.id === 'local-models.gguf' ? (
                          <PathInput
                            label={t('GGUF 模型文件')}
                            value={model.model}
                            onChange={(v: string) => setModel({ ...model, model: v })}
                          />
                        ) : (
                          <input
                            value={model.model}
                            onChange={(e) => setModel({ ...model, model: e.target.value })}
                            placeholder={
                              modelAdapter?.family === 'harness'
                                ? t('留空沿用执行器默认')
                                : undefined
                            }
                          />
                        )}
                      </label>
                    )}
                    {!modelAdapter ? (
                      <p className="warning">
                        {t('接入器已停用；配置仍保留，启用插件后可继续使用。')}
                      </p>
                    ) : (
                      <>
                        <div className="model-capabilities">
                          {purpose === 'generation' && (
                            <section>
                              <h3>{t('支持的输入')}</h3>
                              {inputs('generation', modelAdapter.generation)}
                            </section>
                          )}
                          {purpose === 'embedding' && (
                            <section>
                              <h3>{t('支持的输入')}</h3>
                              {inputs('embedding', modelAdapter.embedding)}
                            </section>
                          )}
                          {purpose === 'reranking' && <p className="muted">{t('相关性重排')}</p>}
                        </div>
                        {purpose === 'generation' && model.generation.enabled && (
                          <details className="form-advanced">
                            <summary>{t('生成参数')}</summary>
                            <div className="form-grid">
                              <ReasoningSelect
                                capabilitiesOnly
                                label="思考能力"
                                value="inherit"
                                style={model.reasoningStyle}
                                connectionId={model.connectionId}
                                model={model.model}
                                onChange={() => {}}
                              />
                              {['api', 'pi'].includes(modelAdapter.engine) && (
                                <label className="field">
                                  <span>{t('API 思考参数格式')}</span>
                                  <select
                                    value={model.reasoningStyle}
                                    onChange={(e) =>
                                      setModel({ ...model, reasoningStyle: e.target.value as any })
                                    }
                                  >
                                    <option value="auto">{t('自动适配')}</option>
                                    <option value="none">{t('不附加参数')}</option>
                                    <option value="effort">reasoning_effort</option>
                                    <option value="enable_thinking">enable_thinking</option>
                                    <option value="chat_template">
                                      chat_template_kwargs.enable_thinking
                                    </option>
                                    <option value="deepseek">DeepSeek</option>
                                  </select>
                                </label>
                              )}
                              {model.reasoningStyle === 'effort' && (
                                <fieldset>
                                  <legend>{t('手动声明支持的思考级别')}</legend>
                                  {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(
                                    (level) => (
                                      <label className="inline-toggle" key={level}>
                                        <input
                                          type="checkbox"
                                          checked={
                                            model.reasoningLevels?.includes(level as any) ?? false
                                          }
                                          onChange={(event) => {
                                            const values = event.target.checked
                                              ? [...(model.reasoningLevels ?? []), level]
                                              : model.reasoningLevels?.filter(
                                                  (value) => value !== level,
                                                );
                                            setModel({
                                              ...model,
                                              reasoningLevels: values?.length
                                                ? (values as any)
                                                : undefined,
                                            });
                                          }}
                                        />
                                        {level}
                                      </label>
                                    ),
                                  )}
                                  <small>
                                    {t(
                                      '仅在上游未提供元数据时，按接口文档填写。角色与任务分别选择实际使用的强度。',
                                    )}
                                  </small>
                                </fieldset>
                              )}
                              {modelAdapter.engine !== 'codex' && (
                                <label className="field">
                                  <span>{t('单次最大输出 token')}</span>
                                  <input
                                    type="number"
                                    value={model.maxOutputTokens}
                                    onChange={(e) =>
                                      setModel({
                                        ...model,
                                        maxOutputTokens: Number(e.target.value),
                                      })
                                    }
                                  />
                                </label>
                              )}
                              <label className="field">
                                <span>{t('输入文本字符预算')}</span>
                                <input
                                  type="number"
                                  value={model.contextChars}
                                  onChange={(e) =>
                                    setModel({ ...model, contextChars: Number(e.target.value) })
                                  }
                                />
                              </label>
                              {(modelAdapter.family === 'api' || modelAdapter.engine === 'dsh') && (
                                <label className="field">
                                  <span>{t('模型上下文窗口（tokens，可选）')}</span>
                                  <input type="number" min={1024} max={2000000}
                                    value={String(model.options.contextWindowTokens ?? '')}
                                    onChange={(e) => {
                                      const options = { ...model.options };
                                      if (e.target.value) options.contextWindowTokens = Number(e.target.value);
                                      else delete options.contextWindowTokens;
                                      setModel({ ...model, options });
                                    }}
                                  />
                                </label>
                              )}
                            </div>
                          </details>
                        )}
                        {model.generation.enabled && modelAdapter.engine === 'codex' && (
                          <label className="field">
                            <span>{t('Codex 上下文上限')}</span>
                            <select
                              aria-label={t('Codex 上下文上限')}
                              value={String(model.options.contextWindowTokens ?? '')}
                              onChange={(e) => {
                                const options = { ...model.options };
                                if (e.target.value)
                                  options.contextWindowTokens = Number(e.target.value);
                                else delete options.contextWindowTokens;
                                setModel({ ...model, options });
                              }}
                            >
                              <option value="">{t('使用模型默认上限')}</option>
                              {[
                                ...new Set([
                                  16000,
                                  32000,
                                  64000,
                                  128000,
                                  256000,
                                  ...(typeof model.options.contextWindowTokens === 'number'
                                    ? [model.options.contextWindowTokens]
                                    : []),
                                ]),
                              ]
                                .sort((a, b) => a - b)
                                .map((n) => (
                                  <option key={n} value={n}>
                                    {n.toLocaleString()} token
                                  </option>
                                ))}
                            </select>
                            <small>{t('保存后在 Echo 的 Codex 会话启动或恢复时生效。')}</small>
                          </label>
                        )}
                        {model.embedding.enabled && (
                          <label className="field">
                            <span>
                              {t(
                                modelAdapter.family === 'local-runtime'
                                  ? '预期向量维度（可选）'
                                  : '向量维度（留空使用模型默认）',
                              )}
                            </span>
                            <input
                              type="number"
                              min="1"
                              value={model.embedding.dimensions ?? ''}
                              onChange={(e) =>
                                setCapability('embedding', {
                                  dimensions: e.target.value ? Number(e.target.value) : undefined,
                                })
                              }
                            />
                          </label>
                        )}
                        {modelAdapter.family === 'api' ? (
                          <details className="form-advanced">
                            <summary>{t('接口兼容选项')}</summary>
                            <Fields
                              fields={modelAdapter.modelFields}
                              value={{ ...defaults(modelAdapter.modelSchema), ...model.options }}
                              onChange={(key: string, v: any) =>
                                setModel({ ...model, options: { ...model.options, [key]: v } })
                              }
                            />
                          </details>
                        ) : (
                          <Fields
                            fields={modelAdapter.modelFields}
                            value={{ ...defaults(modelAdapter.modelSchema), ...model.options }}
                            onChange={(key: string, v: any) =>
                              setModel({
                                ...model,
                                options: {
                                  ...defaults(modelAdapter.modelSchema),
                                  ...model.options,
                                  [key]: v,
                                },
                              })
                            }
                          />
                        )}
                        <details className="form-advanced">
                          <summary>{t('运行限制')}</summary>
                          <label className="field">
                            <span>{t('超时毫秒')}</span>
                            <input
                              type="number"
                              value={model.timeoutMs}
                              onChange={(e) =>
                                setModel({ ...model, timeoutMs: Number(e.target.value) })
                              }
                            />
                          </label>
                        </details>
                        {references.length > 0 && (
                          <details className="form-advanced">
                            <summary>
                              {t('使用此模型的配置')} · {references.length}
                            </summary>
                            <ul>
                              {references.map((reference) => (
                                <li key={reference.kind + reference.id}>{reference.label}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                        <div className="form-actions">
                          <Button
                            onClick={() =>
                              act(
                                async () => setModel(await rpc('profiles.save', model)),
                                t('模型已保存'),
                              )
                            }
                          >
                            {t('保存模型')}
                          </Button>
                          {models.some((m) => m.id === model.id) && (
                            <Button
                              secondary
                              onClick={async () => {
                                if (
                                  await confirm({
                                    title: t('删除此模型配置？'),
                                    description: t('请先解除角色、会话和任务对此模型的引用。'),
                                    danger: true,
                                    confirmLabel: t('删除模型'),
                                  })
                                )
                                  await act(async () => {
                                    await rpc('profiles.delete', { id: model.id });
                                    pickModel(
                                      models.find((m) => m.id !== model.id) ?? createModel(),
                                    );
                                  }, t('模型已删除'));
                              }}
                            >
                              {t('删除模型')}
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        </div>
      )}
      {owner === 'local-models' && (
        <details className="card inference-runtime">
          <summary>{t('本地模型运行状态')}</summary>
          <div className="row wrap">
            <Button
              secondary
              onClick={() =>
                act(async () => setRuntime(await rpc('local-models.status', {})), t('状态已更新'))
              }
            >
              {t('刷新状态')}
            </Button>
            <Button
              secondary
              onClick={() =>
                act(async () => {
                  await rpc('local-models.release', {});
                  setRuntime(await rpc('local-models.status', {}));
                }, t('空闲模型已释放'))
              }
            >
              {t('释放空闲模型')}
            </Button>
            {runtime && (
              <span>
                {t('已加载')} {runtime.loaded}
              </span>
            )}
          </div>
          {runtime?.models.map((m: any) => (
            <p key={m.model}>
              {m.model} · {m.busy ? t('处理中') : t('空闲')}
            </p>
          ))}
        </details>
      )}
    </>
  );
}

export default function BackendsView(props: any) {
  const kinds = props.data.inference.kinds ?? [
    { id: 'core.language', label: '语言与视觉模型', capability: 'generation' },
  ];
  const [selected, setSelected] = useState('core.language');
  if (props.embedded || (props.owner && props.owner !== 'core'))
    return <BackendServices {...props} />;
  const kind = kinds.find((entry: any) => entry.id === selected) ?? kinds[0];
  return (
    <>
      <div className="page-title">
        <h1>{t('模型服务')}</h1>
      </div>
      <div className="page-sheets" role="tablist" aria-label={t('模型分类')}>
        {kinds.map((entry: any) => (
          <button
            role="tab"
            key={entry.id}
            aria-selected={kind.id === entry.id}
            onClick={() => requestNavigation(() => setSelected(entry.id))}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      <BackendServices {...props} key={kind.id} embedded purpose={kind.capability} />
    </>
  );
}
