import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import { sections } from '../apps/workbench/src/navigation.ts';
const caller = { kind: 'ui' as const, permissions: new Set(['*']) };
test('display preferences persist without altering persona or conversation data', async (t) => {
  const app = await setup(t);
  const before = app.store.documents('personas');
  await app.registry.call('preferences.save', { language: 'en', accent: '#168477' }, caller);
  const boot = await app.registry.call('system.bootstrap', {}, caller);
  assert.deepEqual(boot.preferences, { language: 'en', accent: '#168477' });
  assert.deepEqual(app.store.documents('personas'), before);
  await assert.rejects(() =>
    app.registry.call('preferences.save', { language: 'fr', accent: 'red' }, caller),
  );
  assert.deepEqual(app.store.get('preferences', {}), boot.preferences);
});
test('mail pagination is stable across identical dates, scopes accounts, and excludes cached bodies', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('mail');
  for (const id of ['a', 'b', 'c', 'd'])
    app.store.put('mail', id, {
      id,
      accountId: id === 'd' ? 'other' : 'account',
      date: '2026-11-05T00:00:00.000Z',
      subject: 'Synthetic',
      from: 'sender@example.test',
      text: 'Cached body',
      attachments: [{ name: 'attachment' }],
    });
  const one = await app.registry.call('mail.list', { accountId: 'account', limit: 2 }, caller);
  assert.deepEqual(
    one.messages.map((m: any) => m.id),
    ['c', 'b'],
  );
  assert.equal(one.hasMore, true);
  assert.ok(
    one.messages.every(
      (m: any) =>
        m.text === undefined &&
        m.attachments === undefined &&
        m.bodyCached &&
        m.attachmentCount === 1,
    ),
  );
  const two = await app.registry.call(
    'mail.list',
    { accountId: 'account', limit: 2, before: one.cursor },
    caller,
  );
  assert.deepEqual(
    two.messages.map((m: any) => m.id),
    ['a'],
  );
  assert.equal(two.hasMore, false);
  assert.equal(
    (await app.registry.call('mail.list', { query: 'cached body' }, caller)).messages.length,
    4,
  );
});
test('workbench has unique view IDs and a calendar entry', () => {
  const pages = sections.flatMap((s) => s.views.map((v) => v.id));
  assert.equal(new Set(pages).size, pages.length);
  assert.deepEqual(
    sections.find((s) => s.id === 'agenda')?.views.map((v) => v.id),
    ['agenda'],
  );
});
