import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, until } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';

test('badge providers have lifecycle isolation, preserve same-time arrivals, and retain actionable approvals', async (t) => {
  const app = await setup(t);
  const controller = new AbortController();
  const scope = app.capabilities.forOwner(
    { id: 'fixture', permissions: new Set(['ui.contribute']), signal: controller.signal },
    () => {},
  );
  const at = new Date(Date.now() + 1000).toISOString();
  let items = [{ id: 'fixture.one', page: 'fixture.page', at, pending: false }];
  scope.provide('core.ui.badges@1', 'fixture.badges', 'Fixture', () => items);
  const first = (await app.badges.snapshot()).find((b) => b.page === 'fixture.page')!;
  assert.equal(first.count, 1);
  items.push({ id: 'fixture.two', page: 'fixture.page', at, pending: false });
  await app.badges.read('fixture.page', undefined, first.cursors);
  assert.equal((await app.badges.snapshot()).find((b) => b.page === 'fixture.page')!.count, 1);
  const second = (await app.badges.snapshot()).find((b) => b.page === 'fixture.page')!;
  await app.badges.read('fixture.page', undefined, second.cursors);
  items.push({ id: 'fixture.approval', page: 'fixture.page', at, pending: true });
  const actionable = (await app.badges.snapshot()).find((b) => b.page === 'fixture.page')!;
  assert.equal(actionable.pending, 1);
  await app.badges.read('fixture.page', undefined, actionable.cursors);
  assert.equal((await app.badges.snapshot()).find((b) => b.page === 'fixture.page')!.pending, 1);
  controller.abort();
  assert(!(await app.badges.snapshot()).some((b) => b.page === 'fixture.page'));
});

test('safe restart waits for unsaved edits; cancellation restores timers without changing grants', async (t) => {
  const app = await setup(t),
    original = process.env.ECHO_DESKTOP_PID;
  process.env.ECHO_DESKTOP_PID = String(process.pid);
  t.after(() => {
    if (original === undefined) delete process.env.ECHO_DESKTOP_PID;
    else process.env.ECHO_DESKTOP_PID = original;
  });
  app.lifecycle.setDirty('settings', true);
  const request = app.lifecycle.request('restart');
  await until(() => app.lifecycle.status().blockers.includes('有尚未保存的编辑'));
  assert.equal(app.lifecycle.status().state, 'waiting');
  assert.throws(
    () => app.router.enqueue({ conversationId: 'new', requestId: 'new', text: 'New work' }),
    /正在重启更新/,
  );
  app.lifecycle.setDirty('settings', false);
  await until(() => app.lifecycle.status().state === 'ready');
  assert.equal(app.lifecycle.status().id, request.id);
  await app.registry.call('system.lifecycle.cancel', {}, internal);
  let fired = false;
  app.clock.at('management-test', Date.now(), () => {
    fired = true;
  });
  await until(() => fired);
  assert.equal(app.router.idle, true);
});

test('plugin CLI commands and jobs disappear on unload and cannot claim another namespace', async (t) => {
  const app = await setup(t);
  const commands = await app.cli.list();
  assert(commands.some((c) => c.id === 'knowledge.pipeline.status'));
  assert((await app.jobs.list()).every((j) => j.source));
  const controller = new AbortController();
  const scope = app.capabilities.forOwner(
    { id: 'fixture', permissions: new Set(['automation.contribute']), signal: controller.signal },
    () => {},
  );
  scope.provide('core.cli.commands@1', 'fixture.commands', 'Fixture', () => [
    {
      id: 'knowledge.takeover',
      operation: 'knowledge.pipeline.save',
      permission: 'knowledge.write',
      label: 'Invalid',
      inputSchema: { type: 'object' },
    },
  ]);
  await assert.rejects(app.cli.list(), /提供插件/);
  controller.abort();
  assert((await app.cli.list()).every((c) => !c.id.startsWith('fixture')));
});
