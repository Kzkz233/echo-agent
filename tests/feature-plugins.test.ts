import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { zipSync, strToU8 } from 'fflate';
import { DatabaseSync } from 'node:sqlite';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { Clock } from '../packages/kernel/clock.ts';
import { nextDaily } from '../packages/kernel/time.ts';
import { Application } from '../apps/server/application.ts';
import { SafeTaskFailure } from '../packages/contracts/index.ts';
import { openPortableIndex } from '../plugins/semantic/portable-index.ts';

test('Mail prioritizes recent arrivals, resumes historical gaps without loss and keeps bodies out of list responses', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('mail');
  await app.registry.call(
    'mail.configure',
    {
      id: 'inbox',
      name: 'Synthetic',
      personaId: 'companion',
      user: 'reader@example.invalid',
      from: 'reader@example.invalid',
      passwordRef: 'unused',
      imap: { host: 'example.invalid', port: 993 },
      smtp: { host: 'example.invalid', port: 465 },
    },
    internal,
  );
  const uids = Array.from({ length: 600 }, (_, i) => i + 1);
  let fail = true;
  const client = {
    mailbox: { uidValidity: 1 },
    getMailboxLock: async () => ({ release() {} }),
    search: async ({ uid }: any) => {
      const [a, b] = uid.split(':');
      const top = b === '*' ? Math.max(...uids) : Number(b);
      return uids.filter((n) => n >= Number(a) && n <= top);
    },
    fetchOne: async (uid: number, fields: any) => {
      if (uid === 390 && fail) {
        fail = false;
        throw Error('Synthetic partial read');
      }
      if (fields.source)
        return {
          source: Buffer.from(
            'From: reader@example.invalid\r\nSubject: Fictional historical mail\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA historical body explicitly opened today.',
          ),
        };
      return {
        uid,
        size: 256,
        envelope: {
          subject: 'Fixture ' + uid,
          date: uid >= 595 ? new Date() : new Date('2025-01-01T00:00:00Z'),
        },
      };
    },
  };
  (app.mail as any).connect = async () => ({ client, close: async () => {} });
  const sync = await app.mail.sync('inbox', new AbortController().signal);
  assert.equal(sync.count, 200);
  assert.equal(Math.min(...app.store.documents<any>('mail').map((m) => m.uid)), 401);
  app.store.set('review.config', { sourceIds: ['mail.source'] });
  assert.equal(
    (await app.reviews.collect('companion')).length,
    6,
    'Initial history backfill must not flood Review',
  );
  const old = app.store.documents<any>('mail').find((m) => m.uid === 401)!;
  await app.mail.read(old.id, new AbortController().signal);
  assert((await app.reviews.collect('companion')).some((m) => m.id === old.id + '.body'));
  const listed = await app.registry.call('mail.list', {}, internal);
  assert.equal(listed.messages.find((m: any) => m.id === old.id).text, undefined);
  assert.equal(listed.messages.find((m: any) => m.id === old.id).bodyCached, true);
  await assert.rejects(
    app.mail.sync('inbox', new AbortController().signal, true),
    (e) => e instanceof SafeTaskFailure,
  );
  await app.mail.sync('inbox', new AbortController().signal, true);
  assert(app.store.documents<any>('mail').some((m) => m.uid === 390));
  assert(app.store.documents<any>('mail').some((m) => m.uid === 400));
  uids.push(601);
  assert.equal((await app.mail.sync('inbox', new AbortController().signal)).count, 1);
  assert.equal(app.store.get('mail.historyBefore.inbox.INBOX.1', 0), 191);
});

