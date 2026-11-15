import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
import {
  initialWorkspaceScope,
  initialWorkbenchLocation,
  workbenchLocation,
  workspaceScopeFor,
  sections,
} from '../apps/workbench/src/navigation.ts';
import type { FrontendPageEntry } from '../packages/contracts/frontend.ts';
const caller = { kind: 'ui' as const, permissions: new Set(['*']) };

test('role and application routes have explicit scope, including registered pages and deep links', () => {
  assert.equal(initialWorkspaceScope('?page=automation&persona=example'), false);
  assert.equal(initialWorkspaceScope('?page=automation&workspace=true'), true);
  assert.equal(initialWorkspaceScope('?page=knowledge&persona=example'), true);
  assert.equal(initialWorkspaceScope('?page=automation'), true);
  assert.equal(workspaceScopeFor('automation', [], false), false);
  assert.equal(workspaceScopeFor('automation', [], true), true);
  assert.equal(
    workspaceScopeFor('automation', [], true, { roleId: 'example', workspace: true }),
    false,
  );
  assert.equal(workspaceScopeFor('knowledge', [], false), true);
  const roleRoute = initialWorkbenchLocation('?page=automation&persona=example');
  assert.equal(roleRoute.scope, 'role');
  assert.equal(roleRoute.personaId, 'example');
  assert.equal(workbenchLocation('character-session', [], roleRoute).personaId, 'example');
  assert.equal(
    workbenchLocation('character', [], roleRoute, { roleId: 'another' }).personaId,
    'another',
  );
  assert.equal(workbenchLocation('knowledge', [], roleRoute).scope, 'workspace');
  assert.equal(workbenchLocation('knowledge', [], roleRoute).personaId, undefined);
  assert.equal(initialWorkbenchLocation('?window=settings').scope, 'settings');
  const editor = workbenchLocation('character-wizard', [], roleRoute, { roleId: null });
  assert.equal(editor.scope, 'role');
  assert.equal(editor.presentation, 'editor');
  assert.equal(editor.personaId, undefined);
  assert.equal(
    workbenchLocation('missing.page', [], {
      page: 'missing.page',
      scope: 'workspace',
      sectionId: 'agenda',
    }).sectionId,
    'agenda',
  );
  const page = (placement: 'character' | 'workspace'): FrontendPageEntry => ({
    id: 'example.page',
    title: 'Example',
    owner: 'example',
    ownerName: 'Example',
    placement,
    order: 0,
    view: { type: 'form', load: 'example.read', fields: [] },
  });
  assert.equal(workspaceScopeFor('example.page', [page('character')], true), false);
  assert.equal(
    workspaceScopeFor('example.page', [page('workspace')], false, { roleId: 'example' }),
    true,
  );
});
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
