import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { setup, conversation, FakeBackend } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';

test('knowledge bodies and revisions live in the library database, while originals are immutable deduplicated objects', async (t) => {
  const app = await setup(t),
    source = join(app.runtime, 'notes.md');
  await writeFile(source, '# First\nbody');
  const a = await app.knowledge.import('local', source);
  await writeFile(source, '# Second\nbody');
  const b = await app.knowledge.import('local', source);
  assert.equal(a.id, b.id);
  assert.equal(b.revision, 2);
  const db = await app.files.database('local');
  assert.equal(
    (db.db.prepare('SELECT count(*) n FROM entries WHERE source_file_id IS NOT NULL').get() as any)
      .n,
    1,
  );
  assert.equal(
    (db.db.prepare('SELECT count(*) n FROM entry_revisions WHERE entry_id=?').get(a.id) as any).n,
    2,
  );
  assert.equal((await app.knowledge.read(a.id)).content, '# Second\nbody');
  assert(!app.store.documents('knowledge').length);
  assert(!(await readdir(app.files.roots()[0].path)).includes('KnowledgeDocument'));
  await assert.rejects(
    app.knowledge.save('local', 'Conflict', 'no', { id: a.id, revision: 1 }),
    /变化/,
  );
  await assert.rejects(app.plugins.disable('files'),/内建模块/);
  assert.equal((await app.knowledge.read(a.id)).content, '# Second\nbody');
});

