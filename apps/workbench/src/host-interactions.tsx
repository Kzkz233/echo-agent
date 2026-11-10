import { useEffect, useState } from 'react';
import {
  conversationPermissions,
  type ConversationPermissions,
  type HostAnswer,
  type PendingInteraction,
} from '../../../packages/contracts/interaction.ts';
import type { Profile } from '../../../packages/contracts/index.ts';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, PathInput, useConfirm } from './ui.tsx';

export function PermissionSettings({
  value,
  backend,
  disabled,
  onSave,
  managedWorkspace = false,
}: {
  value?: ConversationPermissions;
  backend?: Pick<Profile, 'kind'> & { dshSdkMode?: 'minimal' | 'full' };
  disabled: boolean;
  onSave: (settings: ConversationPermissions) => void;
  managedWorkspace?: boolean;
}) {
  const confirm = useConfirm();
  const permissions = value ?? conversationPermissions.parse({});
  const [directory, setDirectory] = useState(permissions.projectDirectory);
  useEffect(() => setDirectory(permissions.projectDirectory), [permissions.projectDirectory]);
  const kind = backend?.kind === 'api' ? 'pi' : backend?.kind;
  if (!kind) return null;
  return (
    <fieldset className="conversation-permissions" disabled={disabled}>
      <legend>{t('会话工具权限')}</legend>
      {!managedWorkspace && <div className="field">
        <PathInput label={t('会话项目目录')} value={directory} onChange={setDirectory} directory />
        {directory !== permissions.projectDirectory && (
          <div className="row">
            <Button
              secondary
              onClick={() => onSave({ ...permissions, projectDirectory: directory.trim() })}
            >
              {t('保存项目目录')}
            </Button>
          </div>
        )}
      </div>}
      {kind === 'codex' && (
        <label className="field">
          <span>{t('Codex 文件权限')}</span>
          <select
            value={permissions.codex.sandbox}
            onChange={(event) =>
              onSave({
                ...permissions,
                codex: {
                  ...permissions.codex,
                  sandbox: event.target.value as ConversationPermissions['codex']['sandbox'],
                },
              })
            }
          >
            <option value="read-only">{t('只读沙箱')}</option>
            <option value="workspace-write">{t('专用工作目录可写')}</option>
          </select>
          <small>{t('可写模式需要设置会话项目目录或连接的专用工作目录。')}</small>
        </label>
      )}
      {(kind === 'codex' || kind === 'dsh') && (
        <label className="field">
          <span>{t('需要批准的操作')}</span>
          <select
            value={permissions[kind].approvals}
            onChange={(event) =>
              onSave({
                ...permissions,
                [kind]: { ...permissions[kind], approvals: event.target.value },
              })
            }
          >
            <option value="deny">{t('自动拒绝')}</option>
            <option value="ask">{t('在会话中询问')}</option>
          </select>
        </label>
      )}
      {kind === 'pi' && (
        <>
          {!managedWorkspace && <><div className="form-grid">{(['readRoots','writeRoots'] as const).map((key)=><label className="field" key={key}><span>{t(key==='readRoots'?'附加只读目录（每行一个）':'附加可写目录（每行一个）')}</span>
            <textarea rows={3} value={(permissions[key]??[]).join('\n')} onChange={(event)=>onSave({...permissions,[key]:event.target.value.split('\n').filter((path)=>path.trim())})}/>
          </label>)}</div>
          <label className="field">
            <span>{t('Pi 文件工具权限')}</span>
            <select
              value={permissions.pi.tools}
              onChange={(event) =>
                onSave({
                  ...permissions,
                  pi: {
                    ...permissions.pi,
                    tools: event.target.value as ConversationPermissions['pi']['tools'],
                  },
                })
              }
            >
              <option value="none">{t('禁用工具')}</option>
              <option value="read">{t('允许只读工具')}</option>
              <option value="ask">{t('允许写入并逐次审批')}</option>
            </select>
          </label></>}
          <label className="inline-toggle">
            <input type="checkbox" checked={Boolean(permissions.pi.fullAccess)} onChange={async (event) => {
              const fullAccess = event.target.checked;
              if (fullAccess && !await confirm({ title: t('本机完全访问'), danger: true, description: t('此会话将以当前系统账户权限访问本机文件，修改与终端命令仍需确认。') })) return;
              onSave({ ...permissions, pi: { ...permissions.pi, fullAccess } });
            }} />
            {t('本机完全访问')}
          </label>
          {!permissions.pi.fullAccess && permissions.pi.projectWrite && <label className="field">
            <span>{t('文件修改审批')}</span>
            <select value={permissions.pi.fileApproval ?? 'ask'} onChange={(event) =>
              onSave({ ...permissions, pi: { ...permissions.pi, fileApproval: event.target.value as 'ask' | 'allow' } })}>
              <option value="ask">{t('逐次确认')}</option>
              <option value="allow">{t('已授权范围内免审批')}</option>
            </select>
          </label>}
          <label className="field">
            <span>{t('Echo 工具权限')}</span>
            <select
              value={permissions.pi.echoTools ?? ''}
              onChange={(event) =>
                onSave({
                  ...permissions,
                  pi: {
                    ...permissions.pi,
                    echoTools: (event.target.value || undefined) as ConversationPermissions['pi']['echoTools'],
                  },
                })
              }
            >
              <option value="">{t('沿用原会话权限')}</option>
              <option value="none">{t('禁用工具')}</option>
              <option value="read">{t('允许只读工具')}</option>
              <option value="ask">{t('允许写入并逐次审批')}</option>
              <option value="granted">{t('允许已授权的 Echo 工具')}</option>
            </select>
            <small>{t('角色工具授权与文件权限分别设置。业务审批由对应工具处理。')}</small>
          </label>
          {!managedWorkspace && permissions.projectDirectory && (
            <label className="inline-toggle">
              <input
                type="checkbox"
                checked={permissions.pi.projectWrite}
                onChange={(event) =>
                  onSave({
                    ...permissions,
                    pi: { ...permissions.pi, projectWrite: event.target.checked },
                  })
                }
              />
              {t('逐次批准项目文件写入')}
            </label>
          )}
          {permissions.projectDirectory&&permissions.pi.projectWrite&&permissions.pi.tools==='ask'&&<label className="inline-toggle">
            <input type="checkbox" checked={Boolean(permissions.pi.terminal)} onChange={event=>onSave({...permissions,pi:{...permissions.pi,terminal:event.target.checked}})}/>
            {t('允许终端命令')}
          </label>}
          {permissions.pi.terminal&&<small>{t('需同时允许项目写入与逐次审批；命令以本机用户权限运行，项目目录不是终端沙箱。')}</small>}
        </>
      )}
      {kind === 'dsh' && (
        <small>
          {backend?.dshSdkMode === 'minimal'
            ? t(
                '当前使用 sdk-minimal，其原生终端没有文件沙箱。项目会话可在接入设置中选择完整 SDK。',
              )
            : t('文件与终端权限由 DSH SDK 的运行配置约束。')}
        </small>
      )}
    </fieldset>
  );
}

