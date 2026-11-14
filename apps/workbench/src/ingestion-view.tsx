import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { Button, useUnsavedChanges } from './ui.tsx';
import { t, statusText } from './i18n.ts';
import { mediaExtensions } from '../../../packages/contracts/speech.ts';

export default function IngestionView({ data, act }: any) {
  const [snapshot, setSnapshot] = useState<any>(),
    [policy, setPolicy] = useState<any>(),
    [vaults, setVaults] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]),
    [plan, setPlan] = useState<any>(),
    [jobs, setJobs] = useState<any[]>([]),
    [refreshParsing, setRefreshParsing] = useState(false);
  const semantic = data.plugins.some((p: any) => p.id === 'semantic' && p.enabled);
  const loadJobs = async () => {
    if (semantic) setJobs((await rpc('semantic.migration.status')).jobs);
  };
  const load = async () => {
    const s = await rpc('knowledge.pipeline.status');
    setSnapshot(s);
    setPolicy(s.policy);
    setVaults(await rpc('knowledge.vaults'));
    await loadJobs();
  };
  useEffect(() => {
    void load().catch(() => {});
  }, [semantic]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const listener = (e: any) => {
      if (e.detail?.type !== 'semantic.updated') return;
      clearTimeout(timer);
      timer = setTimeout(() => void loadJobs().catch(() => {}), 500);
    };
    window.addEventListener('echo-event', listener);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('echo-event', listener);
    };
  }, [semantic]);
  useUnsavedChanges(
    Boolean(policy && snapshot && JSON.stringify(policy) !== JSON.stringify(snapshot.policy)),
    '入库流程',
  );
  if (!policy) return null;
  const set = (key: string, value: any) => {
    setPolicy({ ...policy, [key]: value });
    setPlan(undefined);
  };
  const models = (data.inference?.models ?? []).filter((m: any) => m.embedding?.enabled);
  return (
    <section className="card inference-form">
      <h2>{t('入库流程')}</h2>
      <p className="muted">
        {t('所有知识库沿用此默认流程。保存配置不会重跑已有解析或切换现有索引。')}
      </p>
      <div className="form-grid">
        {(['documentParser', 'mediaParser', 'imageParser'] as const).map((key, i) => (
          <label className="field" key={key}>
            <span>{t(['文档解析', '音视频转录', '图片处理'][i])}</span>
            <select value={policy[key]} onChange={(e) => set(key, e.target.value)}>
              <option value="">{t('按支持格式自动选择')}</option>
              {snapshot.parsers
                .filter(
                  (p: any) =>
                    p.version !== 'legacy' &&
                    (key === 'mediaParser'
                      ? p.extensions.some((e: string) => mediaExtensions.includes(e))
                      : key === 'imageParser'
                        ? p.extensions.some((e: string) => /\.(png|jpe?g|webp|gif|bmp)$/.test(e))
                        : p.extensions.some(
                            (e: string) =>
                              !mediaExtensions.includes(e) &&
                              !/\.(png|jpe?g|webp|gif|bmp|md|txt|csv|json|ya?ml|log|html?|srt|vtt)$/.test(
                                e,
                              ),
                          )),
                )
                .map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {t(p.label)} · {p.extensions.join(' ')}
                  </option>
                ))}
            </select>
          </label>
        ))}
        <label className="field">
          <span>{t('语义索引模型')}</span>
          <select value={policy.modelId} onChange={(e) => set('modelId', e.target.value)}>
            <option value="">{t('沿用共享语义模型')}</option>
            {models.map((m: any) => (
              <option value={m.id} key={m.id}>
                {m.name} · {m.embedding.inputs.join(', ')}
              </option>
            ))}
          </select>
        </label>
        {(['imageProcessor', 'mediaProcessor'] as const).map((key, i) => (
          <label className="field" key={key}>
            <span>{t(i === 0 ? '原生图片索引处理' : '原生音视频索引处理')}</span>
            <select value={policy[key]} onChange={(e) => set(key, e.target.value)}>
              <option value="">{t('按支持格式自动选择')}</option>
              {snapshot.mediaProcessors
                .filter((p: any) => p.modalities.includes(i === 0 ? 'image' : 'audio'))
                .map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {t(p.label)}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      <label className="inline-toggle">
        <input
          type="checkbox"
          disabled={!semantic}
          checked={policy.indexOnImport}
          onChange={(e) => set('indexOnImport', e.target.checked)}
        />
        {t('新导入内容自动建立索引')}
      </label>
      <details>
        <summary>{t('切块与媒体')}</summary>
        <div className="form-grid">
          {(['chunkChars', 'overlapChars', 'mediaSeconds'] as const).map((key, i) => (
            <label className="field" key={key}>
              <span>{t(['文本片段长度', '文本重叠长度', '媒体片段秒数'][i])}</span>
              <input
                type="number"
                min={key === 'overlapChars' ? 0 : 5}
                value={policy[key]}
                onChange={(e) => set(key, Number(e.target.value))}
              />
            </label>
          ))}
          <div className="field">
            <span>{t('索引内容')}</span>
            <div className="row wrap">
              {(['text', 'image', 'audio', 'video'] as const).map((m, i) => (
                <label key={m}>
                  <input
                    type="checkbox"
                    checked={policy.modalities.includes(m)}
                    onChange={(e) =>
                      set(
                        'modalities',
                        e.target.checked
                          ? [...policy.modalities, m]
                          : policy.modalities.filter((v: string) => v !== m),
                      )
                    }
                  />
                  {t(['文本', '图片', '音频', '视频'][i])}
                </label>
              ))}
            </div>
          </div>
        </div>
      </details>
      <div className="row">
        <Button
          onClick={() =>
            act(async () => {
              await rpc('knowledge.pipeline.save', { policy, expected: snapshot.fingerprint });
              await load();
            }, t('入库流程已保存'))
          }
        >
          {t('保存默认流程')}
        </Button>
      </div>
      {semantic && (
        <details className="library-advanced">
          <summary>{t('更新已有内容')}</summary>
          <p className="muted">
            {t('默认复用正文、转录与附件，仅生成内容结构和目标索引。旧索引在迁移完成前继续生效。')}
          </p>
          <div className="row wrap">
            {vaults.map((v) => (
              <label key={v.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(v.id)}
                  onChange={(e) => {
                    setSelected(
                      e.target.checked ? [...selected, v.id] : selected.filter((id) => id !== v.id),
                    );
                    setPlan(undefined);
                  }}
                />
                {v.name}
              </label>
            ))}
          </div>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={refreshParsing}
              onChange={(e) => {
                setRefreshParsing(e.target.checked);
                setPlan(undefined);
              }}
            />
            {t('同时应用解析配置变更（仅更新受影响的原件）')}
          </label>
          <div className="row">
            <Button
              secondary
              disabled={!selected.length}
              onClick={() =>
                act(async () =>
                  setPlan(
                    await rpc('semantic.migration.plan', {
                      vaultIds: selected,
                      policy,
                      refreshParsing,
                    }),
                  ),
                )
              }
            >
              {t('预览迁移')}
            </Button>
          </div>
          {plan && (
            <div className="card">
              <p>
                {t('复用解析')} {plan.reuseParsing} · {t('重新解析')} {plan.reparse} ·{' '}
                {t('需要处理')} {plan.blocked}
              </p>
              {plan.unsupported.length > 0 && (
                <p className="warning">
                  {t('所选模型不支持的模态不会建立向量')} · {plan.unsupported.join(', ')}
                </p>
              )}
              <details>
                <summary>{t('查看条目明细')}</summary>
                {plan.documents.map((d: any) => (
                  <p key={d.vaultId + d.id}>
                    {d.title} · {t(d.reason)}
                  </p>
                ))}
              </details>
              <Button
                disabled={
                  plan.blocked > 0 || jobs.some((j) => ['running', 'queued'].includes(j.state))
                }
                onClick={() =>
                  act(async () => {
                    await rpc('semantic.migration.start', {
                      planId: plan.id,
                      requestId: crypto.randomUUID(),
                    });
                    setPlan(undefined);
                    await loadJobs();
                  }, t('迁移已启动'))
                }
              >
                {t('开始迁移')}
              </Button>
            </div>
          )}
          {jobs
            .slice(-8)
            .reverse()
            .map((j) => (
              <div className="card" key={j.id}>
                <strong>{statusText(j.state)}</strong> · {j.completed}/{j.total} · {j.vectors}{' '}
                {t('向量')}
                <progress max={Math.max(1, j.total)} value={j.completed} />
                {j.error && <p className="warning">{j.error}</p>}
                <div className="row">
                  {['running', 'queued'].includes(j.state) && (
                    <Button
                      secondary
                      onClick={() =>
                        act(async () => {
                          await rpc('semantic.migration.pause');
                          await loadJobs();
                        })
                      }
                    >
                      {t('暂停')}
                    </Button>
                  )}
                  {['paused', 'failed'].includes(j.state) && (
                    <Button
                      onClick={() =>
                        act(async () => {
                          await rpc('semantic.migration.resume', { id: j.id });
                          await loadJobs();
                        })
                      }
                    >
                      {t('继续')}
                    </Button>
                  )}
                  {j.state === 'completed' && (
                    <Button
                      secondary
                      onClick={() =>
                        act(async () => {
                          await rpc('semantic.migration.rollback', { id: j.id });
                          await loadJobs();
                        })
                      }
                    >
                      {t('恢复上一版索引')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
        </details>
      )}
    </section>
  );
}
