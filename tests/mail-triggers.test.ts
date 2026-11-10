import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { accountSchema } from '../plugins/mail/index.ts';
import { migrateMailReminderFilters } from '../plugins/mail-triggers/index.ts';
import { EchoError } from '../packages/contracts/index.ts';
const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
async function fixture(t: any) {
  const app = await setup(t);
  await app.plugins.enable('notifications');
  await app.plugins.enable('mail-triggers');
  await app.mailTriggers.settled();
  const account = accountSchema.parse({
    id: 'fixture-mail',
    personaId: 'companion',
    name: 'Fixture inbox',
    user: 'fixture@example.invalid',
    from: 'fixture@example.invalid',
    passwordRef: 'unused',
    imap: { host: 'localhost', port: 143, secure: false },
    smtp: { host: 'localhost', port: 25, secure: false },
  });
  app.store.put('mail-accounts', account.id, account);
  const mails = new Map<number, { subject: string; from: string; flags?: string[] }>();
  let epoch = '1';
  (app.mail as any).connect = async () => ({
    close: async () => {},
    client: {
      mailbox: { uidValidity: epoch },
      getMailboxLock: async () => ({ release() {} }),
      search: async () => [...mails.keys()],
      fetchOne: async (uid: number) => {
        const m = mails.get(uid);
        return m
          ? {
              envelope: {
                subject: m.subject,
                from: [{ address: m.from }],
                to: [],
                date: new Date(),
              },
              flags: new Set(m.flags ?? []),
              size: 100,
            }
          : false;
      },
    },
  });
  const sync = () => app.mail.sync(account.id, new AbortController().signal);
  return {
    app,
    mails,
    sync,
    setEpoch: (value: string) => {
      epoch = value;
    },
    account,
  };
}

test('new-mail events exclude initial sync, backfill, duplicates and UID resets', async (t) => {
  const { app, mails, sync, setEpoch } = await fixture(t);
  mails.set(100, { subject: 'Existing mail', from: 'one@example.invalid' });
  await sync();
  assert.equal(app.store.documents('mail-arrivals').length, 0);
  mails.set(101, { subject: 'New mail', from: 'one@example.invalid' });
  await sync();
  await sync();
  assert.equal(app.store.documents('mail-arrivals').length, 1);
  mails.set(99, { subject: 'History', from: 'one@example.invalid' });
  app.store.set('mail.historyBefore.fixture-mail.INBOX.1', 100);
  await app.mail.sync('fixture-mail', new AbortController().signal, true);
  assert.equal(app.store.documents('mail-arrivals').length, 1);
  setEpoch('2');
  await sync();
  assert.equal(app.store.documents('mail-arrivals').length, 1);
});