test('mail folder discovery failure and cancellation remain resumable without fencing future schedule slots', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('mail');
  await app.plugins.enable('scheduler');
  await app.registry.call(
    'mail.configure',
    {
      id: 'inbox',
      name: 'Synthetic',
      user: 'reader@example.invalid',
      from: 'reader@example.invalid',
      passwordRef: 'unused',
      imap: { host: 'example.invalid', port: 993 },
      smtp: { host: 'example.invalid', port: 465 },
    },
    internal,
  );
  let attempts = 0;
  (app.mail as any).connect = async (_account: unknown, signal: AbortSignal) => {
    attempts++;
    signal.throwIfAborted();
    if (attempts === 1)
      throw Object.assign(Error('Synthetic pre-TLS disconnect'), { code: 'ECONNRESET' });
    return {
      client: {
        list: async () => [{ path: 'INBOX', name: 'Inbox' }],
        mailbox: { uidValidity: 1 },
        getMailboxLock: async () => ({ release() {} }),
        search: async () => [],
      },
      close: async () => {},
    };
  };
  app.scheduler.save({
    id: 'sync',
    name: 'Mail sync',
    provider: 'mail.sync',
    input: { accountId: 'inbox' },
    mode: 'interval',
  });
  assert.equal((await app.scheduler.execute('sync', 100)).state, 'failed');
  assert.equal((await app.scheduler.execute('sync', 100)).state, 'failed');
  assert.equal(attempts, 1, 'The failed slot is not replayed');
  assert.equal(app.scheduler.jobs()[0].blocked, undefined);
  assert.equal(app.store.document<any>('mail-status', 'inbox')?.code, 'ECONNRESET');
  assert.equal((await app.scheduler.execute('sync', 101)).state, 'succeeded');
  await assert.rejects(
    app.mail.syncAccount('inbox', AbortSignal.abort()),
    (e) => e instanceof SafeTaskFailure,
  );
  assert.equal(app.scheduler.jobs()[0].blocked, undefined);
  assert.equal((await app.scheduler.execute('sync', 102)).state, 'succeeded');
});

