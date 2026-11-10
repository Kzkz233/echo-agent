import { cp, mkdir, rename, readdir, rm, stat } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { z } from 'zod';
import { buildSchema } from '../contracts/build.ts';
import { updateManifestSchema, type UpdateJournal } from '../contracts/update.ts';
import { atomicJson, contained, jsonFile, verifyApp } from './update-files.ts';

export const updatePlanSchema = z
  .object({
    format: z.literal('echo-update-plan-v1'),
    id: z.string().uuid(),
    appRoot: z.string().min(1),
    dataRoot: z.string().min(1),
    anchor: z.string().min(1),
    executable: z.enum(['Echo.exe', 'echo-desktop.exe']),
    desktopPid: z.number().int().positive(),
    backendPid: z.number().int().positive(),
    before: buildSchema,
    manifest: updateManifestSchema,
  })
  .strict();
export type UpdatePlan = z.infer<typeof updatePlanSchema>;
export function updateRoot(appRoot: string) {
  return join(dirname(appRoot), '.' + basename(appRoot) + '-updates');
}
export function validatePlan(plan: UpdatePlan, transaction: string) {
  const parent = updateRoot(plan.appRoot);
  if (
    resolve(transaction) !== join(parent, plan.id) ||
    !contained(dirname(plan.appRoot), plan.appRoot) ||
    plan.before.edition !== plan.manifest.build.edition ||
    plan.before.dataVersion !== plan.manifest.build.dataVersion ||
    !resolve(plan.dataRoot).includes(':') ||
    contained(plan.appRoot, plan.dataRoot) ||
    contained(parent, plan.dataRoot) ||
    resolve(plan.appRoot) === resolve(plan.dataRoot) ||
    contained(plan.dataRoot, plan.appRoot)
  )
    throw Error('Unsafe update transaction paths or channel');
}
export type TransactionHost = {
  stopped(): Promise<void>;
  snapshot(destination: string): Promise<void>;
  launch(trial: boolean): Promise<void>;
  healthy(): Promise<void>;
  stopTrial(): Promise<void>;
};

/** All replaceable files stay on the same volume. Data is never part of the swap. */
export async function installTransaction(
  plan: UpdatePlan,
  transaction: string,
  host: TransactionHost,
) {
  validatePlan(plan, transaction);
  const parent = updateRoot(plan.appRoot);
  const candidate = join(transaction, 'candidate', 'app');
  const previous = join(transaction, 'previous');
  const journalPath = join(parent, 'journal.json');
  const journal: UpdateJournal = {
    id: plan.id,
    phase: 'waiting',
    before: plan.before,
    after: plan.manifest.build,
    at: new Date().toISOString(),
    helperPid: process.pid,
  };
  const record = async (phase: UpdateJournal['phase'], issue?: string) => {
    Object.assign(journal, { phase, at: new Date().toISOString(), issue });
    await atomicJson(journalPath, journal);
  };
  let oldStopped = false,
    oldMoved = false,
    newMoved = false,
    trialStarted = false;
  try {
    await host.stopped();
    oldStopped = true;
    await verifyApp(candidate, plan.manifest);
    // Keep the installed shortcut target and the NSIS uninstaller across portable swaps.
    if (plan.executable !== 'Echo.exe')
      await rename(join(candidate, 'Echo.exe'), join(candidate, plan.executable));
    for (const name of await readdir(plan.appRoot))
      if (/^uninstall.*\.exe$/i.test(name))
        await cp(join(plan.appRoot, name), join(candidate, name), { force: true });
    await host.snapshot(join(transaction, 'data-snapshot.sqlite'));
    await record('waiting');
    await renameRetry(plan.appRoot, previous);
    oldMoved = true;
    await record('old-moved');
    await renameRetry(candidate, plan.appRoot);
    newMoved = true;
    await record('installed');
    // A same-volume directory rename retains the verified bytes. Readiness below
    // checks that the desktop, frontend and backend actually run that build.
    trialStarted = true;
    await host.launch(true);
    await record('verifying');
    await host.healthy();
    const oldBackup = await jsonFile<{ transaction: string }>(join(parent, 'rollback.json'));
    await atomicJson(join(parent, 'rollback.json'), {
      transaction: plan.id,
      build: plan.before,
      executable: plan.executable,
    });
    await record('complete');
    if (
      oldBackup &&
      oldBackup.transaction !== plan.id &&
      /^[a-f\d-]{36}$/.test(oldBackup.transaction)
    ) {
      const obsolete = join(parent, oldBackup.transaction);
      if (contained(parent, obsolete))
        await rm(obsolete, { recursive: true, force: true }).catch(() => {});
    }
    return journal;
  } catch (error) {
    // If the trial cannot be stopped, preserve both copies and leave its files alone.
    if (trialStarted) {
      try {
        await host.stopTrial();
      } catch {
        await record('failed', '新版进程未能退出，已保留上一版和数据快照。');
        return journal;
      }
    }
    if (newMoved) await renameRetry(plan.appRoot, join(transaction, 'failed-app'));
    if (oldMoved) await renameRetry(previous, plan.appRoot);
    try {
      await record(
        oldMoved ? 'rolled-back' : 'failed',
        error instanceof Error ? error.message : '更新失败',
      );
    } finally {
      if (oldStopped) await host.launch(false);
    }
    return journal;
  }
}
async function renameRetry(source: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        attempt >= 50 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      await new Promise((done) => setTimeout(done, 200));
    }
  }
}
export async function availableSpace(directory: string, required: number) {
  const { statfs } = await import('node:fs/promises');
  await mkdir(directory, { recursive: true });
  const info = await statfs(directory);
  if (info.bavail * info.bsize < required + 128 * 1024 ** 2) throw Error('更新所需磁盘空间不足。');
}
export async function packageSize(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 2 * 1024 ** 3) throw Error('更新包无效或过大。');
  return info.size;
}