function InteractionCard({
  item,
  onAnswer,
}: {
  item: PendingInteraction;
  onAnswer: (answer: HostAnswer) => Promise<void>;
}) {
  type Response = { selected: string[]; custom?: string };
  const [answers, setAnswers] = useState<Record<string, Response>>({});
  const [sending, setSending] = useState(false);
  const send = async (answer: HostAnswer) => {
    setSending(true);
    try {
      await onAnswer(answer);
    } finally {
      setSending(false);
    }
  };
  if (item.kind === 'approval')
    return (
      <section className="host-interaction" aria-label={t('宿主审批')}>
        <strong>{t(item.title)}</strong>
        {item.detail && <pre>{item.detail}</pre>}
        <div className="row wrap">
          {item.canAllow && (
            <Button disabled={sending} onClick={() => void send({ decision: 'allow' })}>
              {t('仅允许这一次')}
            </Button>
          )}
          <Button secondary disabled={sending} onClick={() => void send({ decision: 'deny' })}>
            {t('拒绝')}
          </Button>
        </div>
      </section>
    );
  const complete = item.questions.every(
    (q) => answers[q.id]?.selected.length || answers[q.id]?.custom?.trim(),
  );
  return (
    <section className="host-interaction" aria-label={t('宿主需要确认')}>
      <strong>{t('宿主需要确认')}</strong>
      {item.questions.map((q) => {
        const answer = answers[q.id] ?? { selected: [] };
        const change = (v: Response) => setAnswers((old) => ({ ...old, [q.id]: v }));
        return (
          <fieldset key={q.id} disabled={sending}>
            <legend>{q.text}</legend>
            {q.detail && <pre>{q.detail}</pre>}
            {q.options.map((choice) => (
              <label className="inline-toggle" key={choice.label}>
                <input
                  type={q.multiple ? 'checkbox' : 'radio'}
                  name={item.id + ':' + q.id}
                  checked={answer.selected.includes(choice.label)}
                  onChange={(event) =>
                    change({
                      ...answer,
                      ...(q.multiple ? {} : { custom: undefined }),
                      selected: q.multiple
                        ? event.target.checked
                          ? [...answer.selected, choice.label]
                          : answer.selected.filter((v) => v !== choice.label)
                        : [choice.label],
                    })
                  }
                />
                <span>
                  {choice.label}
                  {choice.description && <small>{choice.description}</small>}
                </span>
              </label>
            ))}
            {q.custom && (
              <label className="field">
                <span>{t('自定义回答')}</span>
                <input
                  type={q.secret ? 'password' : 'text'}
                  autoComplete="off"
                  maxLength={4000}
                  value={answer.custom ?? ''}
                  onChange={(event) =>
                    change({
                      selected: q.multiple ? answer.selected : [],
                      custom: event.target.value,
                    })
                  }
                />
              </label>
            )}
          </fieldset>
        );
      })}
      <div className="row wrap">
        <Button
          disabled={!complete || sending}
          onClick={() =>
            void send({
              decision: 'answer',
              answers: item.questions.map((q) => ({
                id: q.id,
                selected: answers[q.id].selected,
                custom: answers[q.id].custom?.trim() || undefined,
              })),
            })
          }
        >
          {t('提交回答')}
        </Button>
        <Button secondary disabled={sending} onClick={() => void send({ decision: 'cancel' })}>
          {t('取消')}
        </Button>
      </div>
    </section>
  );
}

