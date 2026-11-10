import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { createServer } from 'node:net';
import { mailProxy } from '../plugins/mail/network.ts';
const ui = { kind: 'ui' as const, permissions: new Set(['*']) };

test('mail honors per-account HTTP CONNECT routing without persisting proxy secrets or falling back to direct', async (t) => {
  const requests: string[] = [];
  const proxy = createServer((socket) =>
    socket.once('data', (data) => {
      requests.push(data.toString().split('\r\n')[0]);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    }),
  );
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = `http://synthetic:proxy-secret@127.0.0.1:${(proxy.address() as any).port}`;
  t.after(() => {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  });
  const app = await setup(t);
  await app.plugins.enable('mail');
  app.secrets.get = async () => 'synthetic';
  await app.registry.call(
    'mail.configure',
    {
      id: 'proxied',
      name: 'Synthetic',
      user: 'reader@example.invalid',
      from: 'reader@example.invalid',
      passwordRef: 'unused',
      network: 'environment-proxy',
      imap: { host: 'mail.example.invalid', port: 993 },
      smtp: { host: 'mail.example.invalid', port: 465 },
    },
    ui,
  );
  await assert.rejects(app.mail.folders('proxied', new AbortController().signal));
  assert.deepEqual(requests, ['CONNECT mail.example.invalid:993 HTTP/1.1']);
  app.mail.folders = async () => [];
  await assert.rejects(app.mail.testAccount('proxied', new AbortController().signal));
  assert.deepEqual(requests, [
    'CONNECT mail.example.invalid:993 HTTP/1.1',
    'CONNECT mail.example.invalid:465 HTTP/1.1',
  ]);
  assert(!JSON.stringify(app.store.document('mail-accounts', 'proxied')).includes('proxy-secret'));
  assert.equal(mailProxy('direct', 'mail.example.invalid'), undefined);
  assert.equal(mailProxy('environment-proxy', '127.0.0.1'), undefined);
  assert.throws(() => mailProxy('environment-proxy', 'mail.example.invalid', {}), /未配置/);
  assert.throws(
    () =>
      mailProxy('environment-proxy', 'mail.example.invalid', {
        HTTPS_PROXY: 'socks5://synthetic:secret@localhost:1',
      }),
    /CONNECT/,
  );
});
test('account sync discovers the sent folder and isolates UID checkpoints by folder', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('mail');
  await app.registry.call(
    'mail.configure',
    {
      id: 'sample',
      name: 'Sample',
      user: 'a@example.invalid',
      from: 'a@example.invalid',
      passwordRef: 'unused',
      imap: { host: 'example.invalid', port: 993 },
      smtp: { host: 'example.invalid', port: 465 },
    },
    ui,
  );
  let selected = '';
  const client = {
    mailbox: { uidValidity: '1' },
    list: async () => [
      { path: 'INBOX', name: 'Inbox', flags: new Set() },
      { path: 'Sent Items', name: 'Sent', specialUse: '\\Sent', flags: new Set() },
    ],
    getMailboxLock: async (path: string) => {
      selected = path;
      return { release() {} };
    },
    search: async () => [1],
    fetchOne: async () => ({
      size: 100,
      envelope: { subject: selected, from: [], date: new Date() },
      flags: new Set(),
    }),
  };
  (app.mail as any).connect = async () => ({ client, close: async () => {} });
  const result = await app.registry.call('mail.sync', { accountId: 'sample' }, ui);
  assert.equal(result.count, 2);
  assert.equal(app.store.documents('mail').length, 2);
  assert.equal((await app.registry.call('mail.sync', { accountId: 'sample' }, ui)).count, 0);
});
test('mail discovers special folders and executes a frozen batch once, fencing unknown results', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('mail-actions');
  await app.registry.call(
    'mail.configure',
    {
      id: 'sample',
      name: 'Sample',
      user: 'sample@example.invalid',
      from: 'sample@example.invalid',
      passwordRef: 'unused',
      imap: { host: 'example.invalid', port: 993 },
      smtp: { host: 'example.invalid', port: 465 },
    },
    internal,
  );
  let moves = 0,
    epoch = '1';
  const client = {
    mailbox: {
      get uidValidity() {
        return epoch;
      },
    },
    list: async () => [
      { path: 'INBOX', name: 'Inbox', flags: new Set() },
      { path: 'Archive', name: 'Archive', specialUse: '\\Archive', flags: new Set() },
    ],
    getMailboxLock: async () => ({ release() {} }),
    fetchOne: async () => ({ uid: 1, flags: new Set() }),
    messageMove: async () => {
      moves++;
      throw Error('Disconnected after command');
    },
  };
  (app.mail as any).connect = async () => ({ client, close: async () => {} });
  const folders = await app.registry.call('mail.folders', { accountId: 'sample' }, ui);
  assert.equal(folders[1].specialUse, '\\Archive');
  app.store.put('mail', 'one', {
    id: 'one',
    accountId: 'sample',
    personaId: 'companion',
    mailbox: 'INBOX',
    uid: 1,
    validity: '1',
    subject: 'Synthetic',
    from: 'writer@example.invalid',
    date: new Date().toISOString(),
    seenAt: new Date().toISOString(),
  });
  const first = await app.registry.call(
    'mail-actions.organize',
    { ids: ['one'], action: 'archive', requestId: 'batch1' },
    internal,
  );
  const result = await app.registry.call(
    'approvals.decide',
    { id: first.id, revision: first.revision, decision: 'approve', confirmed: true },
    ui,
  );
  assert.equal(result.state, 'unknown');
  assert.equal(moves, 1);
  await app.registry.call('approvals.inspect', { id: first.id }, ui);
  await app.registry.call(
    'approvals.decide',
    { id: first.id, revision: 1, decision: 'approve', confirmed: true },
    ui,
  );
  assert.equal(moves, 1);
  const second = await app.registry.call(
    'mail-actions.organize',
    { ids: ['one'], action: 'archive', requestId: 'batch2' },
    internal,
  );
  epoch = '2';
  assert.equal(
    (
      await app.registry.call(
        'approvals.decide',
        { id: second.id, revision: second.revision, decision: 'approve', confirmed: true },
        ui,
      )
    ).state,
    'failed',
  );
  assert.equal(moves, 1);
});
test('provider setup keeps passwords outside account documents and validates identity before replacing credentials', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('mail');
  const secrets = new Map<string, string>();
  app.secrets.set = async (k, v) => {
    secrets.set(k, v);
  };
  app.secrets.get = async (k) => secrets.get(k);
  const value = {
    id: 'sample',
    provider: 'qq',
    name: 'Sample',
    user: 'sample@example.invalid',
    from: 'sample@example.invalid',
    imap: { host: 'imap.qq.com', port: 993 },
    smtp: { host: 'smtp.qq.com', port: 465 },
    password: 'synthetic-secret',
  };
  const result = await app.registry.call('mail.configure', value, ui);
  assert.equal(secrets.get(result.passwordRef), 'synthetic-secret');
  assert.equal(
    JSON.stringify(app.store.document('mail-accounts', result.id)).includes('synthetic-secret'),
    false,
  );
  app.store.put('mail', 'cached', { id: 'cached', accountId: 'sample' });
  await assert.rejects(
    () =>
      app.registry.call(
        'mail.configure',
        { ...value, imap: { host: 'other.invalid', port: 993 } },
        ui,
      ),
    /新增账户/,
  );
  assert.equal(secrets.size, 1);
});
