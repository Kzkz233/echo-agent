import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, copyFile, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { buildInfo, buildSchema, type BuildInfo } from '../contracts/build.ts';
import { newerVersion, type UpdateJournal, type UpdateManifest } from '../contracts/update.ts';
import { invariant } from '../contracts/index.ts';
import { Registry } from './registry.ts';
import {
  atomicJson,
  fileHash,
  fileInventory,
  jsonFile,
  readUpdateManifest,
  verifyApp,
} from './update-files.ts';
import { availableSpace, packageSize, updatePlanSchema, updateRoot } from './update-transaction.ts';

const repository = 'Kzkz233/echo-agent';
type Release = {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
  notes: string;
  publishedAt: string;
};
type Prepared = { id: string; manifest: UpdateManifest; rollback: boolean; origin?: 'local' | 'github' | 'rollback' };
export type UpdateHost = {
  installRoot: string;
  executable: string;
  desktopPid: number;
  anchor: string;
  desktopBuild: BuildInfo;
};
export function desktopUpdateHost(): UpdateHost | undefined {
  try {
    return {
      installRoot: resolve(process.env.ECHO_INSTALL_DIR!),
      executable: basename(process.env.ECHO_DESKTOP_EXE!),
      desktopPid: z.coerce.number().int().positive().parse(process.env.ECHO_DESKTOP_PID),
      anchor: resolve(process.env.ECHO_STORAGE_ANCHOR!),
      desktopBuild: buildSchema.parse(JSON.parse(process.env.ECHO_DESKTOP_BUILD!)),
    };
  } catch {
    return;
  }
}
export function selectPublicRelease(value: any, current: BuildInfo): Release | undefined {
  if (current.edition !== 'public') return;
  if (value.draft || value.prerelease || !/^v\d+\.\d+\.\d+$/.test(value.tag_name ?? '')) return;
  const version = value.tag_name.slice(1);
  if (!newerVersion(version, current.version)) return;
  const name = `Echo-${version}-public-win-x64.echo-update`;
  const asset = value.assets?.find((entry: any) => entry.name === name);
  if (
    !asset ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ||
    asset.browser_download_url !==
      `https://github.com/${repository}/releases/download/v${version}/${name}` ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 2 * 1024 ** 3
  )
    return;
  return {
    version,
    url: asset.browser_download_url,
    sha256: asset.digest.slice(7),
    bytes: asset.size,
    notes: String(value.body ?? '').slice(0, 10000),
    publishedAt: String(value.published_at ?? ''),
  };
}
export class Updates {
  private release?: Release;
  private progress?: {
    phase: 'downloading' | 'checking' | 'preparing';
    bytes: number;
    total?: number;
  };
  private busy = false;
  private handedOff = false;
  private issue?: string;
  private checkedAt?: string;
  constructor(
    readonly project: string,
    readonly runtime: string,
    readonly host = desktopUpdateHost(),
    readonly current = buildInfo,
  ) {}
  private root() {
    invariant(
      this.host &&
        process.platform === 'win32' &&
        process.arch === 'x64' &&
        this.current.edition !== 'development',
      'update_unavailable',
      '请在已打包的 Windows 桌面版中更新。',
    );
    return updateRoot(this.host.installRoot);
  }
  private async prepared() {
    return jsonFile<Prepared>(join(this.root(), 'prepared.json'));
  }
  async status() {
    const supported = Boolean(
      this.host &&
      process.platform === 'win32' &&
      process.arch === 'x64' &&
      this.current.edition !== 'development',
    );
    const parent = supported ? this.root() : undefined;
    const pending = parent ? await jsonFile<Prepared>(join(parent, 'prepared.json')) : undefined;
    const rollback = parent
      ? await jsonFile<{ build: BuildInfo; transaction: string }>(join(parent, 'rollback.json'))
      : undefined;
    return {
      backend: this.current,
      desktop: this.host?.desktopBuild,
      supported,
      consistent: this.host
        ? this.host.desktopBuild.buildId === this.current.buildId &&
          this.host.desktopBuild.edition === this.current.edition
        : undefined,
      source:
        this.current.edition === 'public' ? `https://github.com/${repository}/releases` : 'local',
      checkedAt: this.checkedAt,
      release: this.release,
      progress: this.progress,
      issue: this.issue,
      prepared: pending
        ? { id: pending.id, build: pending.manifest.build, rollback: pending.rollback, origin: pending.origin ?? (pending.rollback ? 'rollback' : 'local') }
        : undefined,
      rollback: rollback?.build,
      journal: parent ? await jsonFile<UpdateJournal>(join(parent, 'journal.json')) : undefined,
    };
  }
  private async exclusive<T>(work: () => Promise<T>) {
    invariant(!this.busy && !this.handedOff, 'update_busy', '更新正在处理中。');
    this.busy = true;
    this.issue = undefined;
    try {
      return await work();
    } catch (error) {
      this.issue = error instanceof Error ? error.message : '更新失败';
      throw error;
    } finally {
      this.busy = false;
      this.progress = undefined;
    }
  }
  async check() {
    return this.exclusive(async () => {
      this.root();
      invariant(this.current.edition === 'public', 'update_channel', '自用版通过本地更新包更新。');
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Echo-Agent-Updates',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        signal: AbortSignal.timeout(15000),
      });
      invariant(
        response.ok,
        'update_network',
        response.status === 403 ? 'GitHub 请求受限，请稍后再试。' : '无法读取 GitHub 更新。',
      );
      this.release = selectPublicRelease(await response.json(), this.current);
      this.checkedAt = new Date().toISOString();
      return this.status();
    });
  }
  async stage(path?: string) {
    return this.exclusive(async () => {
      const parent = this.root(),
        id = randomUUID(),
        transaction = join(parent, id);
      const previous = await this.prepared();
      invariant(
        path || (this.current.edition === 'public' && this.release),
        'update_package',
        '请选择更新包，或先检查更新。',
      );
      await mkdir(transaction, { recursive: true });
      try {
        const archive = join(transaction, 'package.echo-update');
        if (path) {
          const bytes = await packageSize(path);
          await availableSpace(parent, bytes * 2);
          this.progress = { phase: 'checking', bytes: 0, total: bytes };
          await copyFile(path, archive);
        } else {
          const release = this.release!;
          await availableSpace(parent, release.bytes * 2);
          this.progress = { phase: 'downloading', bytes: 0, total: release.bytes };
          const response = await fetch(release.url, { signal: AbortSignal.timeout(900000) });
          invariant(response.ok && response.body, 'update_download', '更新包下载失败。');
          await pipeline(
            Readable.fromWeb(response.body as any),
            new Transform({
              transform: (chunk, _enc, done) => {
                this.progress!.bytes += chunk.length;
                done(
                  this.progress!.bytes > release.bytes ? Error('更新包大小不符。') : null,
                  chunk,
                );
              },
            }),
            createWriteStream(archive, { flags: 'wx' }),
          );
          invariant(
            (await stat(archive)).size === release.bytes &&
              (await fileHash(archive)) === release.sha256,
            'update_integrity',
            '更新包校验失败。',
          );
        }
        this.progress = { phase: 'preparing', bytes: 0 };
        const candidate = join(transaction, 'candidate');
        await extractArchive(archive, candidate, join(this.project, 'dist/update-archive.ps1'));
        const manifest = await readUpdateManifest(candidate, this.current);
        invariant(
          newerVersion(manifest.build.version, this.current.version) ||
            (manifest.build.version === this.current.version &&
              manifest.build.buildId !== this.current.buildId),
          'update_version',
          '更新包版本不高于当前版本。',
        );
        if (!path)
          invariant(
            manifest.build.version === this.release!.version,
            'update_integrity',
            '更新包版本与发布记录不一致。',
          );
        await verifyApp(join(candidate, 'app'), manifest);
        await rm(archive);
        await atomicJson(join(parent, 'prepared.json'), {
          id,
          manifest,
          rollback: false,
          origin: path ? 'local' : 'github',
        } satisfies Prepared);
        if (previous && /^[a-f\d-]{36}$/.test(previous.id))
          await rm(join(parent, previous.id), { recursive: true, force: true }).catch(() => {});
        return this.status();
      } catch (error) {
        await rm(transaction, { recursive: true, force: true });
        throw error;
      }
    });
  }
  async prepareRollback() {
    return this.exclusive(async () => {
      const parent = this.root();
      const backup = await jsonFile<{ transaction: string; build: BuildInfo; executable: string }>(
        join(parent, 'rollback.json'),
      );
      invariant(
        backup && /^[a-f\d-]{36}$/.test(backup.transaction),
        'update_rollback',
        '没有可用的上一版本。',
      );
      const source = join(parent, backup.transaction, 'previous');
      invariant((await realpath(source)) === source, 'update_path', '回滚目录发生变化。');
      const id = randomUUID(),
        candidate = join(parent, id, 'candidate');
      await availableSpace(
        parent,
        (await fileInventory(source)).reduce((sum, file) => sum + file.bytes, 0),
      );
      await cp(source, join(candidate, 'app'), { recursive: true, dereference: false });
      if (backup.executable !== 'Echo.exe') {
        const { rename } = await import('node:fs/promises');
        await rename(join(candidate, 'app', backup.executable), join(candidate, 'app/Echo.exe'));
      }
      const manifest: UpdateManifest = {
        format: 'echo-update-v1',
        platform: 'win32-x64',
        build: backup.build,
        files: await fileInventory(join(candidate, 'app')),
      };
      for (const file of manifest.files.filter((file) => /^uninstall.*\.exe$/i.test(file.path)))
        await rm(join(candidate, 'app', file.path));
      manifest.files = manifest.files.filter((file) => !/^uninstall.*\.exe$/i.test(file.path));
      await atomicJson(join(candidate, 'update.json'), manifest);
      await readUpdateManifest(candidate, this.current);
      await verifyApp(join(candidate, 'app'), manifest);
      await atomicJson(join(parent, 'prepared.json'), {
        id,
        manifest,
        rollback: true,
        origin: 'rollback',
      } satisfies Prepared);
      return this.status();
    });
  }
  async handoff(id: string, quiesce: () => void) {
    return this.exclusive(async () => {
      const pending = await this.prepared();
      invariant(
        pending?.id === id && this.host,
        'update_stale',
        '更新准备记录已变化，请重新检查。',
      );
      const parent = this.root(),
        transaction = join(parent, id);
      const migration = await jsonFile<{ state: string }>(
        join(this.runtime, 'storage-migration.json'),
      );
      invariant(
        migration?.state !== 'pending',
        'update_migration',
        '请先完成或取消待执行的数据迁移，再更新程序。',
      );
      invariant(
        (await realpath(this.host.installRoot)) === this.host.installRoot &&
          ['Echo.exe', 'echo-desktop.exe'].includes(this.host.executable),
        'update_path',
        '此安装位置暂不支持原地更新。',
      );
      // The detached helper verifies every payload byte after the old processes
      // exit and before the first rename. Keep the native handoff short.
      const plan = updatePlanSchema.parse({
        format: 'echo-update-plan-v1',
        id,
        appRoot: this.host.installRoot,
        dataRoot: this.runtime,
        anchor: this.host.anchor,
        executable: this.host.executable,
        desktopPid: this.host.desktopPid,
        backendPid: process.pid,
        before: this.current,
        manifest: pending.manifest,
      });
      await atomicJson(join(transaction, 'plan.json'), plan);
      const { validatePlan } = await import('./update-transaction.ts');
      validatePlan(plan, transaction);
      await copyFile(process.execPath, join(parent, 'node.exe'));
      await copyFile(
        join(this.project, 'dist/update-helper.mjs'),
        join(parent, 'update-helper.mjs'),
      );
      quiesce();
      const helper = spawn(
        join(parent, 'node.exe'),
        [join(parent, 'update-helper.mjs'), transaction],
        { detached: true, windowsHide: true, stdio: 'ignore', cwd: parent },
      );
      await new Promise<void>((done, reject) => {
        helper.once('spawn', done);
        helper.once('error', reject);
      });
      helper.unref();
      for (let attempt = 0; attempt < 50; attempt++) {
        const ready = await jsonFile<{ id: string }>(join(transaction, 'helper-ready.json'));
        if (ready?.id === id) {
          this.handedOff = true;
          await rm(join(parent, 'prepared.json'));
          return { accepted: true };
        }
        await new Promise((done) => setTimeout(done, 100));
      }
      throw Error('更新助手未能启动。');
    });
  }
  async confirm(desktop: BuildInfo) {
    const transaction = process.env.ECHO_UPDATE_TRANSACTION,
      token = process.env.ECHO_UPDATE_TOKEN;
    if (!transaction || !token) return { accepted: false };
    invariant(
      this.host && transaction === join(this.root(), token),
      'update_trial',
      '更新验收位置无效。',
    );
    const plan = updatePlanSchema.parse(await jsonFile(join(transaction, 'plan.json')));
    invariant(
      plan.id === token &&
        plan.manifest.build.buildId === this.current.buildId &&
        desktop.buildId === this.current.buildId &&
        desktop.edition === this.current.edition,
      'update_mismatch',
      '桌面和后端构建不一致。',
    );
    await atomicJson(join(transaction, 'healthy.json'), {
      id: token,
      buildId: this.current.buildId,
    });
    return { accepted: true };
  }
  register(registry: Registry, quiesce: () => void, resume: () => void, confirmed?: () => void) {
    const operation = (name: string, input: z.ZodType, run: (input: any) => unknown) =>
      registry.register({
        name,
        owner: 'core',
        description: name,
        input,
        output: z.any(),
        mcp: false,
        permission: 'system.write',
        run: (value, caller) => {
          invariant(
            ['ui', 'internal'].includes(caller.kind) || caller.kind === 'cli' && ['updates.status', 'updates.check', 'updates.stage', 'updates.rollback'].includes(name),
            'permission_denied',
            '此操作仅供应用设置使用。',
          );
          return run(value);
        },
      });
    operation('updates.status', z.object({}), () => this.status());
    operation('updates.check', z.object({}), () => this.check());
    operation('updates.stage', z.object({ path: z.string().min(1).optional() }), (value) =>
      this.stage(value.path),
    );
    operation('updates.rollback', z.object({}), () => this.prepareRollback());
    operation('updates.handoff', z.object({ id: z.string().uuid() }), async (value) => {
      try {
        return await this.handoff(value.id, quiesce);
      } catch (error) {
        resume();
        throw error;
      }
    });
    operation('updates.confirm', z.object({ desktop: buildSchema }), async (value) => {
      const result = await this.confirm(value.desktop); confirmed?.(); return result;
    });
  }
}
export async function extractArchive(archive: string, destination: string, script: string) {
  const command = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const child = spawn(
    command,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Archive',
      archive,
      '-Destination',
      destination,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(Error('更新包解压失败或包含无效文件。')),
    );
  });
}
