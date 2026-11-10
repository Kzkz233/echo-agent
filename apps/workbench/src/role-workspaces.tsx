import { useState } from 'react';
import type { ConversationPermissions } from '../../../packages/contracts/interaction.ts';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, PathInput, useConfirm } from './ui.tsx';

type Access = 'none' | 'read' | 'write';
type WorkerRoot = { path: string; write: boolean };

function directoryKey(path: string) {
  return /^[a-z]:[\\/]|^\\\\/i.test(path)
    ? path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    : path.replace(/\/+$/, '');
}

export function RoleWorkspaces({ personaId, permissions, workers, onChange }: {
  personaId: string;
  permissions: ConversationPermissions;
  workers?: WorkerRoot[];
  onChange: (permissions: ConversationPermissions, workers?: WorkerRoot[]) => void;
}) {
  const [path, setPath] = useState('');
  const [editing, setEditing] = useState<string>();
  const [issue, setIssue] = useState('');
  const [draftRows, setDraftRows] = useState<string[]>([]);
  const confirm = useConfirm();
  const scoped = [permissions.projectDirectory, ...(permissions.readRoots ?? []), ...(permissions.writeRoots ?? [])].filter(Boolean);
  const scopedEnabled = Boolean(permissions.projectDirectory) && permissions.pi.tools !== 'none';
  const main = new Map<string, Access>();
  for (const directory of scoped) {
    const write = permissions.pi.tools === 'ask' && permissions.pi.projectWrite &&
      ((directory === permissions.projectDirectory && !permissions.primaryReadOnly) || permissions.writeRoots?.includes(directory));
    main.set(directory, write ? 'write' : 'read');
  }
  const rows = [...new Set([...scoped, ...(workers ?? []).map((row) => row.path), ...draftRows])];
  const mainPermissions = (grants: Map<string, Access>, preferred: string, explicit: boolean) => {
    const primary = grants.has(preferred) ? preferred : grants.keys().next().value ?? '';
    const write = [...grants.values()].includes('write');
    const extras = [...grants].filter(([directory]) => directory !== primary);
    return {
      ...permissions, projectDirectory: primary, primaryReadOnly: grants.get(primary) !== 'write',
      readRoots: extras.filter(([, access]) => access === 'read').map(([directory]) => directory),
      writeRoots: extras.filter(([, access]) => access === 'write').map(([directory]) => directory),
      pi: {
        ...permissions.pi, tools: explicit ? (write ? 'ask' as const : 'read' as const) : permissions.pi.tools,
        projectWrite: write, echoTools: permissions.pi.echoTools ?? permissions.pi.tools,
      },
    };
  };
  const setMain = (directory: string, access: Access) => {
    const grants = scopedEnabled ? main : new Map<string, Access>();
    if (access === 'none') grants.delete(directory);
    else grants.set(directory, access);
    onChange(mainPermissions(grants, permissions.projectDirectory, true), workers);
  };
  const endEdit = () => {
    setEditing(undefined);
    setPath('');
    setIssue('');
  };
  const savePath = async () => {
    const entered = path.trim();
    if (!entered) return;
    let next: string;
    try {
      ({ path: next } = await rpc('persona.character.workspace', { id: personaId, path: entered }));
    } catch (error) {
      setIssue((error as Error).message);
      return;
    }
    if (rows.some(directory => directory !== editing && directoryKey(directory) === directoryKey(next))) {
      setIssue(t('该工作目录已添加。'));
      return;
    }
    if (editing) {
      const replace = (directory: string) => directory === editing ? next : directory;
      onChange({
        ...permissions,
        projectDirectory: replace(permissions.projectDirectory),
        readRoots: permissions.readRoots?.map(replace),
        writeRoots: permissions.writeRoots?.map(replace),
      }, workers?.map(row => ({ ...row, path: replace(row.path) })));
      setDraftRows(old => old.map(replace));
    } else {
      setDraftRows(old => [...old, next]);
    }
    endEdit();
  };
  const remove = (directory: string) => {
    const removedMain = main.delete(directory);
    onChange(removedMain ? mainPermissions(main, permissions.projectDirectory, false) : permissions,
      workers?.filter(row => row.path !== directory));
    setDraftRows(old => old.filter(row => row !== directory));
    if (editing === directory) endEdit();
  };
  const useDefault = async () => {
    setIssue('');
    try {
      const result = await rpc('persona.character.workspace', { id: personaId }) as { path: string };
      const existing = rows.find(directory => directoryKey(directory) === directoryKey(result.path));
      if (!existing || !main.has(existing) || !scopedEnabled) setMain(existing ?? result.path, 'read');
      endEdit();
    } catch (error) {
      setIssue((error as Error).message);
    }
  };
  const select = (label: string, directory: string, access: Access, change: (access: Access) => void) => (
    <select aria-label={t(label) + ' · ' + directory} value={access} onChange={(event) => change(event.target.value as Access)}>
      <option value="none">{t('不单独授权')}</option>
      <option value="read">{t('只读')}</option>
      <option value="write">{t('读写')}</option>
    </select>
  );
  return <div className="role-workspaces">
    <label className="field">
      <span>{t('主会话文件访问范围')}</span>
      <select aria-label={t('主会话文件访问范围')} value={permissions.pi.fullAccess ? 'device' : 'workspace'} onChange={async (event) => {
        const fullAccess = event.target.value === 'device';
        if (fullAccess && !await confirm({
          title: t('本机完全访问'), danger: true,
          description: t('主会话可读取当前系统账户可访问的文件。修改文件仍需逐次确认。'),
        })) return;
        onChange({ ...permissions, pi: { ...permissions.pi, fullAccess } }, workers);
      }}>
        <option value="workspace">{t('仅限授权目录')}</option>
        <option value="device">{t('本机完全访问')}</option>
      </select>
    </label>
    <p className="muted">{t('目录授权覆盖子目录。主会话与子任务的授权可以分别设置。')}</p>
    {rows.length > 0 && <table>
      <thead><tr><th>{t('工作目录')}</th><th>{t('主会话')}</th>{workers && <th>{t('可委派')}</th>}<th>{t('操作')}</th></tr></thead>
      <tbody>{rows.map((directory) => {
        const grant = workers?.find((row) => row.path === directory);
        return <tr key={directory}>
          <th scope="row" title={directory}>{directory}</th>
          <td>{select('主会话', directory, scopedEnabled ? main.get(directory) ?? 'none' : 'none',
            (access) => setMain(directory, access))}</td>
          {workers && <td>{select('可委派', directory, grant ? (grant.write ? 'write' : 'read') : 'none', (access) => {
            const rest = workers.filter((row) => row.path !== directory);
            onChange(permissions, access === 'none' ? rest : [...rest, { path: directory, write: access === 'write' }]);
          })}</td>}
          <td><div className="row wrap">
            <Button secondary aria-label={t('编辑目录') + ' · ' + directory} onClick={() => {
              setEditing(directory);
              setPath(directory);
              setIssue('');
            }}>{t('编辑')}</Button>
            <Button secondary aria-label={t('移除目录') + ' · ' + directory} onClick={() => remove(directory)}>
              {t('移除')}
            </Button>
          </div></td>
        </tr>;
      })}</tbody>
    </table>}
    <div className="row wrap">
      <PathInput label={t(editing ? '编辑目录' : '工作目录')} value={path} onChange={setPath} directory />
      <Button secondary disabled={!path.trim()} onClick={savePath}>
        {t(editing ? '保存目录' : '添加目录')}
      </Button>
      {editing
        ? <Button secondary onClick={endEdit}>{t('取消')}</Button>
        : <Button secondary onClick={useDefault}>{t('使用默认工作目录')}</Button>}
    </div>
    <small>{t(editing
      ? '主会话和子任务的目录授权会随路径修改。'
      : '默认目录独立于应用数据，使用时只为主会话添加只读权限。移除目录只撤销授权。')}</small>
    {issue && <p className="danger" role="alert">{issue}</p>}
  </div>;
}