test('an explicitly safe read failure preserves its failed receipt and allows only a future schedule slot', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('scheduler');
  let attempts = 0;
  app.capabilities.provide(
    {
      id: 'fixture',
      permissions: new Set(['scheduler.contribute']),
      signal: new AbortController().signal,
    },
    'scheduler.handlers@1',
    'fixture.read',
    'Safe read',
    () => {
      attempts++;
      throw new SafeTaskFailure('read_incomplete', 'Read progress retained');
    },
  );
  app.scheduler.save({
    id: 'safe-read',
    name: 'Safe read',
    provider: 'fixture.read',
    mode: 'interval',
  });
  assert.equal((await app.scheduler.execute('safe-read', 100)).state, 'failed');
  assert.equal((await app.scheduler.execute('safe-read', 100)).state, 'failed');
  assert.equal(attempts, 1);
  assert.equal(app.scheduler.jobs()[0].blocked, undefined);
  assert.equal((await app.scheduler.execute('safe-read', 101)).state, 'failed');
  assert.equal(attempts, 2);
});
test('restoring a backup relocates managed files, pauses automation and never overwrites an existing runtime', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('backup');
  const doc = await app.knowledge.save('local', 'Restore fixture', 'Restored text');
  app.store.set('observation.config', { enabled: true });
  app.store.set('backup.config', { directory: join(app.runtime, 'backups') });
  const index = openPortableIndex(join(app.runtime, 'semantic/index.sqlite'));
  index.prepare('INSERT INTO spaces VALUES(?,?,?)').run('fixture-space', 2, 'synthetic');
  index.close();
  await app.router.inference.saveConnection({
    id: 'native',
    name: 'Native',
    adapterId: 'worker-codex.provider',
    deployment: 'harness',
    config: {},
  });
  await app.router.inference.saveModel({
    id: 'native',
    name: 'Native',
    connectionId: 'native',
    model: 'synthetic',
  });
  const chat = conversation(app);
  const attachment=await app.router.attachments.add(chat.id,'restored.md','text/plain',Buffer.from('RESTORE_ATTACHMENT').toString('base64'));
  app.store.saveBinding({
    conversationId: chat.id,
    profileId: 'native',
    epoch: 1,
    state: 'active',
    sessionId: 'native-not-portable',
  });
  const backup = await app.backups.run(new AbortController().signal);
  const target = join(app.runtime, 'restored');
  await app.backups.restore(backup.directory, target, new AbortController().signal);
  const restored = await Application.create({
    runtime: target,
    project: app.project,
    plugins: ['knowledge', 'persona', 'memory'],
  });
  try {
    assert.equal((await restored.knowledge.read(doc.id)).content, 'Restored text');
    assert.equal(restored.observations.config().enabled, false);
    assert(restored.files.roots()[0].path.startsWith(target));
    assert.equal(restored.clock.pending, 0);
    assert.equal(restored.store.binding(chat.id), undefined);
    assert.equal((await restored.router.attachments.content([attachment.id],chat.id)).text.includes('RESTORE_ATTACHMENT'),true);
    const copied = new DatabaseSync(join(target, 'semantic/index.sqlite'), { readOnly: true });
    assert.equal((copied.prepare('SELECT count(*) n FROM spaces').get() as any).n, 1);
    copied.close();
  } finally {
    await restored.close();
  }
  await assert.rejects(
    app.backups.restore(backup.directory, app.runtime, new AbortController().signal),
    /空目录/,
  );
  assert.equal((await app.knowledge.read(doc.id)).content, 'Restored text');
});
test('Mail IMAP UID synchronization is idempotent and body reading is explicit', async (t) => {
  const source =
    'From: Sender <sender@example.invalid>\r\nTo: recipient@example.invalid\r\nSubject: Synthetic subject\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body';
  let bodyReads = 0;
  const server = createServer((socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] fixture\r\n');
    let auth = '';
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (auth) {
        socket.write(auth + ' OK authenticated\r\n');
        auth = '';
        return;
      }
      const [tag, ...parts] = line.split(' '),
        cmd = parts.join(' '),
        ok = (s = 'completed') => socket.write(tag + ' OK ' + s + '\r\n');
      if (/^CAPABILITY/i.test(cmd)) {
        socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n');
        ok();
      } else if (/^AUTHENTICATE/i.test(cmd)) {
        if (parts.length > 2) ok('authenticated');
        else {
          auth = tag;
          socket.write('+ \r\n');
        }
      } else if (/^LOGIN/i.test(cmd)) ok();
      else if (/^SELECT|^EXAMINE/i.test(cmd)) {
        socket.write(
          '* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 123] epoch\r\n* OK [UIDNEXT 2] next\r\n',
        );
        socket.write(tag + ' OK [READ-WRITE] selected\r\n');
      } else if (/^UID SEARCH/i.test(cmd)) {
        socket.write('* SEARCH 1\r\n');
        ok();
      } else if (/^UID FETCH/i.test(cmd)) {
        if (/BODY(?:\.PEEK)?\[\]/.test(cmd)) {
          bodyReads++;
          socket.write(`* 1 FETCH (UID 1 BODY[] {${Buffer.byteLength(source)}}\r\n${source})\r\n`);
        } else
          socket.write(
            '* 1 FETCH (UID 1 RFC822.SIZE 160 ENVELOPE ("Thu, 05 Nov 2026 08:00:00 +0800" "Synthetic subject" (("Sender" NIL "sender" "example.invalid")) NIL NIL (("Recipient" NIL "recipient" "example.invalid")) NIL NIL NIL "<fixture@example.invalid>"))\r\n',
          );
        ok();
      } else if (/^LIST/i.test(cmd)) {
        socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
        ok();
      } else if (/^LOGOUT/i.test(cmd)) {
        socket.write('* BYE fixture\r\n');
        ok();
        socket.end();
      } else if (/^NOOP|^CLOSE/i.test(cmd)) ok();
      else socket.write(tag + ' BAD unsupported fixture command\r\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const app = await setup(t);
  await app.plugins.enable('mail');
  app.secrets.get = async () => 'fixture';
  app.store.put('mail-accounts', 'fixture', {
    id: 'fixture',
    personaId: 'companion',
    name: 'Fixture',
    user: 'fixture',
    passwordRef: 'fixture',
    from: 'fixture@example.invalid',
    mailbox: 'INBOX',
    imap: { host: '127.0.0.1', port: (server.address() as any).port, secure: false },
    smtp: { host: '127.0.0.1', port: 1, secure: false },
  });
  assert.equal((await app.mail.sync('fixture', new AbortController().signal)).count, 1);
  assert.equal((await app.mail.sync('fixture', new AbortController().signal)).count, 0);
  assert.equal(bodyReads, 0);
  const row = app.store.documents<any>('mail')[0];
  assert.equal(row.subject, 'Synthetic subject');
  assert.match((await app.mail.read(row.id, new AbortController().signal)).text!, /Synthetic body/);
  assert.equal(bodyReads, 1);
});
test('bundled packages share a validated manifest and no legacy PW tool namespace', async (t) => {
  const app = await setup(t);
  for (const p of app.plugins.list()) {
    assert.equal(p.package, '@echo/' + p.id);
    assert.equal(p.apiVersion, 1);
    const file = JSON.parse(
      await readFile(['clock', 'storage','models'].includes(p.id) ? join(app.project, 'packages/kernel/components', p.id + '.json') : join(app.project, 'plugins', p.id, 'echo-plugin.json'), 'utf8'),
    );
    assert.equal(file.name, p.name);
    assert.equal(file.id, p.id);
  }
  assert(app.registry.list(internal).every((op) => !op.name.startsWith('pw')));
  assert.equal(app.clock.pending, 0);
});
test('original files and generated knowledge remain distinct during reimport', async (t) => {
  const app = await setup(t),
    source = join(app.runtime, 'source.txt');
  await writeFile(source, 'first original');
  const a = await app.knowledge.import('local', source);
  await writeFile(source, 'second original');
  const b = await app.knowledge.import('local', source);
  assert.equal(a.id, b.id);
  assert.equal((await app.knowledge.read(a.id)).content, 'second original');
  const files = (await app.files.records()).filter((f) => f.source === source);
  assert.equal(files.length, 1);
  assert.equal(files.filter((f) => f.kind === 'source').length, 1);
  for (const f of files)
    assert.equal(
      await readFile(await app.files.path(f.vaultId, f.relativePath), 'utf8'),
      'second original',
    );
});
test('Office parsing is optional and runs on demand; keyword knowledge works without semantic models', async (t) => {
  const app = await setup(t),
    source = join(app.runtime, 'example.docx');
  await writeFile(
    source,
    zipSync({
      'word/document.xml': strToU8(
        '<w:document><w:p><w:r><w:t>Paper on membrane transport</w:t></w:r></w:p></w:document>',
      ),
    }),
  );
  assert.equal(app.localModels.status().loaded,0);
  const record = await app.knowledge.import('local', source);
  assert.match((await app.knowledge.read(record.id)).content, /membrane transport/);
  const hits = await app.knowledge.search('membrane', new AbortController().signal);
  assert(hits.some((h) => h.documentId === record.id && h.method === 'keyword'));
  assert.equal(app.store.documents('vectors').length, 0);
  await assert.rejects(app.plugins.disable('documents'), /内建模块/);
  assert.equal(app.plugins.active.has('knowledge'), true);
});
test('shared clock leaves no timer when idle and computes local deadlines', async () => {
  const clock = new Clock();
  let calls = 0;
  assert.equal(clock.pending, 0);
  const off = clock.at('cancel', Date.now() + 10, () => calls++);
  off();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 0);
  clock.at('fire', Date.now() + 5, () => calls++);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  assert.equal(clock.pending, 0);
  await clock.close();
  assert.equal(
    new Date(nextDaily(new Date('2026-11-05T00:00:00Z'), 7, 0, 'Asia/Shanghai')).toISOString(),
    '2026-11-05T23:00:00.000Z',
  );
});
test('Scheduler claims once, fences unknown results and tolerates handler removal', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('scheduler');
  let calls = 0;
  const removeProvider = app.capabilities.provide(
    {
      id: 'fixture',
      permissions: new Set(['scheduler.contribute']),
      signal: new AbortController().signal,
    },
    'scheduler.handlers@1',
    'fixture.job',
    'Fixture',
    () => {
      calls++;
      throw Error('unknown external effect');
    },
  );
  app.scheduler.save({ id: 'task', name: 'Task', provider: 'fixture.job', mode: 'interval' });
  const first = await app.scheduler.execute('task', 123);
  assert.equal(first.state, 'unknown');
  assert.equal((await app.scheduler.execute('task', 123)).state, 'unknown');
  assert.equal(calls, 1);
  await assert.rejects(app.scheduler.execute('task', 124), /核对/);
  await app.registry.call('scheduler.resolve', { id: first.id, confirmed: true }, internal);
  assert.equal(app.scheduler.jobs()[0].blocked, undefined);
  removeProvider();
  assert.equal(app.clock.pending, 0);
  assert.equal(app.plugins.active.has('memory'), true);
});
test('Agenda uses revision checks and contributes only selected Review materials', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('agenda');
  const task = app.agenda.save({ title: 'Synthetic task' });
  assert.throws(() => app.agenda.save({ ...task, revision: 0 }), /变化/);
  assert.equal((await app.reviews.collect('companion')).length, 0);
  app.store.set('review.config', { sourceIds: ['agenda.source'] });
  assert.equal((await app.reviews.collect('companion'))[0].text.includes('Synthetic task'), true);
  await app.plugins.disable('agenda');
  assert.equal((await app.reviews.collect('companion')).length, 0);
});
test('Backup is a consistent SQLite snapshot with managed originals and no credentials', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('backup');
  await app.knowledge.save('local', 'Synthetic', 'backup content');
  app.store.put('channel-outbound', 'pending', { id: 'pending', state: 'pending' });
  app.store.put('channel-outbound', 'sending', { id: 'sending', state: 'sending' });
  app.store.put('mail-trigger-rules', 'fixture', { id: 'fixture', enabled: true });
  app.store.set('backup.config', { directory: join(app.runtime, 'backups'), keep: 1 });
  const result = await app.backups.run(new AbortController().signal);
  const checked = await app.backups.inspect(result.directory);
  assert.equal(checked.valid, true);
  assert.equal(checked.credentialsIncluded, false);
  assert(!checked.files.some((f: any) => /credential|\.secret|master.key/.test(f.path)));
  const restored = await app.backups.restore(
    result.directory, join(app.runtime, 'restored'), new AbortController().signal,
  );
  const restoredDb = new DatabaseSync(join(restored.directory, 'echo.sqlite'), { readOnly: true });
  try {
    const read = restoredDb.prepare('SELECT data FROM documents WHERE namespace=? AND id=?');
    const entry = (namespace: string, id: string) =>
      JSON.parse(String(read.get(namespace, id)?.data));
    assert.equal(entry('channel-outbound', 'pending').state, 'skipped');
    assert.equal(entry('channel-outbound', 'sending').state, 'unknown');
    assert.equal(entry('mail-trigger-rules', 'fixture').enabled, false);
  } finally {
    restoredDb.close();
  }
  for (const vault of app.files.roots()) {
    const db = new DatabaseSync(join(result.directory, 'vaults', vault.id, 'library.sqlite'), {
      readOnly: true,
    });
    try {
      assert.equal(
        (db.prepare('SELECT count(*) n FROM entries').get() as any).n,
        (await app.knowledge.list(vault.id)).length,
      );
      if (vault.owner)
        assert.equal(
          (db.prepare("SELECT value FROM library_meta WHERE key='owner'").get() as any).value,
          vault.owner,
        );
    } finally {
      db.close();
    }
  }
  await app.backups.run(new AbortController().signal);
  assert.equal(
    (await readdir(join(app.runtime, 'backups'))).filter((n) => n.startsWith('echo-backup-'))
      .length,
    1,
  );
});
test('Care uses the same conversation and respects optional observation blockers', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('care');
  const c = conversation(app, { injection: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.set('care.config', { enabled: true, conversationId: c.id, hourStart: 0, hourEnd: 24,mode:'probability',probability:100 });
  const off = app.capabilities.provide(
    { id: 'fixture', permissions: new Set(['care.block']), signal: new AbortController().signal },
    'care.blockers@1',
    'fixture.entertainment',
    'Watching',
    () => ({ blocked: true }),
  );
  assert.equal(((await app.care.tick()) as any).skipped, 'fixture.entertainment');
  assert.equal(backend.calls.length, 0);
  off();
  await app.care.tick();
  assert.equal(backend.calls.length, 1);
  assert.equal(app.store.allMessages(c.id).at(-1)?.role, 'assistant');
  await until(()=>app.store.pendingDeliveries().length===1);
  assert.equal(app.store.pendingDeliveries().length, 1);
});
async function smtp(t: any, disconnect = false) {
  let accepted = 0;
  const server = createServer((socket) => {
    socket.write('220 fixture ESMTP\r\n');
    let data = false;
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (data) {
        if (line === '.') {
          accepted++;
          data = false;
          if (disconnect) socket.destroy();
          else socket.write('250 accepted\r\n');
        }
        return;
      }
      if (/^EHLO/.test(line)) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH/.test(line)) socket.write('235 authenticated\r\n');
      else if (/^MAIL FROM|^RCPT TO/.test(line)) socket.write('250 ok\r\n');
      else if (line === 'DATA') {
        data = true;
        socket.write('354 continue\r\n');
      } else if (line === 'QUIT') {
        socket.end('221 bye\r\n');
      } else socket.write('250 ok\r\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { port: (server.address() as any).port, count: () => accepted };
}
for (const unknown of [false, true])
  test(`Mail exact-draft approval is single-use, SMTP ${unknown ? 'unknown is not replayed' : 'success is recorded'}`, async (t) => {
    const app = await setup(t),
      fixture = await smtp(t, unknown);
    await app.plugins.enable('mail-actions');
    app.secrets.get = async () => 'synthetic-password';
    app.store.put('mail-accounts', 'test', {
      id: 'test',
      personaId: 'companion',
      name: 'Test',
      user: 'test',
      passwordRef: 'synthetic',
      from: 'test@example.invalid',
      mailbox: 'INBOX',
      imap: { host: '127.0.0.1', port: 1, secure: false },
      smtp: { host: '127.0.0.1', port: fixture.port, secure: false },
    });
    const draft = app.mail.draft({
      accountId: 'test',
      to: ['recipient@example.invalid'],
      subject: 'Synthetic only',
      text: 'Fixture',
    });
    await assert.rejects(
      app.registry.call('mail.send', { id: draft.id, hash: draft.hash, confirmed: true }, internal),
      /未找到/,
    );
    const request = await app.registry.call(
      'mail-actions.propose',
      { draftId: draft.id },
      internal,
    );
    await assert.rejects(
      app.registry.call(
        'approvals.decide',
        { id: request.id, revision: 1, decision: 'approve', confirmed: true },
        internal,
      ),
      /前端/,
    );
    const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
    await Promise.all([
      app.registry.call(
        'approvals.decide',
        { id: request.id, revision: 1, decision: 'approve', confirmed: true },
        ui,
      ),
      app.registry.call(
        'approvals.decide',
        { id: request.id, revision: 1, decision: 'approve', confirmed: true },
        ui,
      ),
    ]);
    assert.equal(fixture.count(), 1);
    assert.equal(
      app.store.document<any>('mail-drafts', draft.id).state,
      unknown ? 'unknown' : 'sent',
    );
    await assert.rejects(app.mail.send(draft.id, draft.hash, new AbortController().signal));
    assert.equal(fixture.count(), 1);
  });
