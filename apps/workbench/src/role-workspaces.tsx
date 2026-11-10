import { useState } from 'react';
import type { ConversationPermissions } from '../../../packages/contracts/interaction.ts';
import { t } from './i18n.ts';
import { Button, PathInput } from './ui.tsx';

type Access = 'none' | 'read' | 'write';
type WorkerRoot = { path: string; write: boolean };

export function RoleWorkspaces({ permissions, workers, onMain, onWorkers }: {
  permissions: ConversationPermissions;
  workers?: WorkerRoot[];
  onMain: (permissions: ConversationPermissions) => void;
  onWorkers: (roots: WorkerRoot[]) => void;
}) {
  const [path, setPath] = useState('');
  const [draftRows, setDraftRows] = useState<string[]>([]);
  const scoped = [permissions.projectDirectory, ...(permissions.readRoots ?? []), ...(permissions.writeRoots ?? [])].filter(Boolean);
  const main = new Map<string, Access>();
  for (const directory of scoped) {
    if (!permissions.projectDirectory || permissions.pi.tools === 'none') continue;
    const write = permissions.pi.tools === 'ask' && permissions.pi.projectWrite &&
      ((directory === permissions.projectDirectory && !permissions.primaryReadOnly) || permissions.writeRoots?.includes(directory));
    main.set(directory, write ? 'write' : 'read');
  }
  const rows = [...new Set([...scoped, ...(workers ?? []).map((row) => row.path), ...draftRows])];
  const setMain = (directory: string, access: Access) => {
    if (access === 'none') main.delete(directory);
    else main.set(directory, access);
    const primary = main.has(permissions.projectDirectory) ? permissions.projectDirectory : main.keys().next().value ?? '';
    const write = [...main.values()].includes('write');
    const extras = [...main].filter(([directory]) => directory !== primary);
    onMain({
      ...permissions, projectDirectory: primary, primaryReadOnly: main.get(primary) !== 'write',
      readRoots: extras.filter(([, access]) => access === 'read').map(([directory]) => directory),
      writeRoots: extras.filter(([, access]) => access === 'write').map(([directory]) => directory),
      pi: { ...permissions.pi, tools: write ? 'ask' : 'read', projectWrite: write,
        echoTools: permissions.pi.echoTools ?? permissions.pi.tools },
    });
  };
  const select = (label: string, directory: string, access: Access, change: (access: Access) => void) => (
    <select aria-label={t(label) + ' · ' + directory} value={access} onChange={(event) => change(event.target.value as Access)}>
      <option value="none">{t('不单独授权')}</option>
      <option value="read">{t('只读')}</option>
      <option value="write">{t('读写')}</option>
    </select>
  );
  return <div className="role-workspaces">
    <p className="muted">{t('目录授权覆盖子目录。主会话与子任务的授权可以分别设置。')}</p>
    {rows.length > 0 && <table>
      <thead><tr><th>{t('工作目录')}</th><th>{t('主会话')}</th>{workers && <th>{t('可委派')}</th>}</tr></thead>
      <tbody>{rows.map((directory) => {
        const grant = workers?.find((row) => row.path === directory);
        return <tr key={directory}>
          <th scope="row" title={directory}>{directory}</th>
          <td>{select('主会话', directory, main.get(directory) ?? 'none', (access) => setMain(directory, access))}</td>
          {workers && <td>{select('可委派', directory, grant ? (grant.write ? 'write' : 'read') : 'none', (access) => {
            const rest = workers.filter((row) => row.path !== directory);
            onWorkers(access === 'none' ? rest : [...rest, { path: directory, write: access === 'write' }]);
          })}</td>}
        </tr>;
      })}</tbody>
    </table>}
    <div className="row wrap">
      <PathInput label={t('工作目录')} value={path} onChange={setPath} directory />
      <Button secondary disabled={!path.trim()} onClick={() => {
        setDraftRows((rows) => [...new Set([...rows, path.trim()])]);
        setPath('');
      }}>{t('添加目录')}</Button>
    </div>
  </div>;
}
