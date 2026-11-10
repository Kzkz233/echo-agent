import { useEffect, useState } from 'react';
import { buildInfo, type BuildInfo } from '../../../packages/contracts/build.ts';
import { rpc } from './client.ts';
import { Button, PathInput, useConfirm } from './ui.tsx';
import { locale, t } from './i18n.ts';
import './updates-style.css';

export async function confirmDesktopReady() {
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core');
    // A mismatched frontend remains visible, but cannot confirm a trial installation.
    await invoke('desktop_ready', { frontend: buildInfo }).catch(() => {});
  }
}
function editionName(value?: string) {
  return value === 'public' ? t('公开版') : value === 'private' ? t('自用版') : t('开发版');
}
function BuildCard({ label, value }: { label: string; value?: BuildInfo }) {
  return (
    <div className="version-card">
      <span>{label}</span>
      <strong>{value?.version ?? '—'}</strong>
      {value ? (
        <>
          <span className="muted">{editionName(value.edition)}</span>
          <time>{new Date(value.builtAt).toLocaleString(locale())}</time>
          <code title={value.buildId}>{value.buildId.slice(0, 8)}</code>
        </>
      ) : (
        <span className="muted">{t('浏览器连接')}</span>
      )}
    </div>
  );
}
export function UpdatesView() {
  const [status, setStatus] = useState<any>(),
    [desktop, setDesktop] = useState<BuildInfo>();
  const [path, setPath] = useState(''),
    [busy, setBusy] = useState(false),
    [issue, setIssue] = useState('');
  const confirm = useConfirm();
  const refresh = async () => setStatus(await rpc('updates.status'));
  useEffect(() => {
    let alive = true;
    void rpc('updates.status')
      .then((value) => {
        if (alive) setStatus(value);
      })
      .catch((error) => {
        if (alive) setIssue(error.message);
      });
    if ('__TAURI_INTERNALS__' in window)
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke<BuildInfo>('desktop_info'))
        .then((value) => {
          if (alive) setDesktop(value);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setIssue('');
    try {
      await work();
      await refresh();
    } catch (error) {
      setIssue(error instanceof Error ? error.message : t('操作失败。'));
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    if (
      !(await confirm({
        title: status.prepared.rollback ? t('重启并回滚？') : t('重启并更新？'),
        description: t(
          'Echo 将退出并保存上一版程序。启动验收失败时自动恢复，已有任务在正常启动后继续。',
        ),
        confirmLabel: t('确认重启'),
      }))
    )
      return;
    await act(async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('install_update', { id: status.prepared.id });
    });
  };
  const actualDesktop = desktop ?? status?.desktop;
  const mismatch =
    actualDesktop &&
    status?.backend &&
    (actualDesktop.buildId !== status.backend.buildId ||
      actualDesktop.edition !== status.backend.edition);
  const progress = status?.progress;
  const native = '__TAURI_INTERNALS__' in window;
  return (
    <div className="updates-page">
      <div className="page-title">
        <h1>{t('版本与更新')}</h1>
      </div>
      <div className="version-cards">
        <BuildCard label={t('桌面程序')} value={actualDesktop} />
        <BuildCard label={t('后端服务')} value={status?.backend} />
      </div>
      {mismatch && (
        <p className="warning" role="alert">
          {t('桌面与后端构建不一致，请完整退出 Echo 后重新打开。')}
        </p>
      )}
      <section className="card update-actions">
        <h2>{t('应用更新')}</h2>
        <p className="muted">
          {status?.backend?.edition === 'public'
            ? t('从 Echo Agent 的 GitHub Releases 获取公开版更新。')
            : t('导入自用版更新包，保留自用插件。')}
        </p>
        {!status?.supported && <p>{t('请在已打包的 Windows 桌面版中更新。')}</p>}
        {status?.supported && (
          <>
            {status.backend.edition === 'public' && (
              <div className="form-actions">
                <Button
                  secondary
                  disabled={busy}
                  onClick={() => void act(() => rpc('updates.check'))}
                >
                  {t('检查更新')}
                </Button>
                {status.checkedAt && (
                  <span className="muted">
                    {status.release
                      ? t('发现新版本') + ' ' + status.release.version
                      : t('当前已是最新版本')}
                  </span>
                )}
              </div>
            )}
            {status.release && (
              <div className="update-release">
                <p>
                  <strong>{status.release.version}</strong> ·{' '}
                  {(status.release.bytes / 1024 ** 2).toFixed(0)} MB
                </p>
                <details>
                  <summary>{t('更新说明')}</summary>
                  <p className="preserve-lines">{status.release.notes}</p>
                </details>
                <Button disabled={busy} onClick={() => void act(() => rpc('updates.stage'))}>
                  {t('下载并校验')}
                </Button>
              </div>
            )}
            <div className="field">
              <span>{t('本地更新包（.echo-update）')}</span>
              <PathInput label={t('本地更新包（.echo-update）')} value={path} onChange={setPath} />
            </div>
            <div className="form-actions">
              <Button
                secondary
                disabled={busy || !path}
                onClick={() => void act(() => rpc('updates.stage', { path }))}
              >
                {t('检查更新包')}
              </Button>
            </div>
            {progress && (
              <div className="update-progress" role="status">
                <progress
                  value={progress.total ? progress.bytes : undefined}
                  max={progress.total ?? 1}
                />
                <span>
                  {progress.phase === 'downloading' ? t('正在下载') : t('正在校验和准备更新')}
                  {progress.total
                    ? ' · ' + Math.round((progress.bytes / progress.total) * 100) + '%'
                    : ''}
                </span>
              </div>
            )}
            {status.prepared && (
              <div className="update-ready">
                <div>
                  <strong>
                    {t('已准备就绪')} · {status.prepared.build.version}
                  </strong>
                  <p className="muted">{editionName(status.prepared.build.edition)}</p>
                </div>
                <Button disabled={busy || !native || mismatch} onClick={() => void install()}>
                  {status.prepared.rollback ? t('重启并回滚') : t('重启并更新')}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
      <section className="card update-actions">
        <h2>{t('回滚与恢复')}</h2>
        {status?.rollback ? (
          <>
            <p>
              {t('可回滚版本')} · <strong>{status.rollback.version}</strong> ·{' '}
              {editionName(status.rollback.edition)}
            </p>
            <Button
              secondary
              disabled={busy}
              onClick={() => void act(() => rpc('updates.rollback'))}
            >
              {t('准备回滚')}
            </Button>
          </>
        ) : (
          <p className="muted">{t('首次通过应用更新后，将保留一个可回滚版本。')}</p>
        )}
        {status?.journal && (
          <div className="update-history">
            <span>{t('最近一次更新')}</span>
            <strong>
              {status.journal.before.version} → {status.journal.after.version}
            </strong>
            <span>
              {status.journal.phase === 'complete'
                ? t('已完成')
                : status.journal.phase === 'rolled-back'
                  ? t('已自动回滚')
                  : status.journal.phase === 'failed'
                    ? t('失败')
                    : t('进行中')}
            </span>
            {status.journal.issue && <p className="warning">{status.journal.issue}</p>}
          </div>
        )}
        <p className="muted">
          {t('回滚恢复程序版本。角色、会话和资料保留当前数据，更新前数据库快照单独保存。')}
        </p>
      </section>
      {(issue || status?.issue) && (
        <p className="warning" role="alert">
          {issue || status.issue}
        </p>
      )}
    </div>
  );
}
