import { useState } from 'react';
import { t } from './i18n.ts';

type Grant = {
  permission: string;
  scope: string;
  mainOnly?:boolean;
  owners: string[];
  tools: string[];
  external?: { serverId: string; server: string; tool: string; available: boolean };
};
type Plugin = {
  id: string; name: string; internalComponent?: boolean;
  settings: unknown[]; pages?: { placement: string }[];
  toolSetup?: { missing: string[] };
};
type Group = { name: string; owners: Plugin[]; serverId?: string; rows: Grant[] };

export function grantAction(permission: string) {
  if (permission === 'persona.expression.write') return t('调整渠道表达');
  if (permission === 'persona.identity.propose') return t('提议修改长期人设');
  if (permission.endsWith('.task-edit')) return t('调整已有任务');
  if (permission.endsWith('.read')) return t('读取');
  if (permission.endsWith('.write')) return t('修改');
  if (permission.endsWith('.interact')) return t('交互操作');
  if (permission.endsWith('.import')) return t('导入');
  return t('调用');
}

export function RolePluginTools({ catalog, plugins, main, workers, onMain, onWorkers, configure, features = [], selectedFeatures = [], toggleFeature }: {
  features?: {id:string; name:string}[]; selectedFeatures?: string[]; toggleFeature?: (id:string, enabled:boolean) => void;
  catalog: Grant[]; plugins: Plugin[]; main: string[]; workers?: string[];
  onMain: (permissions: string[]) => void; onWorkers: (permissions: string[]) => void;
  configure: (target: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filter = query.trim().toLocaleLowerCase();
  const groups = new Map<string, Group>();
  for (const row of catalog) {
    if (row.scope !== 'character') continue;
    const owners = row.owners.map((id) => plugins.find((plugin) => plugin.id === id))
      .filter((plugin): plugin is Plugin => Boolean(plugin));
    const name = row.external ? t(row.external.server) : owners.map((p) => t(p.name)).join(' · ') || t('共享模块');
    const key = row.external ? 'external:' + row.external.serverId : [...row.owners].sort().join(',');
    if (filter && ![name, row.external?.tool, ...owners.map((p) => p.name), grantAction(row.permission),
      row.permission, ...row.tools].some((text) => text?.toLocaleLowerCase().includes(filter))) continue;
    const group = groups.get(key) ?? { name, owners, serverId: row.external?.serverId, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const grouped = new Set([...groups.keys()]);
  for (const f of features) {
    if (grouped.has(f.id) || filter && !t(f.name).toLowerCase().includes(filter)) continue;
    const owner = plugins.find(p => p.id === f.id);
    groups.set(f.id, { name: t(f.name), owners: owner ? [owner] : [], rows: [] });
  }
  const toggle = (current: string[], permission: string, checked: boolean) =>
    checked ? [...new Set([...current, permission])] : current.filter((p) => p !== permission);
  return (
    <section className="role-plugin-tools" id="role-plugin-tools" aria-label={t('插件工具授权')}>
      <h3>{t('插件工具授权')}</h3>
      <label className="search-control">
        <input type="search" aria-label={t('搜索插件或工具')} placeholder={t('搜索插件或工具')}
          value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="role-permission-list">
        {[...groups.entries()].sort((a,b) => a[1].name.localeCompare(b[1].name)).map(([id, group]) => (
          <section key={id} className="role-grant-group" aria-label={group.name}>
            {features.some(f => f.id === id) ? <label className="role-feature-title"><input type="checkbox"
              checked={selectedFeatures.includes(id)} disabled={id === 'delegation'} onChange={e => toggleFeature?.(id,e.target.checked)} />
              <strong>{group.name}</strong></label> : <h4>{group.name}</h4>}
            {group.serverId ? (
              <div className="role-grant-setup">
                <small>{t(group.rows.every((row) => row.external?.available) ? '工具已注册' : '待配置')}</small>
                <button type="button" className="text-button" onClick={() => configure('external-mcp:' + group.serverId)}>{t('配置连接')}</button>
              </div>
            ) : group.owners.map((p) => (
              <div className="role-grant-setup" key={p.id}>
                <small>{group.owners.length > 1 && t(p.name) + ' · '}
                  {p.toolSetup ? (p.toolSetup.missing.map((hint) => t(hint)).join(' · ') || t('已配置')) : t('工具已注册')}</small>
                {!p.internalComponent && (p.toolSetup || p.settings.length > 0 || p.pages?.some((page) => page.placement === 'plugin-settings')) && <button type="button" className="text-button"
                  onClick={() => configure(p.id)}>{t('插件设置')}</button>}
              </div>
            ))}
            {group.rows.length > 0 && <small>{[...new Set(group.rows.filter(r => main.includes(r.permission)).map(r => r.external ? r.external.tool : grantAction(r.permission)))].join(' · ') || t('主会话尚未授权')}</small>}
            {group.rows.length > 0 && <details key={filter ? 'search' : 'browse'} open={filter ? true : undefined}>
              <summary>{t('工具授权')} · {t('主会话')} {group.rows.filter(row => main.includes(row.permission)).length}/{group.rows.length}
                {workers && <> · {t('子任务')} {group.rows.filter(row => !row.mainOnly && workers.includes(row.permission)).length}/{group.rows.filter(row=>!row.mainOnly).length}</>}
              </summary>
            {group.rows.map((row) => {
              const action = row.external ? t(row.external.tool) : grantAction(row.permission);
              return (
                <div className="role-tool-grant" key={row.permission} data-permission={row.permission}>
                  <span title={row.permission}>{action}
                    {!row.external && group.rows.some((other) => other !== row && grantAction(other.permission) === action) &&
                      <small>{row.permission}</small>}
                  </span>
                  <label className="inline-toggle">
                    <input type="checkbox" checked={main.includes(row.permission)}
                      onChange={(e) => onMain(toggle(main, row.permission, e.target.checked))} />
                    {t('主会话')}
                  </label>
                  {workers && !row.mainOnly && <label className="inline-toggle">
                    <input type="checkbox" checked={workers.includes(row.permission)}
                      onChange={(e) => onWorkers(toggle(workers, row.permission, e.target.checked))} />
                    {t('子任务')}
                  </label>}
                </div>
              );
            })}
            </details>}
          </section>
        ))}
      </div>
      {!groups.size && <p className="muted">{t('未找到匹配的工具')}</p>}
    </section>
  );
}
