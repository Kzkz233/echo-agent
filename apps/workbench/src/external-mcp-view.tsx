import { useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, requestNavigation, useConfirm, useUnsavedChanges } from './ui.tsx';

type Kind = 'deepseek' | 'http' | 'stdio';
type Server = {
  id: string;
  name: string;
  enabled: boolean;
  hasCredential: boolean;
  config: { kind: Kind; url?: string; command?: string; args?: string[]; cwd?: string };
  tools: { name: string; title: string; description?: string }[];
};

const fromServer = (server?: Server) => ({
  name: server?.name ?? '',
  enabled: server?.enabled ?? true,
  kind: server?.config.kind ?? ('http' as Kind),
  url: server?.config.url ?? '',
  command: server?.config.command ?? '',
  args: server?.config.args?.join('\n') ?? '',
  cwd: server?.config.cwd ?? '',
  token: '',
  env: '',
});

export function ExternalMcpView({
  servers,
  act,
}: {
  servers: Server[];
  act: <T>(fn: () => Promise<T>, message?: string) => Promise<T | undefined>;
}) {
  const confirm = useConfirm();
  const [selected, setSelected] = useState<string | undefined>(servers[0]?.id);
  const server = servers.find((row) => row.id === selected);
  const [draft, setDraft] = useState(() => fromServer(server));
  const [trusted, setTrusted] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(fromServer(server));
  useUnsavedChanges(dirty, '外部 MCP');
  const change = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });
  const pick = (row?: Server) =>
    requestNavigation(() => {
      setSelected(row?.id);
      setDraft(fromServer(row));
      setTrusted(false);
    });
  const save = async () => {
    const result = await act(async () => {
      const { kind, name, enabled, url, command, args, cwd, token, env } = draft;
      const variables: [string, string][] = [];
      if (kind === 'stdio')
        for (const line of env.split(/\r?\n/).filter((line) => line.trim())) {
          const boundary = line.indexOf('=');
          if (boundary < 1) throw new Error(t('环境变量请按名称=值填写，每行一项。'));
          variables.push([line.slice(0, boundary).trim(), line.slice(boundary + 1)]);
        }
      return rpc<Server>('external-mcp.save', {
        id: selected,
        config:
          kind === 'stdio'
            ? {
                kind,
                name,
                enabled,
                command,
                args: args.split(/\r?\n/).filter((line) => line.length),
                cwd,
                confirmed: trusted || Boolean(server),
                env: variables.length ? Object.fromEntries(variables) : undefined,
              }
            : { kind, name, enabled, url, token },
      });
    }, t('连接已保存'));
    if (result) {
      setSelected(result.id);
      setDraft(fromServer(result));
    }
  };
  const commandChanged =
    draft.kind === 'stdio' &&
    (!server ||
      ['command', 'args', 'cwd'].some(
        (field) => draft[field as 'command'] !== fromServer(server)[field as 'command'],
      ));
  const hasCredential = Boolean(
    server?.hasCredential &&
    draft.kind === server.config.kind &&
    (draft.kind === 'deepseek' ||
      (draft.kind === 'http' ? draft.url === server.config.url : !commandChanged)),
  );
  return (
    <div className="plugin-layout">
      <div>
        <div className="row toolbar">
          <Button secondary onClick={() => pick()}>
            {t('添加 MCP 服务器')}
          </Button>
        </div>
        {servers.map((row) => (
          <button
            key={row.id}
            className={'plugin-row ' + (selected === row.id ? 'selected' : '')}
            onClick={() => pick(row)}
          >
            <span>
              <strong>{t(row.name)}</strong>
              <small>
                {row.config.kind === 'deepseek'
                  ? t('搜索模板')
                  : row.config.kind === 'http'
                    ? 'Streamable HTTP'
                    : 'stdio'}
              </small>
            </span>
            <span
              className={
                'state-pill ' +
                (row.enabled && (row.hasCredential || row.config.kind !== 'deepseek') ? 'on' : '')
              }
            >
              {t(
                !row.enabled
                  ? '未启用'
                  : row.config.kind === 'deepseek' && !row.hasCredential
                    ? '待配置'
                    : '已启用',
              )}
            </span>
          </button>
        ))}
      </div>
      <section className="card plugin-details">
        <div className="row between">
          <h2>{server ? t(server.name) : t('添加 MCP 服务器')}</h2>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => change({ enabled: event.target.checked })}
            />
            {t('启用连接')}
          </label>
        </div>
        {draft.kind === 'deepseek' ? (
          <p className="muted">
            {t(
              '使用 DeepSeek 官方 Search 和 Fetch API。调用计入你的 DeepSeek 账户，工具在角色权限中单独授权。',
            )}
          </p>
        ) : (
          <div className="grid two">
            <label className="field">
              <span>{t('连接名称')}</span>
              <input
                value={draft.name}
                onChange={(event) => change({ name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('传输方式')}</span>
              <select
                value={draft.kind}
                onChange={(event) => {
                  setTrusted(false);
                  change({ kind: event.target.value as Kind });
                }}
              >
                <option value="http">Streamable HTTP</option>
                <option value="stdio">{t('本机命令（stdio）')}</option>
              </select>
            </label>
          </div>
        )}
        {draft.kind === 'http' && (
          <label className="field">
            <span>{t('服务器地址')}</span>
            <input
              type="url"
              placeholder="https://example.org/mcp"
              value={draft.url}
              onChange={(event) => change({ url: event.target.value })}
            />
          </label>
        )}
        {draft.kind === 'stdio' ? (
          <>
            <label className="field">
              <span>{t('可执行命令')}</span>
              <input
                value={draft.command}
                onChange={(event) => {
                  setTrusted(false);
                  change({ command: event.target.value });
                }}
              />
            </label>
            <label className="field">
              <span>{t('参数（每行一个）')}</span>
              <textarea
                rows={3}
                value={draft.args}
                onChange={(event) => {
                  setTrusted(false);
                  change({ args: event.target.value });
                }}
              />
            </label>
            <label className="field">
              <span>{t('工作目录（可选）')}</span>
              <input
                value={draft.cwd}
                onChange={(event) => {
                  setTrusted(false);
                  change({ cwd: event.target.value });
                }}
              />
            </label>
            <label className="field">
              <span>{t('环境变量（可选）')}</span>
              <textarea
                rows={3}
                spellCheck={false}
                autoComplete="off"
                value={draft.env}
                placeholder={hasCredential ? t('已配置，留空保留') : 'NAME=value'}
                onChange={(event) => change({ env: event.target.value })}
              />
            </label>
            {commandChanged && (
              <label className="inline-toggle">
                <input
                  type="checkbox"
                  checked={trusted}
                  onChange={(event) => setTrusted(event.target.checked)}
                />
                {t('我信任该命令，允许它以我的账户运行。')}
              </label>
            )}
          </>
        ) : (
          <label className="field">
            <span>{draft.kind === 'deepseek' ? 'DeepSeek API Key' : t('访问令牌（可选）')}</span>
            <input
              type="password"
              autoComplete="off"
              value={draft.token}
              placeholder={hasCredential ? t('已配置，留空保留') : t('输入凭据')}
              onChange={(event) => change({ token: event.target.value })}
            />
          </label>
        )}
        <div className="panel-actions">
          <Button
            onClick={save}
            disabled={
              !dirty ||
              (commandChanged && !trusted) ||
              (draft.kind !== 'deepseek' &&
                (!draft.name.trim() ||
                  !(draft.kind === 'http' ? draft.url.trim() : draft.command.trim())))
            }
          >
            {t('保存连接')}
          </Button>
          <Button
            secondary
            disabled={!server || dirty || (draft.kind === 'deepseek' && !hasCredential)}
            onClick={() =>
              act(() => rpc('external-mcp.discover', { id: selected }), t('已读取工具列表'))
            }
          >
            {t('连接并读取工具')}
          </Button>
          {server && draft.kind !== 'deepseek' && (
            <Button
              danger
              onClick={async () => {
                if (
                  await confirm({
                    title: t('移除 MCP 服务器？'),
                    description: t('该服务器的工具将从角色的可用工具中移除。'),
                    confirmLabel: t('移除'),
                  })
                ) {
                  if (await act(() => rpc('external-mcp.remove', { id: selected }), t('已移除'))) {
                    setSelected(servers.find((row) => row.id !== selected)?.id);
                    setDraft(fromServer(servers.find((row) => row.id !== selected)));
                    setTrusted(false);
                  }
                }
              }}
            >
              {t('移除')}
            </Button>
          )}
        </div>
        {server && (
          <details className="setup-capability">
            <summary>
              {t('已发现的工具')} · {server.tools.length}
            </summary>
            <p className="muted">
              {t(
                draft.kind === 'deepseek'
                  ? '读取工具列表不验证 API Key，也不发起搜索。'
                  : '请在角色的应用工具权限中授权。外部服务器的工具可能执行写入操作。',
              )}
            </p>
            {server.tools.map((tool) => (
              <div key={tool.name}>
                <strong>{tool.title}</strong>
                <p className="muted">{tool.description}</p>
              </div>
            ))}
          </details>
        )}
      </section>
    </div>
  );
}