export function ConversationInteractions({
  id,
  act,
}: {
  id: string;
  act: (run: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [items, setItems] = useState<PendingInteraction[]>([]);
  useEffect(() => {
    let revision = 0;
    const refresh = async () => {
      const ticket = ++revision;
      const result = await rpc<PendingInteraction[]>('conversations.interactions', { id });
      if (ticket === revision) setItems(result);
    };
    const load = () => void refresh().catch(() => {});
    const listener = (event: Event) => {
      const e = (event as CustomEvent).detail;
      if (
        e.type === 'connection.ready' ||
        (e.type === 'interaction.changed' && e.data.conversationId === id)
      )
        load();
    };
    window.addEventListener('echo-event', listener);
    load();
    return () => {
      revision++;
      window.removeEventListener('echo-event', listener);
    };
  }, [id]);
  return items.length ? (
    <div className="host-interactions" aria-live="polite">
      {items.map((item) => (
        <InteractionCard
          key={item.id}
          item={item}
          onAnswer={async (answer) => {
            await act(() => rpc('conversations.answer', { id, interactionId: item.id, answer }));
          }}
        />
      ))}
    </div>
  ) : null;
}

export function CodexToolCatalog({
  id,
  act,
}: {
  id: string;
  act: (run: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [tools, setTools] = useState<string[]>();
  const [loading, setLoading] = useState(false);
  return (
    <div className="conversation-tool-catalog">
      <Button
        secondary
        disabled={loading}
        onClick={async () => {
          setLoading(true);
          try {
            await act(async () => setTools(await rpc<string[]>('conversations.tools', { id })));
          } finally {
            setLoading(false);
          }
        }}
      >
        {t(loading ? '读取工具中' : '检查 Echo 工具')}
      </Button>
      {tools &&
        (tools.length ? (
          <ul>
            {tools.map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('Codex 尚未发现 Echo 工具。')}</p>
        ))}
    </div>
  );
}
