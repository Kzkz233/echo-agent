import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { zipSync, strToU8, type Zippable } from 'fflate';
import { temporary, setup, conversation } from './helpers.ts';
import { internal, Registry } from '../packages/kernel/registry.ts';
import { buildSchema, type BuildInfo } from '../packages/contracts/build.ts';
import { updateManifestSchema, updatePath, newerVersion } from '../packages/contracts/update.ts';
import {
  fileInventory,
  jsonFile,
  verifyApp,
  readUpdateManifest,
} from '../packages/kernel/update-files.ts';
import {
  installTransaction,
  updateRoot,
  validatePlan,
  type UpdatePlan,
  type TransactionHost,
} from '../packages/kernel/update-transaction.ts';
import { extractArchive, selectPublicRelease } from '../packages/kernel/updates.ts';

const before: BuildInfo = {
  version: '1.2.0',
  edition: 'public',
  buildId: 'old-build',
  builtAt: '2026-01-01T00:00:00.000Z',
  dataVersion: 1,
};
const after: BuildInfo = { ...before, version: '1.3.0', buildId: 'new-build' };
async function appTree(root: string, build: BuildInfo) {
  await mkdir(join(root, 'runtime/dist'), { recursive: true });
  for (const [name, text] of [
    ['Echo.exe', build.buildId],
    ['runtime/node.exe', 'synthetic'],
    ['runtime/dist/server.mjs', '// synthetic'],
    ['runtime/dist/build-info.json', JSON.stringify(build)],
  ])
    await writeFile(join(root, name), text);
  return updateManifestSchema.parse({
    format: 'echo-update-v1',
    platform: 'win32-x64',
    build,
    files: await fileInventory(root),
  });
}
test('public updates only accept a newer stable release and an exact repository asset with a digest', () => {
  const asset = {
    name: 'Echo-1.3.0-public-win-x64.echo-update',
    browser_download_url:
      'https://github.com/Kzkz233/echo-agent/releases/download/v1.3.0/Echo-1.3.0-public-win-x64.echo-update',
    digest: 'sha256:' + 'a'.repeat(64),
    size: 100,
  };
  const release = { tag_name: 'v1.3.0', assets: [asset] };
  assert.equal(selectPublicRelease(release, before)?.version, '1.3.0');
  assert.equal(selectPublicRelease(release, { ...before, edition: 'private' }), undefined);
  for (const bad of [
    { ...release, draft: true },
    { ...release, prerelease: true },
    { ...release, assets: [{ ...asset, digest: '' }] },
    {
      ...release,
      assets: [{ ...asset, browser_download_url: 'https://untrusted.invalid/package' }],
    },
  ])
    assert.equal(selectPublicRelease(bad, before), undefined);
  assert.equal(selectPublicRelease(release, after), undefined);
  assert(newerVersion('0.16.16', '0.16.9'));
  assert(!newerVersion('0.9.99', '0.16.1'));
});
test('package paths reject Windows aliases, ADS, duplicates and incomplete payloads', () => {
  for (const path of [
    '../outside',
    'app/../file',
    'C:/file',
    'app\\file',
    'aux.txt',
    'app/COM1',
    'app/file.',
    'app/name:stream',
    '/absolute',
  ])
    assert(!updatePath.safeParse(path).success, path);
  assert(updatePath.safeParse('runtime/node_modules/@example/pkg/file.mjs').success);
  assert(
    !updateManifestSchema.safeParse({
      format: 'echo-update-v1',
      platform: 'win32-x64',
      build: after,
      files: [],
    }).success,
  );
  assert(!buildSchema.safeParse({ ...after, dataVersion: 2 }).success);
});
test('update verification detects modified files, unlisted files and channel mismatch before changing an installation', async (t) => {
  const root = await temporary(t),
    app = join(root, 'app');
  const manifest = await appTree(app, after);
  await writeFile(join(root, 'update.json'), JSON.stringify(manifest));
  await verifyApp(app, manifest);
  await assert.rejects(readUpdateManifest(root, { ...before, edition: 'private' }), /渠道/);
  await writeFile(join(app, 'runtime/dist/server.mjs'), 'modified');
  await assert.rejects(verifyApp(app, manifest), /verification/);
});
test('archive extraction rejects traversal and duplicate Windows destinations without writing outside its directory', async (t) => {
  const root = await temporary(t);
  const script = join(import.meta.dirname, '../resources/update-archive.ps1');
  const cases: Zippable[] = [
    { '../escaped.txt': strToU8('must not escape') },
    { 'app/Echo.exe': strToU8('one'), 'app/echo.exe': strToU8('two') },
    { 'app/nul.txt': strToU8('device') },
  ];
  for (const [index, entries] of cases.entries()) {
    const archive = join(root, index + '.echo-update');
    await writeFile(archive, zipSync(entries));
    await assert.rejects(
      extractArchive(archive, join(root, 'candidate-' + index), script),
      /解压失败/,
    );
  }
  assert.equal(
    await lstat(join(root, '../escaped.txt')).then(
      () => true,
      () => false,
    ),
    false,
  );
});
async function transactionFixture(t: Parameters<typeof temporary>[0]) {
  const root = await temporary(t),
    appRoot = join(root, 'App'),
    dataRoot = join(root, 'data');
  await appTree(appRoot, before);
  await mkdir(dataRoot);
  await writeFile(join(dataRoot, 'private-data.txt'), 'unchanged');
  await mkdir(join(dataRoot, 'extensions/user-extension'), { recursive: true });
  await writeFile(join(dataRoot, 'extensions/user-extension/entry.mjs'), '// user-owned extension');
  await writeFile(join(dataRoot, 'external-mcp-fixture.json'), '{"enabled":false,"credential":"synthetic"}');
  const id = randomUUID(),
    transaction = join(updateRoot(appRoot), id);
  const manifest = await appTree(join(transaction, 'candidate/app'), after);
  const plan: UpdatePlan = {
    format: 'echo-update-plan-v1',
    id,
    appRoot,
    dataRoot,
    anchor: dataRoot,
    executable: 'Echo.exe',
    desktopPid: 1,
    backendPid: 2,
    before,
    manifest,
  };
  const calls: string[] = [];
  const host: TransactionHost = {
    stopped: async () => {
      calls.push('stop-old');
    },
    snapshot: async (path) => {
      await writeFile(path, 'snapshot');
    },
    launch: async (trial) => {
      calls.push(trial ? 'launch-new' : 'launch-old');
    },
    healthy: async () => {
      calls.push('healthy');
    },
    stopTrial: async () => {
      calls.push('stop-new');
    },
  };
  return { plan, transaction, calls, host };
}
test('successful update preserves data, the shortcut name, uninstaller and previous program for rollback', async (t) => {
  const { plan, transaction, calls, host } = await transactionFixture(t);
  await writeFile(join(plan.appRoot, 'uninstall.exe'), 'uninstaller');
  const result = await installTransaction(plan, transaction, host);
  assert.equal(result.phase, 'complete');
  assert.deepEqual(calls, ['stop-old', 'launch-new', 'healthy']);
  assert.equal(await readFile(join(plan.appRoot, 'Echo.exe'), 'utf8'), after.buildId);
  assert.equal(await readFile(join(transaction, 'previous/Echo.exe'), 'utf8'), before.buildId);
  assert.equal(await readFile(join(plan.appRoot, 'uninstall.exe'), 'utf8'), 'uninstaller');
  assert.equal(await readFile(join(plan.dataRoot, 'private-data.txt'), 'utf8'), 'unchanged');
  assert.equal(await readFile(join(plan.dataRoot, 'extensions/user-extension/entry.mjs'), 'utf8'), '// user-owned extension');
  assert.equal(await readFile(join(plan.dataRoot, 'external-mcp-fixture.json'), 'utf8'), '{"enabled":false,"credential":"synthetic"}');
  assert.equal(
    (await jsonFile<any>(join(updateRoot(plan.appRoot), 'rollback.json'))).transaction,
    plan.id,
  );
});
test('a payload failure after shutdown relaunches the unchanged old application', async t => {
  const { plan, transaction, calls, host } = await transactionFixture(t);
  await writeFile(join(transaction, 'candidate/app/Echo.exe'), 'corrupt');
  const result = await installTransaction(plan, transaction, host);
  assert.equal(result.phase, 'failed');
  assert.deepEqual(calls, ['stop-old', 'launch-old']);
  assert.equal(await readFile(join(plan.appRoot, 'Echo.exe'), 'utf8'), before.buildId);
});
test('failed startup automatically restores the previous program and keeps new data and the failed candidate', async (t) => {
  const { plan, transaction, calls, host } = await transactionFixture(t);
  host.healthy = async () => {
    await writeFile(join(plan.dataRoot, 'new-message.txt'), 'retained');
    throw Error('fixture startup failure');
  };
  const result = await installTransaction(plan, transaction, host);
  assert.equal(result.phase, 'rolled-back');
  assert.deepEqual(calls, ['stop-old', 'launch-new', 'stop-new', 'launch-old']);
  assert.equal(await readFile(join(plan.appRoot, 'Echo.exe'), 'utf8'), before.buildId);
  assert.equal(await readFile(join(transaction, 'failed-app/Echo.exe'), 'utf8'), after.buildId);
  assert.equal(await readFile(join(plan.dataRoot, 'new-message.txt'), 'utf8'), 'retained');
  assert.equal(await readFile(join(plan.dataRoot, 'extensions/user-extension/entry.mjs'), 'utf8'), '// user-owned extension');
});
test('a failed trial that is still running keeps both app trees intact instead of moving open binaries', async (t) => {
  const { plan, transaction, host } = await transactionFixture(t);
  host.healthy = async () => {
    throw Error('health failed');
  };
  host.stopTrial = async () => {
    throw Error('cannot stop');
  };
  assert.equal((await installTransaction(plan, transaction, host)).phase, 'failed');
  assert.equal(await readFile(join(plan.appRoot, 'Echo.exe'), 'utf8'), after.buildId);
  assert.equal(await readFile(join(transaction, 'previous/Echo.exe'), 'utf8'), before.buildId);
});
test('data directories inside an application and cross-channel plans can never be swapped', async (t) => {
  const { plan, transaction } = await transactionFixture(t);
  assert.throws(
    () => validatePlan({ ...plan, dataRoot: join(plan.appRoot, 'data') }, transaction),
    /Unsafe/,
  );
  assert.throws(
    () =>
      validatePlan(
        { ...plan, manifest: { ...plan.manifest, build: { ...after, edition: 'private' } } },
        transaction,
      ),
    /Unsafe/,
  );
  assert.throws(() => validatePlan(plan, join(transaction, '..')), /Unsafe/);
});
test('update handoff blocks new operations and router requests until a failed handoff is resumed', async (t) => {
  const app = await setup(t, []);
  const c = conversation(app);
  app.router.pauseForUpdate();
  await assert.rejects(
    app.router.send({ conversationId: c.id, text: 'fixture', requestId: randomUUID() }),
    /重启更新/,
  );
  assert.throws(
    () => app.router.enqueue({ conversationId: c.id, text: 'fixture', requestId: randomUUID() }),
    /重启更新/,
  );
  app.router.resumeAfterUpdateFailure();
  const registry = new Registry();
  registry.register({
    name: 'fixture.write',
    owner: 'fixture',
    description: 'fixture',
    permission: 'fixture.write',
    mcp: false,
    input: (await import('zod')).z.object({}),
    output: (await import('zod')).z.any(),
    run: () => 'ok',
  });
  registry.beginUpdate();
  await assert.rejects(registry.call('fixture.write', {}, internal), /重启更新/);
  registry.resumeAfterUpdateFailure();
  assert.equal(await registry.call('fixture.write', {}, internal), 'ok');
  assert(!(await app.registry.list(internal, true)).some((op) => op.name.startsWith('updates.')));
});
