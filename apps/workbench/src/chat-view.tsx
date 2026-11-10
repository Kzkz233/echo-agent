import { CharacterPortrait } from './character-portrait.tsx';
import { inferenceTasks } from '../../../packages/contracts/inference.ts';
import { locale, statusText } from './i18n.ts';
import { t } from './i18n.ts';
import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  replyImageSchema,
  type Conversation,
  type Message,
  type Persona,
  type Profile,
  type Run,
} from '../../../packages/contracts/index.ts';
import { rpc } from './client.ts';
import { Button, EmptyState, Icon, useConfirm } from './ui.tsx';
import { ConversationInteractions } from './host-interactions.tsx';
import { ReasoningSelect } from './reasoning-select.tsx';
import { AttachmentControls, ReplyImageView, useChatAttachments } from './chat-attachments.tsx';
import { contextCompaction } from '../../../packages/contracts/compaction.ts';
import type { DeliveryPlan } from '../../../packages/contracts/delivery.ts';
import { ConversationStatus } from './conversation-status.tsx';
import { dialogueParts, useDialoguePacing } from './dialogue-pacing.ts';
import './execution-style.css';
import './dialogue-style.css';
const RunTrace = lazy(() => import('./run-trace.tsx'));
const Markdown = lazy(() => import('./chat-markdown.tsx'));
function MessageImage({ raw }: { raw: unknown }) {
  const image = replyImageSchema.safeParse(raw);
  return image.success ? <ReplyImageView image={image.data} /> : null;
}
function DialogueMessages({ messages, name, failedRuns, partLimits }: {
  messages: Message[]; name: string; failedRuns: Record<string, string>; partLimits: ReadonlyMap<string, number>;
}) {
  const today = new Date().toDateString();
  return messages.map((message, index) => {
    const date = new Date(message.createdAt);
    const previous = index ? new Date(messages[index - 1].createdAt) : undefined;
    const showTime = !previous || date.toDateString() !== previous.toDateString() || date.getTime() - previous.getTime() >= 5 * 60_000;
    const user = message.role === 'user';
    const parts = dialogueParts(message);
    const limit = partLimits.get(message.id) ?? parts.length;
    if (!limit) return null;
    const title = typeof message.meta.replyTitle === 'string' ? message.meta.replyTitle : undefined;
    return <Fragment key={message.id}>
      {showTime && <time className="dialogue-time" dateTime={message.createdAt}>
        {date.toLocaleString(locale(), { ...(date.toDateString() !== today ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' })}
      </time>}
      <article className={'dialogue-delivery ' + (user ? 'outgoing' : 'incoming')} aria-label={user ? t('你') : name}>
        {parts.slice(0, limit).map((part, partIndex) => <div className="dialogue-bubble" key={partIndex}>
          {partIndex === 0 && <>
            {((message.meta.attachments as { id: string; name: string }[]) ?? []).map((item) => (
              <span className="attachment-chip" key={item.id}>{item.name}</span>
            ))}
            {title && <strong className="dialogue-title">{title}</strong>}
          </>}
          <Suspense fallback={<span>{part}</span>}><Markdown text={part} /></Suspense>
          {message.role === 'assistant' && partIndex === parts.length - 1 && <MessageImage raw={message.meta.image} />}
        </div>)}
        {user && message.runId && failedRuns[message.runId] && <small className="dialogue-error" role="status">
          {t('执行失败')} · {failedRuns[message.runId]}
        </small>}
      </article>
    </Fragment>;
  });
}
const cached = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const defaultContextLimit = contextCompaction.parse({}).triggerTokens;
const localChat = (plan?: DeliveryPlan) => !plan?.targets || plan.targets.some((target) => target.id === 'core.chat');
const streamsInChat = (run: Run) => {
  const plan = run.meta.delivery as DeliveryPlan | undefined;
  return localChat(plan) && (plan?.targets.length ?? 0) <= 1;
};
export function ChatView({ data, act, setPage, openTask, fixedConversationId, editRole, surface, openSession }: any) {
  const dialogue = surface === 'dialogue';
  const fullSession = surface === 'session';
  const openReference = (link: any) =>
    link.type && link.taskId ? openTask(link.page, link.type, link.taskId) : setPage(link.page);
  const confirm = useConfirm();
  const [selected, select] = useState(
      () => fixedConversationId ?? sessionStorage.getItem('echo.chat') ?? '',
    ),
    [messages, setMessages] = useState<Message[]>([]),
    [loadedConversation, setLoadedConversation] = useState<string>(),
    [stream, setStream] = useState(''),
    [drafts, setDrafts] = useState<Record<string, string>>(() => cached('echo.drafts', {})),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [unresolved, setUnresolved] = useState(false),
    [activeRun, setActiveRun] = useState<string>(),
    [lastRun, setLastRun] = useState<Run>(),
    [failedRuns, setFailedRuns] = useState<Record<string, string>>({}),
    [inputs, setInputs] = useState<any[]>([]),
    [sendMode, setSendMode] = useState('queue'),
    [older, setOlder] = useState(false),
    [loadingOlder, setLoadingOlder] = useState(false),
    [newMessages, setNewMessages] = useState(false),
    [references, setReferences] = useState<any[]>(),
    [inspector, setInspector] = useState<any>(),
    [overrides, setOverrides] = useState<Record<string, Partial<Conversation>>>({});
  const hiddenRuns = useRef(new Set<string>());
  const current = useRef(selected),
    request = useRef(0),
    stick = useRef(true),
    submitting = useRef(false),
    creating = useRef(false);
  const inspectDialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null);
  current.current = selected;
  const stored = data.conversations.find((c: Conversation) => c.id === selected);
  const conversation = stored ? { ...stored, ...overrides[selected] } : undefined;
  const persona = data.personas.find((p: Persona) => p.id === conversation?.personaId);
  const inactive = data.characterActivities?.[conversation?.personaId]?.enabled === false;
  const managed =
    ['main', 'worker', 'group-member'].includes(conversation?.kind ?? '') ||
    data.characters?.some((role: any) => role.mainConversationId === selected);
  const visibleMessages = useMemo(() => fullSession ? messages : messages.filter((message) =>
    localChat(message.meta.delivery as DeliveryPlan | undefined) &&
    (!dialogue || (!message.meta.workSession &&
      (message.role === 'assistant' || message.role === 'user' || message.meta.presentationOnly === true))),
  ), [messages, fullSession, dialogue]);
  const { partLimits, reveals, revealAll, reset: resetPacing } = useDialoguePacing(
    dialogue ? selected : undefined, selected === loadedConversation, visibleMessages,
  );
  const traceMessages = new Map<string, string>();
  for (const message of visibleMessages) {
    if (message.role === 'assistant' && message.runId) traceMessages.set(message.runId, message.id);
  }
  const text = drafts[selected] ?? '';
  const attachments = useChatAttachments(selected);
  const bindingProblem = conversation?.binding && conversation.binding.state !== 'active';
  const backend = data.profiles.find(
    (p: Profile) =>
      p.id ===
      (conversation?.binding?.profileId ??
        (conversation?.kind === 'main' ? undefined : data.routes[inferenceTasks.chat])),
  );
  const hasDraft = Boolean(text.trim() || attachments.items.length);
  const steering = !dialogue && busy && sendMode === 'steer';
  const toolMode = conversation?.permissions?.pi?.tools ?? 'read';
  const modelWindow = backend?.modelOptions?.contextWindowTokens;
  const contextLimit = Math.min(
    conversation?.compaction?.triggerTokens ?? defaultContextLimit,
    typeof modelWindow === 'number' ? Math.max(0, modelWindow - backend.maxOutputTokens) : Infinity,
  );
  const statusRun = lastRun?.conversationId === selected && lastRun?.profileId === backend?.id
    ? lastRun : undefined;
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    const limit = dialogue ? 144 : 220;
    element.style.height = Math.min(limit, Math.max(dialogue ? 32 : 64, element.scrollHeight)) + 'px';
    element.style.overflowY = element.scrollHeight > limit ? 'auto' : 'hidden';
  }, [text, selected, dialogue]);
  const setText = (value: string, id = selected) => setDrafts((old) => ({ ...old, [id]: value }));
  useEffect(() => {
    sessionStorage.setItem('echo.drafts', JSON.stringify(drafts));
  }, [drafts]);
  useEffect(() => {
    if (fixedConversationId) {
      select(fixedConversationId);
      return;
    }
    if (!data.conversations.some((c: Conversation) => c.id === selected))
      select(data.conversations[0]?.id ?? '');
  }, [data.conversations, selected, fixedConversationId]);
  useEffect(() => {
    sessionStorage.setItem('echo.chat', selected);
  }, [selected]);
  const load = useCallback(async () => {
    if (!selected) return;
    const version = ++request.current;
    const [response, runs] = await Promise.all([
      rpc('conversations.messages', { id: selected, limit: 100 }),
      rpc('runs.list', { conversationId: selected }),
    ]);
    if (current.current !== selected || request.current !== version) return;
    setMessages((previous) => {
      const first = response.messages[0]?.seq ?? 0;
      const prefix = previous.filter((message) => message.seq < first);
      const combined = [...prefix, ...response.messages];
      setOlder(combined.length > 0 && combined[0].seq > 1);
      return combined;
    });
    for (const run of runs as Run[]) if (!streamsInChat(run)) hiddenRuns.current.add(run.id);
    setBusy(response.busy || runs.some((run: any) => run.state === 'running'));
    setActiveRun(runs.find((run: any) => run.state === 'running')?.id);
    setLastRun((runs as Run[]).find((run) => run.state === 'succeeded'));
    setFailedRuns(Object.fromEntries(
      (runs as Run[])
        .filter((run) => run.state === 'failed' && run.error)
        .map((run) => [run.id, run.error!]),
    ));
    setInputs(response.inputs ?? []);
    setUnresolved(runs.some((run: any) => run.state === 'unknown'));
    setLoadedConversation(selected);
    setLoading(false);
  }, [selected]);
  useEffect(() => {
    setMessages([]);
    setLoadedConversation(undefined);
    setStream('');
    setReferences(undefined);
    setBusy(false);
    setFailedRuns({});
    setUnresolved(false);
    stick.current = true;
    setLoading(Boolean(selected));
    void load().catch(() => setLoading(false));
  }, [load, selected]);
  useEffect(() => {
    const listener = (event: any) => {
      const e = event.detail;
      if (e.type === 'connection.ready') {
        resetPacing();
        setStream('');
        void load().catch(() => {});
        return;
      }
      if ((e.data.conversationId ?? e.data.run?.conversationId) !== selected) return;
      if (e.type === 'run.started') {
        if (!streamsInChat(e.data.run)) hiddenRuns.current.add(e.data.run.id);
        setBusy(true);
        setActiveRun(e.data.run.id);
      }
      if (e.type === 'input.changed') void load().catch(() => {});
      if (e.type === 'run.delta') {
        if (!surface && hiddenRuns.current.has(e.data.runId)) return;
        setStream((s) => s + e.data.text);
        if (!stick.current) setNewMessages(true);
      }
      if (['run.completed', 'message.posted'].includes(e.type)) {
        setStream('');
        void load().catch(() => {});
        if (!stick.current) setNewMessages(true);
      }
    };
    window.addEventListener('echo-event', listener);
    return () => window.removeEventListener('echo-event', listener);
  }, [selected, load, surface, resetPacing]);
  useEffect(() => {
    if (stick.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
      setNewMessages(false);
    }
  }, [messages, stream, busy, reveals]);
  const create = async () => {
    if (creating.current) return;
    creating.current = true;
    try {
      const c = await act(
        () =>
          rpc('conversations.create', {
            title: t('新的对话'),
            personaId: conversation?.personaId ?? data.personas[0]?.id ?? 'companion',
          }),
        t('已创建对话'),
      );
      if (c) {
        select(c.id);
        setQuery('');
        setTimeout(() => input.current?.focus(), 0);
      }
    } finally {
      creating.current = false;
    }
  };
  const save = async (patch: Partial<Conversation>) => {
    const target = selected;
    setOverrides((old) => ({ ...old, [target]: { ...old[target], ...patch } }));
    const result = await act(
      () => rpc('conversations.update', { id: target, ...patch }),
      t('会话设置已保存'),
    );
    setOverrides((old) => {
      const next = { ...old[target] };
      for (const key of Object.keys(patch) as (keyof Conversation)[])
        if (next[key] === patch[key]) delete next[key];
      return { ...old, [target]: next };
    });
    return result;
  };
  async function remove(c: Conversation) {
    const all = await act(() => rpc('conversations.references', { id: c.id }), '');
    if (!all) return;
    const refs = all.filter((ref: any) => ref.blocksDeletion);
    if (refs.length) {
      select(c.id);
      setReferences(refs);
      await confirm({
        title: t('先解除会话绑定'),
        description: (
          <>
            <p>
              “{c.title}
              {t('”仍被以下功能使用。先在对应页面解除绑定，再删除会话。')}
            </p>
            <ul>
              {refs.map((ref: any, i: number) => (
                <li key={i}>{ref.label}</li>
              ))}
            </ul>
            <p>{t('这样可以避免后台继续向已删除的会话投递。')}</p>
          </>
        ),
        confirmLabel: t('我知道了'),
      });
      return;
    }
    if (
      !(await confirm({
        title: t('删除这段对话？'),
        danger: true,
        confirmLabel: t('删除会话'),
        description: (
          <>
            <p>
              “{c.title}
              {t('”的聊天记录将从 Echo 删除，已绑定的宿主会话会归档。')}
            </p>
            <p>{t('角色、已保存的记忆和知识档案会保留。此操作无法撤销。')}</p>
          </>
        ),
      }))
    )
      return;
    const result = await act(
      () => rpc('conversations.delete', { id: c.id, confirmed: true }),
      t('会话已删除'),
    );
    if (result) {
      setDrafts((old) => {
        const next = { ...old };
        delete next[c.id];
        return next;
      });
      if (selected === c.id) {
        select('');
        setMessages([]);
        setStream('');
      }
    }
  }
  async function send() {
    if (
      inactive ||
      (!text.trim() && !attachments.items.length) ||
      !selected ||
      attachments.loading ||
      unresolved ||
      bindingProblem ||
      !backend ||
      submitting.current
    )
      return;
    const value = text,
      target = selected;
    submitting.current = true;
    if (dialogue) revealAll();
    setText('', target);
    setBusy(true);
    stick.current = true;
    const result = await act(async () => {
      const queued = await rpc(
        steering ? 'conversations.steer' : 'conversations.send',
        {
          conversationId: target,
          text: value || t('请查看附件。'),
          requestId: crypto.randomUUID(),
          attachmentIds: attachments.items.map((item) => item.id),
          ...(fullSession ? { workSession: true } : {}),
          ...(steering ? { runId: activeRun } : {}),
        },
      );
      if (
        ['新的对话', 'New conversation'].includes(conversation.title) &&
        !messages.some((m) => m.source === 'human')
      )
        await rpc('conversations.update', {
          id: target,
          title: value.trim().replace(/\s+/g, ' ').slice(0, 28),
        }).catch(() => {});
      return queued;
    }, '');
    submitting.current = false;
    if (!result) {
      setText(value, target);
      if (current.current === target) setBusy(false);
    } else attachments.clear(target);
    if (current.current === target) await load().catch(() => {});
    input.current?.focus();
  }
  const filtered = data.conversations
    .filter((c: any) =>
      (c.title + ' ' + (data.personas.find((p: Persona) => p.id === c.personaId)?.name ?? ''))
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((a: any, b: any) =>
      (b.lastActiveAt ?? b.createdAt).localeCompare(a.lastActiveAt ?? a.createdAt),
    );
  return (
    <div className={'chat-layout' + (fixedConversationId ? ' character-chat' : '') + (dialogue ? ' dialogue-layout' : '')}>
      {!fixedConversationId && (
        <aside className="conversation-list">
          <div className="conversation-heading">
            <div>
              <h2>{t('对话')}</h2>
              <span className="count-badge">{data.conversations.length}</span>
            </div>
            <button
              className="icon-button new-chat"
              aria-label={t('新建对话')}
              title={t('新建对话')}
              onClick={create}
            >
              <Icon name="plus" size={18} />
            </button>
          </div>
          <label className="conversation-search">
            <Icon name="search" size={15} />
            <input
              aria-label={t('搜索会话')}
              placeholder={t('搜索对话或角色')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="conversation-items">
            {filtered.map((c: any) => {
              const name =
                data.personas.find((p: Persona) => p.id === c.personaId)?.name ?? c.personaId;
              return (
                <div
                  key={c.id}
                  className={'conversation-row ' + (selected === c.id ? 'selected' : '')}
                >
                  <button
                    className="conversation"
                    onClick={() => select(c.id)}
                    aria-current={selected === c.id ? 'true' : undefined}
                  >
                    <CharacterPortrait
                      className="conversation-avatar"
                      persona={data.personas.find((p: Persona) => p.id === c.personaId) ?? { name }}
                    />
                    <span className="conversation-description">
                      <strong>{c.title}</strong>
                      <small>
                        {c.lastMessage?.role === 'system'
                          ? t('应用上下文')
                          : c.lastMessage?.text || name}
                      </small>
                    </span>
                  </button>
                  <button
                    className="conversation-delete icon-button"
                    aria-label={t('删除会话 ') + c.title}
                    title={t('删除会话')}
                    onClick={() => remove(c)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              );
            })}
            {!filtered.length && (
              <div className="list-empty">
                {query ? t('没有找到匹配的对话') : t('还没有对话，点击 + 开始')}
              </div>
            )}
          </div>
        </aside>
      )}
      <section className="chat-main" data-conversation={conversation?.id}>
        {!conversation ? (
          <div className="welcome">
            <div className="welcome-symbol">
              <Icon name="chat" size={42} />
            </div>
            <h1>{t('让对话有自己的延续')}</h1>
            <div className="row">
              <Button onClick={create}>
                {t('开始一段对话')}
                <Icon name="arrow" size={16} />
              </Button>
              <Button secondary onClick={() => setPage('backends')}>
                {t('配置模型服务')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {!dialogue && <div className="chat-toolbar">
              <div className="chat-title-row">
                <CharacterPortrait className="chat-persona-avatar" persona={persona} />
                <div className="chat-title-main">
                  <input
                    key={conversation.id + conversation.title}
                    className="title-input"
                    aria-label={t('会话标题')}
                    defaultValue={conversation.title}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        e.currentTarget.value = conversation.title;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      const title = e.target.value.trim();
                      if (title && title !== conversation.title) void save({ title });
                      else e.target.value = conversation.title;
                    }}
                  />
                  <small>
                    {persona?.name ?? 'Echo'}
                    <span>·</span>
                    <span className="chat-model-info" title={backend?.name}>
                      {backend?.model || backend?.name || t('尚未选择后端')}
                    </span>
                  </small>
                </div>
                <button
                  className="icon-button"
                  title={t('会话状态与上下文')}
                  aria-label={t('会话状态与上下文')}
                  onClick={() =>
                    act(async () => {
                      const [runs, links, catalog] = await Promise.all([
                        rpc('runs.list', { conversationId: selected }),
                        rpc('conversations.references', { id: selected }),
                        rpc('conversations.toolCatalog', { id: selected }),
                      ]);
                      setInspector({ runs, links, catalog });
                      inspectDialog.current?.showModal();
                    }, '')
                  }
                >
                  <Icon name="diagnostics" size={17} />
                </button>
                <button
                  className="icon-button"
                  title={t('导出完整会话')}
                  aria-label={t('导出会话')}
                  onClick={() =>
                    act(async () => {
                      const record = await rpc('conversations.export', { id: selected });
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
                      );
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = conversation.title.replace(/[\\/:*?"<>|]/g, '_') + '.json';
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }, t('会话已导出'))
                  }
                >
                  <Icon name="backup" size={17} />
                </button>
                <button
                  className="icon-button delete-action"
                  aria-label={t('删除当前会话')}
                  title={t('删除当前会话')}
                  onClick={() => remove(conversation)}
                >
                  <Icon name="trash" size={17} />
                </button>
              </div>
            </div>}
            {!dialogue && references?.length ? (
              <div className="chat-binding-notice">
                <div>
                  <strong>{t('此会话仍有绑定')}</strong>
                  <span>{t('请先解除绑定，再删除聊天记录。')}</span>
                </div>
                <div className="row wrap">
                  {references.map((ref, i) => (
                    <button key={i} className="text-button" onClick={() => openReference(ref)}>
                      {ref.label}
                      <Icon name="arrow" size={13} />
                    </button>
                  ))}
                  <button
                    className="icon-button"
                    aria-label={t('收起绑定提示')}
                    onClick={() => setReferences(undefined)}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              </div>
            ) : null}
            {!dialogue && <dialog className="workspace-drawer conversation-inspector" ref={inspectDialog}>
              <div className="drawer-heading">
                <h2>{t('会话状态与上下文')}</h2>
                <button
                  className="icon-button"
                  aria-label={t('关闭会话状态')}
                  onClick={() => inspectDialog.current?.close()}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
              <h3>{conversation.title}</h3>
              <dl className="context-facts">
                <dt>{t('角色')}</dt>
                <dd>{persona?.name ?? 'Echo'}</dd>
                <dt>{t('语言模型')}</dt>
                <dd>{backend?.name ?? t('未选择')}</dd>
                <dt>{t('人格与记忆')}</dt>
                <dd>{conversation.injection ? t('已启用') : t('未启用')}</dd>
                <dt>{t('记忆整理')}</dt>
                <dd>{conversation.review ? t('纳入整理') : t('未启用')}</dd>
              </dl>
              <section className="conversation-tools">
                <h3>
                  {t('可用工具')}{' '}
                  <small>
                    {inspector?.catalog?.runtime === 'pi'
                      ? t('内置执行器')
                      : inspector?.catalog?.runtime}
                  </small>
                </h3>
                <details>
                  <summary>
                    {t('工具清单')} · {inspector?.catalog?.tools?.length ?? 0}
                  </summary>
                  <div className="tool-catalog-list">
                    {inspector?.catalog?.tools?.map((tool: any) => (
                      <div key={tool.name}>
                        <code>{tool.name}</code>
                        <span>{t(tool.access === 'read' ? '只读' : '需要审批')}</span>
                        <p>{tool.description}</p>
                      </div>
                    ))}
                  </div>
                </details>
              </section>
              <section>
                <h3>{t('会话通道与自动化')}</h3>
                {inspector?.links?.length ? (
                  (
                    [
                      ['channel', '收发通道'],
                      ['trigger', '可发起对话'],
                      ['material', '读取历史'],
                      ['report', '接收报告'],
                    ] as const
                  ).map(([role, label]) => {
                    const links = inspector.links.filter((link: any) => link.role === role);
                    return (
                      links.length > 0 && (
                        <div key={role} className="context-link-group">
                          <h4>{t(label)}</h4>
                          {links.map((link: any, index: number) => (
                            <button
                              key={index}
                              className="context-connection text-button"
                              onClick={() => {
                                inspectDialog.current?.close();
                                openReference(link);
                              }}
                            >
                              {t(link.label)}
                              {!link.enabled && <small> · {t('已停用')}</small>} ↗
                            </button>
                          ))}
                        </div>
                      )
                    );
                  })
                ) : (
                  <p className="muted">{t('没有其他功能绑定此会话')}</p>
                )}
              </section>
              <section>
                <h3>{t('近期运行')}</h3>
                {inspector?.runs
                  ?.slice(-8)
                  .reverse()
                  .map((run: any) => (
                    <div className="context-run" key={run.id}>
                      <b>
                        {t(
                          (
                            {
                              human: '聊天',
                              care: '主动交流',
                              observation: '观察互动',
                              trigger: '邮件提醒',
                            } as any
                          )[run.source] ?? '应用请求',
                        )}
                      </b>
                      <span>{statusText(run.state)}</span>
                      {run.error && (
                        <p className="warning">
                          {typeof run.error === 'string' ? run.error : run.error.message}
                        </p>
                      )}
                    </div>
                  ))}
              </section>
              <details>
                <summary>{t('最近的上下文注入')}</summary>
                {messages
                  .filter((m: any) => m.role === 'system')
                  .slice(-8)
                  .map((m: any) => (
                    <div className="injection-record" key={m.id}>
                      <small>{t(m.meta?.kind === 'memory' ? '记忆召回' : '应用上下文')}</small>
                      <pre>{m.text}</pre>
                    </div>
                  ))}
              </details>
            </dialog>}
            <div
              className="messages"
              ref={scroller}
              aria-busy={loading}
              onScroll={() => {
                const el = scroller.current!;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                if (stick.current) setNewMessages(false);
              }}
            >
              {older && (
                <div className="load-older">
                  <Button
                    secondary
                    disabled={loadingOlder}
                    onClick={async () => {
                      const target = selected,
                        el = scroller.current!,
                        height = el.scrollHeight,
                        top = el.scrollTop;
                      setLoadingOlder(true);
                      revealAll();
                      stick.current = false;
                      try {
                        const response = await rpc('conversations.messages', {
                          id: target,
                          before: messages[0].seq,
                          limit: 100,
                        });
                        if (current.current === target) {
                          setMessages((current) => [...response.messages, ...current]);
                          setOlder(
                            response.messages.length === 100 && response.messages[0]?.seq > 1,
                          );
                          requestAnimationFrame(() => {
                            el.scrollTop = top + el.scrollHeight - height;
                          });
                        }
                      } finally {
                        setLoadingOlder(false);
                      }
                    }}
                  >
                    {t('加载更早记录')}
                  </Button>
                </div>
              )}
              {loading ? (
                <div className="chat-loading">
                  <span className="spinner" />
                  {t('正在读取对话')}
                </div>
              ) : (
                visibleMessages.length === 0 && (
                  <EmptyState
                    title={t('和 {name} 聊聊吧', { name: persona?.name ?? 'Echo' })}
                    icon="chat"
                  >
                    {t('从一个想法、一件小事开始。')}
                  </EmptyState>
                )
              )}
              {dialogue ? <DialogueMessages messages={visibleMessages} name={persona?.name ?? 'Echo'} failedRuns={failedRuns} partLimits={partLimits} /> : visibleMessages.map((message) =>
                message.role === 'system' || message.role === 'tool' ? (
                  <details
                    className={
                      'control-message ' +
                      (message.source === 'notification' ? 'notification-message' : '')
                    }
                    key={message.id}
                  >
                    <summary>
                      <Icon
                        name={
                          message.source === 'observation'
                            ? 'observation'
                            : message.source === 'notification'
                              ? 'notifications'
                              : 'memory'
                        }
                        size={13}
                      />
                      {message.source === 'notification'
                        ? t('程序通知')
                        : message.source === 'observation'
                          ? t('视觉观察')
                          : message.source === 'trigger'
                            ? message.meta.triggerKind &&
                              message.meta.triggerKind !== 'mail-triggers.arrived'
                              ? t('自动化信号')
                              : t('邮件提醒信号')
                            : message.meta.kind === 'memory'
                              ? t('记忆召回')
                              : t('应用上下文')}
                      <time>
                        {new Date(message.createdAt).toLocaleTimeString(locale(), {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </summary>
                    <pre>{message.text}</pre>
                  </details>
                ) : (
                  <article key={message.id} className={'message ' + message.role}>
                    <div className="message-avatar">
                      {message.role === 'user' ? t('你') : <CharacterPortrait persona={persona} />}
                    </div>
                    <div className="message-content">
                      <div className="message-author">
                        <strong>
                          {message.role === 'user' ? t('你') : (persona?.name ?? 'Echo')}
                        </strong>
                        <time>
                          {new Date(message.createdAt).toLocaleTimeString(locale(), {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                        {message.source === 'observation' && (
                          <span className="tag">{t('观察互动')}</span>
                        )}
                        {message.source === 'care' && <span className="tag">{t('主动交流')}</span>}
                        {message.source === 'trigger' && (
                          <span className="tag">
                            {message.meta.triggerKind &&
                            message.meta.triggerKind !== 'mail-triggers.arrived'
                              ? t('自动化触发')
                              : t('邮件提醒')}
                          </span>
                        )}
                      </div>
                      <div className="message-body">
                        {((message.meta.attachments as any[]) ?? []).map((item) => (
                          <span className="attachment-chip" key={item.id}>
                            {item.name}
                          </span>
                        ))}
                        {!dialogue && message.role === 'assistant' &&
                          message.runId &&
                          traceMessages.get(message.runId) === message.id &&
                          backend?.sessionCapabilities?.events && (
                            <Suspense fallback={null}>
                              <RunTrace runId={message.runId} />
                            </Suspense>
                          )}
                        {typeof message.meta.replyTitle === 'string' && <strong>{message.meta.replyTitle}</strong>}
                        <Suspense fallback={<pre>{message.text}</pre>}>
                          <Markdown text={message.text} />
                        </Suspense>
                        {message.role === 'assistant' && <MessageImage raw={message.meta.image} />}
                        {message.role === 'user' && message.runId && failedRuns[message.runId] && (
                          <>
                            <p className="warning">
                              <strong>{t('执行失败')}</strong> · {failedRuns[message.runId]}
                            </p>
                            {!dialogue && backend?.sessionCapabilities?.events && (
                              <Suspense fallback={null}>
                                <RunTrace runId={message.runId} />
                              </Suspense>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </article>
                ),
              )}
              {busy && (dialogue ? (
                <div className="dialogue-delivery incoming" role="status" aria-label={t('正在思考')}>
                  <div className="dialogue-bubble dialogue-typing"><div className="typing-dots"><i /><i /><i /></div></div>
                </div>
              ) : (
                <article className="message assistant streaming">
                  <CharacterPortrait className="message-avatar" persona={persona} />
                  <div className="message-content">
                    {!dialogue && activeRun && backend?.sessionCapabilities?.events && (
                      <Suspense fallback={null}>
                        <RunTrace runId={activeRun} active />
                      </Suspense>
                    )}
                    <div className="message-author">
                      <strong>{persona?.name ?? 'Echo'}</strong>
                      <span>{stream && !dialogue ? t('正在回复') : t('正在思考')}</span>
                    </div>
                    {stream && !dialogue ? (
                      <div className="message-body stream-text">
                        {stream.replace(/(?:^|\n)\[ECHO_STICKER:[^\n]*$/g, '')}
                      </div>
                    ) : (
                      <div className="typing-dots">
                        <i />
                        <i />
                        <i />
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {newMessages && (
              <button
                className="new-messages"
                onClick={() => {
                  stick.current = true;
                  scroller.current!.scrollTo({
                    top: scroller.current!.scrollHeight,
                    behavior: 'smooth',
                  });
                  setNewMessages(false);
                }}
              >
                {t('回到最新消息 ↓')}
              </button>
            )}
            <div className="chat-composer-area">
              <ConversationInteractions key={selected} id={selected} act={act} openSession={dialogue ? openSession : undefined} />
              {!backend ? (
                <div className="composer-warning">
                  {t('请在角色配置中选择语言模型。')}
                  <button
                    className="text-button"
                    onClick={() =>
                      managed && editRole && persona ? editRole(persona, 3) : setPage('backends')
                    }
                  >
                    {t('前往配置')} <Icon name="arrow" size={13} />
                  </button>
                </div>
              ) : unresolved ? (
                <div className="composer-warning">
                  {t('上次执行的结果尚未确认。')}
                  <button className="text-button" onClick={() => dialogue ? openSession?.() : setPage('diagnostics')}>
                    {t('查看诊断')} <Icon name="arrow" size={13} />
                  </button>
                </div>
              ) : bindingProblem ? (
                <div className="composer-warning">
                  {t('后端绑定尚未完成。')}
                  <Button
                    secondary
                    onClick={() =>
                      act(
                        () => rpc('conversations.bind', { id: selected, profileId: backend.id }),
                        t('已重新绑定'),
                      )
                    }
                  >
                    {t('重新绑定')}
                  </Button>
                </div>
              ) : null}
              {attachments.issue && (
                <p className="warning" role="alert">
                  {attachments.issue}
                </p>
              )}
              <div className="composer">
                {!dialogue && <div className="input-queue">
                  {inputs
                    .filter(
                      (item) =>
                        item.state === 'queued' ||
                        (item.kind === 'steer' &&
                          (item.runId === activeRun || item.state === 'unknown')),
                    )
                    .map((item) => (
                      <div key={item.id}>
                        <span>
                          {t(
                            (
                              {
                                queued: '已排队',
                                accepted: '补充已接受',
                                running: '正在投递',
                                unknown: '投递结果待核对',
                                failed: '投递失败',
                              } as any
                            )[item.state] ?? item.state,
                          )}
                        </span>
                        <span>{item.text}</span>
                        {item.kind === 'input' && item.state === 'queued' && (
                          <button
                            className="text-button"
                            onClick={() =>
                              act(() =>
                                rpc('conversations.cancelInput', {
                                  conversationId: selected,
                                  requestId: item.requestId,
                                }),
                              )
                            }
                          >
                            {t('移除')}
                          </button>
                        )}
                        {item.kind === 'steer' && item.state === 'unknown' && (
                          <button
                            className="text-button"
                            onClick={() =>
                              act(() =>
                                rpc('conversations.resolveInput', {
                                  conversationId: selected,
                                  requestId: item.requestId,
                                  confirmed: true,
                                }),
                              )
                            }
                          >
                            {t('已核对，不重发')}
                          </button>
                        )}
                      </div>
                    ))}
                </div>}
                {attachments.items.length > 0 && (
                  <div className="attachment-chips">
                    {attachments.items.map((item) => (
                      <span className="attachment-chip" key={item.id}>
                        <Icon name="files" size={14} />
                        <span>{item.name}</span>
                        <button
                          title={t('移除附件')}
                          aria-label={t('移除附件')}
                          onClick={() => attachments.remove(item.id)}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  ref={input}
                  disabled={inactive}
                  aria-label={t('聊天消息')}
                  title={t('Enter 发送') + ' · ' + t('Shift + Enter 换行')}
                  aria-describedby={'composer-help-' + selected}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData.files);
                    if (files.length) {
                      e.preventDefault();
                      void attachments.upload(files);
                    }
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void attachments.upload(Array.from(e.dataTransfer.files));
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing &&
                      e.nativeEvent.keyCode !== 229
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={inactive ? t('启用角色后继续交流') : t('对 {name} 说点什么…', { name: persona?.name ?? 'Echo' })}
                  rows={dialogue ? 1 : 2}
                />
                <span className="visually-hidden" id={'composer-help-' + selected}>
                  {t('Enter 发送')} · {t('Shift + Enter 换行')}
                </span>
                <div className="composer-footer">
                  <div className="composer-controls">
                    <AttachmentControls
                      attachments={attachments}
                      act={act}
                      projectDirectory={dialogue ? undefined : conversation.permissions?.projectDirectory}
                    />
                    {!dialogue && <ReasoningSelect
                      compact
                      label="本会话思考强度"
                      disabled={busy}
                      value={conversation.reasoning ?? 'inherit'}
                      profileId={backend?.id}
                      onChange={(value) =>
                        act(
                          () => rpc('conversations.update', { id: selected, reasoning: value }),
                          '',
                        )
                      }
                    />}
                    {!dialogue && backend && ['api', 'pi'].includes(backend.kind) && (
                      <span className="composer-permission" title={t('项目文件权限，应用工具另行授权')}>
                        <Icon name="approvals" size={13} />
                        {t(
                          conversation.permissions?.pi.fullAccess ? '本机完全访问' : toolMode === 'none'
                            ? '文件工具已关闭'
                            : toolMode === 'ask' && conversation.permissions?.pi.projectWrite
                              ? conversation.permissions.pi.fileApproval === 'allow' ? '工作区读写' : '文件修改需审批'
                              : '文件只读',
                        )}
                      </span>
                    )}
                    {!dialogue && conversation.kind === 'main' && backend && (
                      <ConversationStatus key={selected} run={statusRun} limit={contextLimit} />
                    )}
                    {!dialogue && busy && (
                      <select
                        className="composer-send-mode"
                        aria-label={t('发送方式')}
                        value={sendMode}
                        onChange={(event) => setSendMode(event.target.value)}
                      >
                        <option value="queue">{t('排队下一条')}</option>
                        {backend?.sessionCapabilities?.steer && (
                          <option value="steer">{t('补充当前任务')}</option>
                        )}
                      </select>
                    )}
                  </div>
                  <div className="composer-submit-actions">
                    {busy && (
                      <button
                        type="button"
                        className={'composer-stop' + (!hasDraft ? ' is-primary' : '')}
                        title={t('停止执行')}
                        aria-label={t('停止执行')}
                        onClick={() =>
                          act(() => rpc('conversations.cancel', { id: selected }), t('已请求停止'))
                        }
                      >
                        <Icon name="stop" size={18} />
                      </button>
                    )}
                    {(!busy || hasDraft) && (
                      <button
                        type="button"
                        className="composer-send"
                        title={t(
                          busy ? (steering ? '补充指令' : '排队发送') : '发送消息',
                        )}
                        aria-label={t(
                          busy ? (steering ? '补充指令' : '排队发送') : '发送消息',
                        )}
                        disabled={
                          inactive ||
                          (!text.trim() && !attachments.items.length) ||
                          attachments.loading ||
                          !backend ||
                          unresolved ||
                          Boolean(bindingProblem)
                        }
                        onClick={send}
                      >
                        <Icon name="send" size={19} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
