import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, temporary } from './helpers.ts';
import { packPlugin } from '../packages/kernel/plugin-package.ts';
import { internal } from '../packages/kernel/registry.ts';
import { allowedWebsite } from '../plugins/browser-use/index.ts';
import { approvedApplications,computerPlugin } from '../plugins/computer-use/index.ts';

test('portable restore keeps configured schedules and validated packages at their new location', async (t) => {
  const app = await setup(t),
    dir = await temporary(t),
    src = join(dir, 'fixture');
  await mkdir(src);
  await writeFile(
    join(src, 'echo-plugin.json'),
    JSON.stringify({
      apiVersion: 1,
      id: 'fixture-portable',
      name: 'Test',
      description: 'Fixture',
      version: '1.0.0',
      permissions: [],
      dependencies: [],
    }),
  );
  await writeFile(join(src, 'main.mjs'), 'export default {}');
  const archive = join(dir, 'fixture.echo-plugin');
  await writeFile(join(src, 'LICENSE'), 'Synthetic test fixture');
  await packPlugin(src, archive, 'main.mjs', ['main.mjs', 'LICENSE'], 'module');
  const { sha256 } = await app.extensions.inspectPackage(archive);
  await app.extensions.installPackage(archive, sha256);
  app.store.set('plugins.intent', {
    ...app.store.get('plugins.intent', {}),
    'fixture-portable': true,
  });
  app.store.set('review.tasks', [{ id: 'example', enabled: true }]);
  const art = join(app.runtime, 'avatar-assets', 'example');
  await mkdir(art, { recursive: true });
  await writeFile(join(art, 'frame.png'), 'synthetic');
  app.store.put('avatar-assets', 'example', { directory: art });
  app.store.set('backup.config', { directory: join(dir, 'backups'), keep: 1 });
  const signal = new AbortController().signal,
    b = await app.backups.run(signal);
  const m = await app.backups.inspect(b.directory);
  assert.equal(m.packages.length, 1);
  const dest = join(dir, 'migrated');
  await app.backups.restore(b.directory, dest, signal, true);
  const db = new DatabaseSync(join(dest, 'echo.sqlite'), { readOnly: true });
  try {
    const rec = JSON.parse(
      (
        db
          .prepare(
            "select data from documents where namespace='module-extensions' and id='fixture-portable'",
          )
          .get() as any
      ).data,
    );
    assert.equal(await readFile(join(rec.directory, 'main.mjs'), 'utf8'), 'export default {}');
    assert.ok(rec.directory.startsWith(dest));
    const asset = JSON.parse(
      (
        db
          .prepare("SELECT data FROM documents WHERE namespace='avatar-assets' AND id='example'")
          .get() as any
      ).data,
    );
    assert.equal(asset.directory, join(dest, 'avatar-assets', 'example'));
    assert.equal(await readFile(join(asset.directory, 'frame.png'), 'utf8'), 'synthetic');
    const value = (k: string) =>
      JSON.parse((db.prepare('select value from kv where key=?').get(k) as any).value);
    assert.equal(value('review.tasks')[0].enabled, true);
    assert.equal(value('plugins.intent')['fixture-portable'], false);
  } finally {
    db.close();
  }
  await writeFile(join(b.directory, m.packages[0].directory, 'main.mjs'), 'modified');
  await assert.rejects(app.backups.inspect(b.directory), /校验/);
});

test('Zotero uses the scope bound to the local server and separates writes from reads', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('zotero');
  app.store.set('zotero.config', { serverId: 'local-server', secretRef: 'test-zotero' });
  t.mock.method(app.secrets, 'get', async () => 'local-fixture');
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://127.0.0.1:23119');
    assert.equal(init.headers['Zotero-Server-ID'], 'local-server');
    calls.push(url.pathname);
    const data = url.pathname.endsWith('/collections')
      ? { name: 'Examples', parentCollection: false }
      : { title: 'Example', collections: ['23456789'] };
    return Response.json([{ key: '23456789', version: 2, data }]);
  });
  assert.deepEqual(await app.registry.call('zotero.refresh', {}, internal), {
    items: 1,
    collections: 1,
  });
  const caller = { kind: 'mcp' as const, permissions: new Set(['zotero.read']) };
  const rows = (await app.registry.call('zotero.search', { query: 'example' }, caller)) as any[];
  assert.equal(rows[0].title, 'Example');
  assert.equal(rows[0].uri, 'zotero://select/library/items/23456789');
  await assert.rejects(
    app.registry.call(
      'zotero.setCollections',
      { key: '23456789', version: 2, collections: [] },
      caller,
    ),
  );
  assert.equal(calls.length, 3);
});
test('desktop control snapshots are single-use, scoped to a conversation, and closed on disable', {skip:process.platform!=='win32'}, async t=>{
  const app=await setup(t);const calls:string[]=[];
  app.plugins.plugins.set('computer-use',computerPlugin(app.store,'','',()=>({call:async(method)=>{calls.push(method);return method==='desktop.inspect'?{controls:[{index:0,name:'Example'}]}:{completed:true};},close:async()=>{calls.push('close');}})));
  app.store.set('computer-use.config',{applications:String.raw`C:\Apps\Reader.exe`});
  await app.plugins.enable('computer-use');
  const c={kind:'mcp' as const,conversationId:'a',permissions:new Set(['computer-use.read','computer-use.interact'])};
  const view=await app.registry.call('computer-use.inspect',{},c) as any;
  const cmd={action:'invoke',snapshot:view.snapshot,index:0};
  await assert.rejects(app.registry.call('computer-use.act',cmd,{...c,conversationId:'b'}));
  await app.registry.call('computer-use.act',cmd,c);
  await assert.rejects(app.registry.call('computer-use.act',cmd,c));
  await app.plugins.disable('computer-use');
  assert.deepEqual(calls,['desktop.inspect','desktop.act','close']);
});

test('browser and desktop scopes reject unrelated origins and paths before starting a driver', async (t) => {
  assert.equal(allowedWebsite('https://example.org/articles', 'https://example.org'), true);
  for (const url of [
    'http://example.org/',
    'https://example.org.invalid',
    'https://x@example.org',
    'file:///a',
    'https://127.0.0.1',
  ])
    assert.equal(allowedWebsite(url, 'https://example.org'), false);
  assert.deepEqual(approvedApplications('C:\\Apps\\Reader.exe\nC:\\Windows\\cmd.exe\nReader.exe'), [
    'c:\\apps\\reader.exe',
  ]);
  const app = await setup(t);
  for (const id of ['browser-use', 'computer-use']) await app.plugins.enable(id);
  const caller = {
    kind: 'mcp' as const,
    permissions: new Set(['browser-use.read', 'computer-use.read']),
    conversationId: 'fixture',
  };
  await assert.rejects(
    app.registry.call('browser-use.open', { url: 'https://example.org' }, caller),
    /授权/,
  );
  await assert.rejects(app.registry.call('computer-use.inspect', {}, caller), /选择/);
});
