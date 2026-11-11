import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, temporary, FakeBackend, until } from './helpers.ts';
import { settings } from '../plugins/delegation/config.ts';
import { authorizeExecution } from '../plugins/delegation/authorization.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { internal } from '../packages/kernel/registry.ts';
import { echoToolPermissions } from '../packages/kernel/tool-access.ts';

test('fixed executor selection and default reasoning retain the existing model and permission ceiling', async t => {
  const app = await setup(t);
  const legacy = settings.parse({ authorizationVersion: 3, allowedProfileIds: ['approved'] });
  assert.equal(legacy.selectionMode, 'choose');
  assert.equal(legacy.defaultReasoning, 'inherit');
  assert.deepEqual(legacy.allowedProfileIds, ['approved']);
  const policy = { ...legacy, selectionMode: 'fixed' as const, fixedProfileId: 'approved', defaultReasoning: 'high' as const };
  const task = await authorizeExecution(app.store, 'fixture', 'test', policy, {});
  assert.equal(task.profileId, 'approved');
  assert.equal(task.reasoning, 'high');
  assert.equal(task.write, false);
  await assert.rejects(authorizeExecution(app.store, 'fixture', 'test', policy, { profileId: 'test' }), /已指定/);
  await assert.rejects(authorizeExecution(app.store, 'fixture', 'test', { ...policy, fixedProfileId: 'unapproved' }, {}), /未获角色授权/);
  assert.equal((await authorizeExecution(app.store, 'fixture', 'test', policy, { reasoning: 'low' })).reasoning, 'low');
});

test('unsupported task thinking is rejected before creating a task or completion notification', async t => {
  const app = await setup(t);
  const model = app.store.document<any>('profiles', 'test');
  app.store.put('profiles', 'test', { ...model, reasoningStyle: 'effort', reasoningLevels: ['low', 'high'] });
  const role = await app.registry.call('persona.character.commit', { requestId: 'think-role', draft: characterDraft.parse({
    persona: { id: 'think-role', name: 'Fixture', prompt: 'Synthetic' }, profileId: 'test', features: ['delegation'],
  }) }, internal);
  await assert.rejects(app.registry.call('delegation.request', { requestId: 'bad-think', conversationId: role.mainConversationId,
    goal: 'Synthetic', acceptance: 'Evidence', execution: { reasoning: 'medium' } }, internal), /不支持思考强度/);
  assert.equal(app.store.documents('delegated-tasks').length, 0);
});

test('per-task execution is bounded by role model, directory, tool and duration grants', async (t) => {
  const app = await setup(t),
    root = await temporary(t),
    outside = await temporary(t);
  const read = join(root, 'read'),
    write = join(root, 'write');
  await mkdir(read);
  await mkdir(write);
  const policy = settings.parse({
    authorizationVersion: 3,
    allowedProfileIds: ['other'],
    workspaces: [
      { path: read, write: false },
      { path: write, write: true },
    ],
    toolPermissions: ['memory.read', 'memory.write'],
    timeoutMinutes: 30,
    terminal: true,
  });
  app.store.put('characters', 'fixture', {
    id: 'fixture',
    toolPermissions: ['memory.read', 'memory.write'],
  });
  app.store.set('mcp.permissions', ['memory.read', 'memory.write']);
  const authorize = (value: any) => authorizeExecution(app.store, 'fixture', 'main', policy, value);
  const defaults = await authorize({});
  assert.equal(defaults.profileId, 'main');
  assert.equal(defaults.projectDirectory, read);
  assert.deepEqual(defaults.toolPermissions, ['memory.read']);
  assert.equal(defaults.write, false);
  await assert.rejects(authorize({ profileId: 'unapproved' }), /模型未获/);
  await assert.rejects(authorize({ projectDirectory: outside }), /超出角色授权/);
  await assert.rejects(authorize({ projectDirectory: read, write: true }), /超出角色授权/);
  await assert.rejects(authorize({ workspaces: [{ path: write, write: true }] }), /附加目录写入/);
  await assert.rejects(authorize({ terminal: true }), /终端执行/);
  await assert.rejects(authorize({ toolPermissions: ['mail.write'] }), /工具权限超出/);
  await assert.rejects(authorize({ timeoutMinutes: 31 }), /时限超过/);
  await assert.rejects(authorize({ fullAccess: true }), /未授权委派本机完全访问/);
  const full = await authorizeExecution(app.store, 'fixture', 'main', { ...policy, allowFullAccess: true }, {
    fullAccess: true, projectDirectory: outside,
  });
  assert.equal(full.fullAccess, true);
  assert.equal(full.write, true);
  const approved = await authorize({
    profileId: 'other',
    projectDirectory: write,
    write: true,
    terminal: true,
    toolPermissions: ['memory.write'],
    timeoutMinutes: 30,
  });
  assert.equal(approved.projectDirectory, write);
  assert.equal(approved.terminal, true);
  assert.deepEqual(approved.toolPermissions, ['memory.write']);
  await assert.rejects(
    authorizeExecution(
      app.store,
      'fixture',
      'main',
      { ...policy, approvals: 'deny' },
      { projectDirectory: write, write: true },
    ),
    /不能创建写入任务/,
  );
});