test('mail rules filter new arrivals and deliver one program notice without model inference', async (t) => {
  const { app, mails, sync } = await fixture(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await sync();
  await app.mailTriggers.settled();
  const rule = await app.mailTriggers.save('important', {
    enabled: true,
    accountIds: ['fixture-mail'],
    rules: [{ name: 'Deadlines', match: 'sender', terms: 'editor@example.invalid' }],
    hourStart: 0,
    hourEnd: 24,
    humanQuietMinutes: 0,
  });
  await app.mailTriggers.settled();
  mails.set(1, { subject: 'A newsletter deadline', from: 'news@example.invalid' });
  mails.set(2, { subject: 'Submission DEADLINE', from: 'editor@example.invalid' });
  await sync();
  await app.mailTriggers.settled();
  assert.equal(app.store.documents('notifications').length, 1);
  assert.equal(backend.calls.length, 0);
  await sync();
  await app.mailTriggers.settled();
  await app.plugins.disable('mail-triggers');
  await app.plugins.enable('mail-triggers');
  await app.mailTriggers.settled();
  assert.equal(app.store.documents('notifications').length, 1);
  assert.equal(app.store.documents<any>('mail-trigger-batches')[0].items.length, 1);
  const catalog: any = await app.registry.call('automation.catalog', {}, ui);
  const type = catalog.types.find((t: any) => t.id === 'mail-triggers.rules');
  assert.equal(type.defaults.remindAll, false);
  assert.deepEqual(type.defaults.rules, []);
  assert.equal(type.fields.find((f: any) => f.key === 'rules').rowTitleKey, 'name');
  assert.equal(rule.action, 'notice');
});

test('enabling a mail trigger starts at the current cursor and does not replay earlier arrivals', async (t) => {
  const { app, mails, sync } = await fixture(t);
  await sync();
  mails.set(1, { subject: 'Earlier arrival', from: 'one@example.invalid' });
  await sync();
  await app.mailTriggers.settled();
  await app.mailTriggers.save('from-now', {
    matchAll: true,
    enabled: true,
    accountIds: ['fixture-mail'],
    hourStart: 0,
    hourEnd: 24,
    humanQuietMinutes: 0,
  });
  await app.mailTriggers.settled();
  assert.equal(app.store.documents('notifications').length, 0);
  mails.set(2, { subject: 'Later arrival', from: 'one@example.invalid' });
  await sync();
  await app.mailTriggers.settled();
  assert.equal(app.store.documents('notifications').length, 1);
});

test('mail model reminders respect quiet activity and do not replay unknown runs after reload', async (t) => {
  const { app, mails, sync } = await fixture(t),
    c = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  backend.responder = async () => {
    throw new EchoError('network', 'Unknown remote outcome', true);
  };
  await sync();
  await app.mailTriggers.settled();
  const rule = await app.mailTriggers.save('role-reminder', {
    matchAll: true,
    enabled: true,
    accountIds: ['fixture-mail'],
    conversationId: c.id,
    action: 'conversation',
    hourStart: 0,
    hourEnd: 24,
    humanQuietMinutes: 0,
  });
  await app.mailTriggers.settled();
  mails.set(1, { subject: 'Important', from: 'one@example.invalid' });
  await sync();
  await app.mailTriggers.settled();
  assert.equal(backend.calls.length, 1);
  assert.equal(app.store.documents<any>('mail-trigger-batches')[0].state, 'unknown');
  await app.plugins.disable('mail-triggers');
  await app.plugins.enable('mail-triggers');
  await app.mailTriggers.settled();
  assert.equal(backend.calls.length, 1);
  await app.mailTriggers.save(rule.id, { ...rule, enabled: false });
  assert.equal(app.mailTriggers.rules()[0].enabled, false);
  assert(app.store.allMessages(c.id).some((m) => m.source === 'trigger' && m.role === 'system'));
});

test('a mail batch interrupted before creating a run drops stale clues and keeps fresh ones', async (t) => {
  const { app } = await fixture(t),
    chat = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const rule = await app.mailTriggers.save('interrupted-batch', {
    enabled: true,
    matchAll: true,
    accountIds: ['fixture-mail'],
    action: 'conversation',
    conversationId: chat.id,
    hourStart: 0,
    hourEnd: 24,
    humanQuietMinutes: 0,
    maxAgeHours: 1,
  });
  await app.mailTriggers.settled();
  await app.plugins.disable('mail-triggers');
  const item = {
    accountId: 'fixture-mail',
    accountName: 'Fixture inbox',
    personaId: 'companion',
    mailbox: 'INBOX',
    primary: true,
    unread: true,
    from: 'fixture@example.invalid',
    date: new Date().toISOString(),
  };
  const items = [
    {
      ...item,
      id: 'stale',
      seq: 1,
      subject: 'Stale subject',
      observedAt: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      ...item,
      id: 'fresh',
      seq: 2,
      subject: 'Fresh subject',
      observedAt: new Date().toISOString(),
    },
  ];
  app.store.put('mail-trigger-batches', 'interrupted', {
    id: 'interrupted',
    ruleId: rule.id,
    state: 'running',
    action: 'conversation',
    items,
    conversationId: chat.id,
    createdAt: new Date().toISOString(),
  });
  app.store.put('mail-trigger-state', rule.id, {
    cursor: 0,
    pending: items,
    lastBatch: 'interrupted',
  });
  await app.plugins.enable('mail-triggers');
  await app.mailTriggers.settled();
  assert.equal(app.store.document<any>('mail-trigger-batches', 'interrupted')?.state, 'cancelled');
  assert.equal(backend.calls.length, 1);
  assert.match(JSON.stringify(backend.calls[0].messages), /Fresh subject/);
  assert.doesNotMatch(JSON.stringify(backend.calls[0].messages), /Stale subject/);
});

test('mail rules defer while a human is active and publish one built-in notification', async (t) => {
  const { app, mails, sync } = await fixture(t);
  const c = conversation(app);
  await sync();
  await app.mailTriggers.settled();
  app.store.append(c.id, 'user', 'human', 'Fixture human input');
  const rule = await app.mailTriggers.save('pending-notice', {
    matchAll: true,
    enabled: true,
    accountIds: ['fixture-mail'],
    hourStart: 0,
    hourEnd: 24,
    conversationId: c.id,
    humanQuietMinutes: 1,
  });
  await app.mailTriggers.settled();
  mails.set(1, { subject: 'New item', from: 'one@example.invalid' });
  await sync();
  await app.mailTriggers.settled();
  assert.equal(app.store.documents('notifications').length, 0);
  assert.equal(app.store.document<any>('mail-trigger-state', 'pending-notice').pending.length, 1);
  await app.mailTriggers.check(rule, Date.now() + 120000);
  await until(() => app.store.documents('notifications').length === 1);
  await app.mailTriggers.settled();
  assert.equal(app.store.document<any>('mail-trigger-state', 'pending-notice').pending.length, 0);
});

test('character configuration can enable its mail trigger in the same save', async (t) => {
  const { app, account } = await fixture(t);
  const role = await app.registry.call(
    'persona.character.commit',
    {
      requestId: 'enable-mail-while-configuring',
      draft: {
        persona: { id: 'fixture-role', name: 'Fixture', prompt: 'Fixture' },
        features: ['mail', 'mail-triggers'],
        configurations: { mail: { accountIds: [account.id] } },
        profileId: 'test',
        tasks: [
          {
            id: 'fixture-rule',
            type: 'mail-triggers.rules',
            settings: {
              name: 'Fixture trigger',
              enabled: true,
              accountIds: [account.id],
              matchAll: true,
              action: 'conversation',
            },
          },
        ],
      },
    },
    ui,
  );
  assert.equal(role.state, 'ready');
  assert.equal(app.mailTriggers.rules()[0].enabled, true);
  assert.equal(app.mailTriggers.rules()[0].conversationId, role.mainConversationId);
});

test('shared reminder rules use the first match, and task subscriptions respect mailbox grants', async (t) => {
  const { app, account, mails, sync } = await fixture(t);
  const c = conversation(app);
  app.store.set('mail.config', {
    reminderRules: [
      { name: 'Promotional mail', outcome: 'skip', match: 'subject', terms: 'newsletter' },
      { name: 'Deadline', outcome: 'remind', match: 'subject', terms: 'deadline' },
    ],
  });
  await sync();
  await app.mailTriggers.settled();
  app.store.put('mail-trigger-rules', 'application-rules', {
    id: 'application-rules',
    enabled: true,
    selection: 'application',
    accountIds: [account.id],
    conversationId: c.id,
    hourStart: 0,
    hourEnd: 24,
    humanQuietMinutes: 0,
  });
  app.store.set('mail-triggers.roleFilters.v1', false);
  migrateMailReminderFilters(app.store);
  assert.equal(app.mailTriggers.rules()[0].useLegacyFilters, true);
  assert.deepEqual(app.store.get('mail.config', {}), {});
  await app.mailTriggers.settled();
  mails.set(1, { subject: 'Newsletter deadline', from: 'news@example.invalid' });
  mails.set(2, { subject: 'Submission deadline', from: 'editor@example.invalid' });
  mails.set(3, { subject: 'Unmatched', from: 'test@example.invalid' });
  await sync();
  await app.mailTriggers.settled();
  const batches = app.store.documents<any>('mail-trigger-batches');
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].items.map((item: any) => item.subject),
    ['Submission deadline'],
  );
  assert.equal(batches[0].items[0].reminder, undefined);

  const scoped = { kind: 'mcp' as const, permissions: new Set(['*']), personaId: 'reader' };
  assert.equal((await app.registry.call('mail.list', {}, scoped)).messages.length, 0);
  assert.equal((await app.materials.entries.get('mail.source')!.read('reader')).length, 0);
  app.store.put('character-settings.mail', 'reader', { accountIds: [account.id] });
  const listed = await app.registry.call('mail.list', {}, scoped);
  assert.equal(listed.messages.length, 3);
  assert.equal(listed.accounts[0].passwordRef, undefined);
  const reviewed = await app.materials.entries.get('mail.source')!.read('reader', [account.id]);
  assert(reviewed.every((row) => row.personaId === 'reader' && row.streamId === account.id));
  assert.equal(reviewed.length, 3);
  assert.deepEqual(await app.materials.entries.get('mail.source')!.read('reader', ['other']), []);
  app.store.put('character-settings.mail', 'reader', { accountIds: [] });
  await assert.rejects(app.registry.call('mail.read', { id: listed.messages[0].id }, scoped), {
    code: 'mail_scope',
  });
});