test('library and Markdown exports preserve attachments, exclude other kinds by default and can mount independently', async (t) => {
  const app = await setup(t),
    doc = await app.knowledge.save('local', 'Public note', '# Title\n');
  const media = join(app.runtime, 'audio.wav');
  await writeFile(media, Buffer.from('synthetic media bytes'));
  const file = await app.files.import('local', media);
  const attachment = await app.knowledge.attach('local', doc.id, file.id, 'audio');
  await app.knowledge.save('local', 'Public note', '# Title\n[Audio](' + attachment.uri + ')', {
    id: doc.id,
  });
  const bundle = join(app.runtime, 'library.zip');
  await app.registry.call(
    'knowledge.export',
    { vaultId: 'local', destination: bundle, mode: 'bundle' },
    internal,
  );
  const archive = unzipSync(await readFile(bundle));
  assert(archive['library.sqlite']);
  assert(archive[file.relativePath]);
  assert(!Object.keys(archive).some((p) => p.includes('echo.sqlite')));
  const extracted = join(app.runtime, 'extracted');
  await mkdir(extracted);
  for (const [path, bytes] of Object.entries(archive)) {
    if (path === 'manifest.json') continue;
    const target = join(extracted, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
  }
  const inspect = new DatabaseSync(join(extracted, 'library.sqlite'), { readOnly: true });
  try {
    assert.equal(
      (inspect.prepare("SELECT count(*) n FROM entries WHERE kind='persona'").get() as any).n,
      0,
    );
  } finally {
    inspect.close();
  }
  const isolated = await Application.create({
    runtime: join(app.runtime, 'independent'),
    project: app.project,
    plugins: ['files', 'knowledge'],
  });
  try {
    await isolated.files.register({ id: 'mounted', name: 'Imported', path: extracted });
    assert.equal((await isolated.knowledge.read(doc.id)).attachments.length, 1);
    assert.match((await isolated.knowledge.read(doc.id)).content, /echo-asset:/);
  } finally {
    await isolated.close();
  }
  const markdown = join(app.runtime, 'markdown.zip');
  await app.registry.call(
    'knowledge.export',
    { vaultId: 'local', destination: markdown, mode: 'markdown' },
    internal,
  );
  const md = unzipSync(await readFile(markdown));
  assert.match(strFromU8(md['entries/' + doc.id + '.md']), /\.\.\/attachments\//);
  assert(md['attachments/' + file.hash + '.wav']);
  assert(!md['library.sqlite']);
  await assert.rejects(
    app.registry.call('knowledge.export', { vaultId: 'local', destination: bundle }, internal),
    /exist|EEXIST/i,
  );
});

test('base calendar reminders are durable, bind a conversation without inference', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('agenda');
  await app.plugins.enable('notifications');
  // This fixture uses UTC ISO dates below; its calendar must use that same zone.
  app.store.set('clock.config', { timezone: 'UTC' });
  const c = conversation(app),
    fake = new FakeBackend();
  app.router.backends.set('api', fake);
  const date = new Date(Date.now() + 60000).toISOString();
  const item = app.agenda.save({
    title: 'Calendar fixture',
    start: date,
    priority: 'high',
    reminder: { enabled: true, minutesBefore: 0 },
    conversationId: c.id,
  });
  await app.agenda.tick(Date.parse(date) + 10);
  await app.agenda.tick(Date.parse(date) + 20);
  assert.equal(app.store.allMessages(c.id).filter((m) => m.source === 'notification').length, 1);
  assert.equal(app.store.allMessages(c.id)[0].role, 'system');
  assert.equal(fake.calls.length, 0);
  assert.equal(app.store.documents('agenda-reminders').length, 1);
  assert.equal(
    (
      await app.registry.call(
        'agenda.calendar',
        { from: date.slice(0, 10), to: date.slice(0, 10) },
        internal,
      )
    ).length,
    1,
  );
  assert.equal(app.agenda.save({ ...item, title: 'Editable from calendar' }).title, 'Editable from calendar');
  assert.throws(
    () =>
      app.agenda.save({
        title: 'Invalid',
        start: date,
        end: new Date(Date.parse(date) - 1000).toISOString(),
      }),
    /早于/,
  );
  await app.plugins.disable('agenda');
  assert.equal(app.clock.pending, 0);
});

function pdf(body: string) {
  const content = 'BT /F1 12 Tf 20 60 Td (' + body + ') Tj ET',
    objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
    ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, o] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += i + 1 + ' 0 obj\n' + o + '\nendobj\n';
  }
  const start = Buffer.byteLength(text);
  text +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
    start +
    '\n%%EOF';
  return text;
}
test('digital PDF and XLSX yield real body text; headings never disguise empty or scan-only documents', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('documents');
  const p = join(app.runtime, 'sample.pdf');
  await writeFile(p, pdf('Echo PDF body'));
  const d = await app.knowledge.import('local', p);
  assert.match((await app.knowledge.read(d.id)).content, /Echo PDF body/);
  const empty = join(app.runtime, 'empty.pdf');
  await writeFile(empty, pdf(''));
  await assert.rejects(app.knowledge.import('local', empty), /没有可提取正文/);
  const sheet = join(app.runtime, 'sample.xlsx');
  await writeFile(
    sheet,
    zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Shared value</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row></sheetData></worksheet>',
      ),
    }),
  );
  const s = await app.knowledge.import('local', sheet);
  assert.match((await app.knowledge.read(s.id)).content, /Shared value\t42/);
  const office = join(app.runtime, 'empty.docx');
  await writeFile(
    office,
    zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p/></w:body></w:document>') }),
  );
  await assert.rejects(app.knowledge.import('local', office), /没有可提取正文/);
});
test('media access is scoped, revocable and streamed with byte ranges', async (t) => {
  const app = await setup(t),
    source = join(app.runtime, 'sample.wav');
  await writeFile(source, Buffer.from('0123456789'));
  const file = await app.files.import('local', source);
  const server = await serve(app, { webRoot: join(app.project, 'dist/web') });
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.port;
  const grant = await app.files.media('local', file.hash);
  const url = base + '/media/' + grant.ticket;
  const partial = await fetch(url, { headers: { Range: 'bytes=3-7' } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), '34567');
  assert.equal(partial.headers.get('content-type'), 'audio/wav');
  assert.equal((await fetch(url, { headers: { Range: 'bytes=999-' } })).status, 416);
  assert.equal((await fetch(url, { headers: { Origin: 'https://other.invalid' } })).status, 403);
  await app.plugins.close();
  assert.equal((await fetch(url)).status, 409);
});
test('frontend protocol can decide a frozen approval while external callers cannot approve it', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('approvals');
  let calls = 0;
  app.plugins.add({
    manifest: {
      id: 'fixture',
      name: 'Fixture',
      description: 'Approval contract fixture',
      version: '0.2.0',
      dependencies: [],
      permissions: ['approvals.contribute'],
      settings: [],
      views: [],
    },
    activate: (ctx) => {
      ctx.capabilities.provide('approvals.prepare@1', 'fixture.action', 'Fixture', () => ({
        title: 'Frozen operation',
        details: [{ label: 'Body', value: 'Synthetic' }],
        frozen: { value: 1 },
      }));
      ctx.capabilities.provide('approvals.execute@1', 'fixture.action', 'Fixture', () => {
        calls++;
        return { state: 'succeeded' };
      });
    },
  });
  await app.plugins.enable('fixture');
  const request = await app.approvals.request(
    'fixture.action',
    {},
    'fixture-approval',
    new AbortController().signal,
  );
  await assert.rejects(
    app.registry.call(
      'approvals.decide',
      { id: request.id, revision: 1, decision: 'approve', confirmed: true },
      { kind: 'extension', permissions: new Set(['*']) },
    ),
    /前端/,
  );
  const server = await serve(app, { webRoot: join(app.project, 'dist/web') });
  t.after(() => server.close());
  const send = () =>
    fetch('http://127.0.0.1:' + server.port + '/rpc', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'approvals.decide',
        params: { id: request.id, revision: 1, decision: 'approve', confirmed: true },
      }),
    });
  const a = await send(),
    b = await send();
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(((await a.json()) as any).result.state, 'succeeded');
  assert.equal(calls, 1);
});