test('opt-in main reviewer settles a bounded worker edit and records the decision', async (t) => {
  const app = await setup(t);
  const root = await temporary(t);
  const file = join(root, 'sample.txt');
  const outside = join(await temporary(t), 'outside.txt');
  let reviewed = 0;
  app.router.useConversationRuntime(app.api, {
    kind: 'pi',
    async generate(request) {
      if (request.toolPolicy === 'none') {
        reviewed++;
        assert.match(request.messages[0].text, /审核当前子任务/);
        return { text: 'ALLOW' };
      }
      assert.equal(request.permissions?.pi.projectWrite, true);
      const result = await request.onInteraction?.({ kind: 'approval', title: 'Fixture edit',
        workspaceWrite: { path: file, operation: 'edit' } }, request.signal);
      assert.equal(result?.decision, 'allow');
      const outsideResult = await request.onInteraction?.({ kind: 'approval', title: 'Out of scope',
        workspaceWrite: { path: outside, operation: 'edit' } }, request.signal);
      assert.equal(outsideResult?.decision, 'deny');
      return { text: 'Completed' };
    },
  });
  const call = (name: string, value: any) => app.registry.call(name, value, internal);
  const role = await call('persona.character.commit', {
    requestId: 'reviewer-role',
    draft: characterDraft.parse({ persona: { id: 'reviewer', name: 'Reviewer', prompt: 'Synthetic' },
      profileId: 'test', features: ['delegation'], configurations: { delegation: {
        authorizationVersion: 3, approvalReviewer: 'main', workspaces: [{ path: root, write: true }],
        reportOnCompletion: false,
      } },
    }),
  });
  const task = await call('delegation.request', { requestId: 'reviewer-task', conversationId: role.mainConversationId,
    goal: 'Edit fixture', acceptance: 'Finish scoped edit', execution: { projectDirectory: root, write: true } });
  await until(() => app.router.interactions.list(task.workerConversationId).length === 1);
  const pending = app.router.interactions.list(task.workerConversationId)[0];
  assert(pending.kind === 'approval');
  assert.equal(pending.title, 'Out of scope');
  app.router.interactions.answer(task.workerConversationId, pending.id, { decision: 'deny' });
  await until(() => app.store.document<any>('delegated-tasks', task.id)?.state === 'completed');
  assert.equal(reviewed, 1);
  const rows = await call('delegation.list', { personaId: 'reviewer' });
  assert.equal(rows.find((row: any) => row.id === task.id).approvalReviews[0].path, file);
  assert.equal(app.router.interactions.list(task.workerConversationId).length, 0);
});

test('independent subtasks snapshot their own instructions and tools without reusable profiles', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const call = (name: string, value: any) => app.registry.call(name, value, internal);
  app.store.set('mcp.permissions', ['memory.read', 'memory.write']);
  const role = await call('persona.character.commit', {
    requestId: 'new-policy',
    draft: characterDraft.parse({
      persona: { id: 'parent', name: 'Fixture', prompt: 'Synthetic' },
      profileId: 'test',
      features: ['memory', 'delegation'],
      toolPermissions: ['memory.read', 'memory.write'],
      configurations: {
        delegation: {
          authorizationVersion: 3,
          toolPermissions: ['memory.read', 'memory.write'],
          reportOnCompletion: false,
        },
      },
    }),
  });
  const create = async (id: string, tools: string[]) => {
    const task = await call('delegation.request', {
      requestId: id.replaceAll(' ', '-'),
      conversationId: role.mainConversationId,
      goal: id,
      acceptance: 'Return evidence',
      execution: { toolPermissions: tools, prompt: id },
    });
    await until(() => app.store.document<any>('delegated-tasks', task.id)?.state === 'completed');
    return task;
  };
  const first = await create('Read-only instructions', ['memory.read']);
  const second = await create('No-tool instructions', []);
  assert.notEqual(first.workerConversationId, second.workerConversationId);
  assert.equal(first.template.prompt, 'Read-only instructions');
  assert.equal(second.template.prompt, 'No-tool instructions');
  for (const [task, expected] of [
    [first, ['memory.read']],
    [second, []],
  ] as const) {
    const principal = { personaId: 'parent', conversationId: task.workerConversationId };
    assert.deepEqual(
      [
        ...echoToolPermissions(
          app.store,
          false,
          principal,
          new Set(['memory.read', 'memory.write']),
        ),
      ],
      expected,
    );
  }
  assert.equal(
    (await call('persona.character.read', { id: 'parent' })).configurations.delegation.templates,
    undefined,
  );
});
