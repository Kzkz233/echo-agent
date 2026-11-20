import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, useConfirm } from './ui.tsx';
import { QuickModel } from './quick-model.tsx';
import { ModelChoice } from './model-choice.tsx';

export function StarterCharacters({ data, act, openRole, openSettings, openKnowledge }: any) {
  const [catalog, setCatalog] = useState<any>();
  const [model, setModel] = useState('');
  const [choice, setChoice] = useState('hina');
  const [connecting, setConnecting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const confirm = useConfirm();
  useEffect(() => {
    void rpc<any>('characters.examples.list', {}).then((value) => {
      setCatalog(value);
      setModel(
        value.existing?.profileId ??
          data.conversations?.find(
            (c: any) => c.personaId === value.existing?.roles?.[0] && c.kind === 'main',
          )?.binding?.profileId ??
          data.profiles.find((p: any) => p.available && p.eligibility?.conversation)?.id ?? '',
      );
    });
  }, []);
  if (!catalog) return null;
  const existingRole = data.personas?.find((role: any) => role.id === 'example-' + choice);
  const start = async (profileId: string) => {
    const result = await act(() => rpc('characters.examples.create', { profileId, requestId, characterId: choice }), '');
    if (result) openRole({ id: result.roles[0], name: catalog.characters.find((c: any) => c.id === choice)?.name });
  };
  return (
    <section className="starter-characters card">
      {!catalog.existing && <section className="starter-setup">
        <h2>{t('选择聊天伙伴')}</h2>
        <div className="starter-character-grid">{catalog.characters.map((entry: any) => <label key={entry.id} className="starter-choice">
          <input type="radio" name="starter-character" value={entry.id} checked={choice === entry.id} onChange={() => setChoice(entry.id)} />
          <img src={entry.portrait} width="48" height="48" alt="" /><span><strong>{entry.name}</strong><br/>{t(entry.description)}</span></label>)}</div>
        {data.profiles.filter((p: any) => p.available && p.eligibility?.conversation).length > 0 &&
          <ModelChoice label="主会话模型" data={data} value={model} onChange={setModel} inherit={false} />}
        <div className="row wrap"><Button onClick={() => existingRole ? openRole(existingRole) : model ? void start(model) : setConnecting(true)}>{t('开始聊天')}</Button>
          <Button secondary onClick={openKnowledge}>{t('打开知识库')}</Button></div>
        {connecting && <QuickModel localRuntime={data.plugins.some((p: any) => p.id === 'local-models' && p.enabled)}
          onReady={async id => { setModel(id); await start(id); }} />}
      </section>}
      <div className="page-title-actions">
        <div>
          <h2>{t('从示例开始')}</h2>
          <p>{t('两位风格互补的伙伴，以及她们的双人工作室。')}</p>
        </div>
        <Button secondary onClick={() => setExpanded(!expanded)}>
          {t(expanded ? '收起' : '查看示例')}
        </Button>
      </div>
      {expanded && (
        <>
          <div className="starter-character-grid">
            {catalog.characters.map((role: any) => (
              <article key={role.id}>
                <img src={role.preview} alt={role.name} width="144" height="156" />
                <div>
                  <h3>{role.name}</h3>
                  <p>{t(role.description)}</p>
                  <span className="muted">{t('角色 · 记忆 · 桌宠 · 自动化')}</span>
                </div>
              </article>
            ))}
          </div>
          <p>
            {t(
              '按已启用的功能创建任务模板，任务与桌宠初始暂停。',
            )}
          </p>
          {!catalog.existing && (
            <>
              <ModelChoice
                label="主会话模型"
                data={data}
                value={model}
                onChange={setModel}
                inherit={false}
              />
              <p className="muted">
                {t(
                  '选择一个可聊天的模型。屏幕观察可以另选视觉模型。',
                )}
              </p>

            </>
          )}
          <div className="row wrap">
            <Button
              disabled={!catalog.existing && !model}
              onClick={() =>
                act(async () => {
                  const result =
                    catalog.existing ??
                    (await rpc('characters.examples.create', { profileId: model, requestId }));
                  setCatalog({ ...catalog, existing: result });
                  const role = data.personas.find((entry: any) => entry.id === result.roles[0]) ?? {
                    id: result.roles[0],
                    name: 'Hina',
                  };
                  openRole(role);
                })
              }
            >
              {t(catalog.existing ? '打开示例角色' : '创建两个角色及群聊')}
            </Button>
            {catalog.existing && catalog.existing.version !== catalog.version && (
              <Button
                secondary
                onClick={() =>
                  act(async () => {
                    if (
                      !(await confirm({
                        title: t('更新示例文案'),
                        description: t(
                          '更新未改动的示例人设和提示词。保留你编辑过的内容，以及模型、权限、任务和已有记录。',
                        ),
                      }))
                    )
                      return;
                    const result = await rpc('characters.examples.refresh', {
                      requestId: crypto.randomUUID(),
                    });
                    setCatalog({ ...catalog, existing: result });
                  })
                }
              >
                {t('更新示例文案')}
              </Button>
            )}
            {!catalog.existing && (
              <Button secondary onClick={() => openSettings('backends')}>
                {t('配置模型服务')}
              </Button>
            )}
            <span className="muted">
              {catalog.author} ·{' '}
              <a
                href="https://creativecommons.org/licenses/by/4.0/"
                target="_blank"
                rel="noreferrer"
              >
                CC BY 4.0
              </a>{' '}
              ·{' '}
              <a href={catalog.source} target="_blank" rel="noreferrer">
                {t('素材来源')}
              </a>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