test('role reminder rules work independently and old exclusions keep filtering after migration', async (t) => {
  const { app, account, mails, sync } = await fixture(t);
  const sharedRules = [
    { name: 'Promotional mail', outcome: 'skip', match: 'subject', terms: 'promotion' },
    { name: 'Academic news', outcome: 'remind', match: 'subject', terms: 'seminar' },
  ];
  const oldConfig = { syncSent: false, reviewLookbackDays: 12 };
  app.store.set('mail.config', { ...oldConfig, reminderRules: sharedRules });

  await sync();
  await app.mailTriggers.settled();
  const task = {
    enabled: true,
    accountIds: [account.id],
    hourStart: 0,
    hourEnd: 24,
    humanQuietMinutes: 0,
  };
  app.store.put('mail-trigger-rules', 'research', {
    ...task, id: 'research', selection: 'application', exclude: 'sponsored',
  });
  const cursor = { cursor: 0, pending: [], lastAt: 0 };
  app.store.put('mail-trigger-state', 'research', cursor);
  app.store.set('mail-triggers.roleFilters.v1', false);
  migrateMailReminderFilters(app.store);
  migrateMailReminderFilters(app.store);
  assert.deepEqual(app.store.get('mail.config', {}), oldConfig);
  assert.deepEqual(app.store.document('mail-trigger-state', 'research'), cursor);
  await assert.rejects(app.mailTriggers.save('empty', task), { code: 'trigger_conditions' });
  await app.mailTriggers.save('games', {
    ...task,
    rules: [
      { name: 'Game sale', match: 'subject', terms: 'game sale' },
      { name: 'Game shop', match: 'domain', terms: 'shop.example.invalid' },
    ],
  });
  await app.mailTriggers.settled();
  mails.set(1, { subject: 'New game sale promotion', from: 'offer@shop.example.invalid' });
  mails.set(2, { subject: 'Research seminar', from: 'lab@example.invalid' });
  mails.set(3, { subject: 'Research seminar promotion', from: 'editor@example.invalid' });
  mails.set(4, { subject: 'Sponsored research seminar', from: 'editor@example.invalid' });
  mails.set(5, { subject: 'Research seminar ' + 'x'.repeat(1000) + ' promotion', from: 'lab@example.invalid' });
  await sync();
  await app.mailTriggers.settled();
  const batches = app.store.documents<{ ruleId: string; items: { subject: string }[] }>('mail-trigger-batches');
  assert.deepEqual(Object.fromEntries(batches.map((batch) => [
    batch.ruleId, batch.items.map((mail) => mail.subject),
  ])), { games: ['New game sale promotion'], research: ['Research seminar'] });
});
