import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, useConfirm } from './ui.tsx';
import { ModelChoice } from './model-choice.tsx';

export function StarterCharacters({ data, act, openRole, openSettings }: any) {
  const [catalog, setCatalog] = useState<any>();
  const [model, setModel] = useState('');
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
          '',
      );
    });
  }, []);
  if (!catalog) return null;
  return (
    <section className="starter-characters card">
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
              '包含可编辑的记忆整理、主动交流和实时观察任务。任务与桌宠初始关闭，可在角色配置中分别启用。',
            )}
          </p>
          {!catalog.existing && (
            <>
              <ModelChoice
                label="语言与视觉模型"
                taskId="observation.vision"
                data={data}
                value={model}
                onChange={setModel}
                inherit={false}
              />
              <p className="muted">
                {t(
                  '使用同一多模态模型体验各项功能，默认关闭思考；本地语义检索使用随客户端提供的 BGE。',
                )}
              </p>
              <p className="muted">
                {t('启用通用插件和角色工具权限；邮箱、QQ 与屏幕观察需要自行配置账号或授权。')}
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
