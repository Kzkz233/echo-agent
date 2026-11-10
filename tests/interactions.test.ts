import test from 'node:test';
import assert from 'node:assert/strict';
import { internal } from '../packages/kernel/registry.ts';
import { conversation, FakeBackend, setup, until } from './helpers.ts';
import { answerCodex } from '../packages/backends/codex-interactions.ts';
import { conversationPermissions } from '../packages/contracts/interaction.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { projectTools } from '../packages/backends/project-tools.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Codex maps decisions to native single-use grants and preserves question IDs', async () => {
  const signal = new AbortController().signal;
  const permissions = conversationPermissions.parse({ codex: { approvals: 'ask' } });
  const request = {
    profile: profileSchema.parse({ id: 'fixture', name: 'Fixture', kind: 'codex' }),
    messages: [],
    requestId: 'host',
    signal,
    permissions,
  };
  const command = 'item/commandExecution/requestApproval';
  assert.deepEqual(
    await answerCodex(request, command, { command: 'test fixture' }, undefined, signal),
    { decision: 'decline' },
  );
  const accepted = await answerCodex(
    {
      ...request,
      onInteraction: async (value) => {
        assert.equal(value.kind, 'approval');
        return { decision: 'allow' };
      },
    },
    command,
    { command: 'test fixture', availableDecisions: ['accept', 'acceptForSession', 'decline'] },
    undefined,
    signal,
  );
  assert.deepEqual(accepted, { decision: 'accept' });
  const result = await answerCodex(
    {
      ...request,
      onInteraction: async () => ({
        decision: 'answer',
        answers: [{ id: 'scope', selected: ['Fixture'] }],
      }),
    },
    'item/tool/requestUserInput',
    { questions: [{ id: 'scope', question: 'Choose', options: [{ label: 'Fixture' }] }] },
    undefined,
    signal,
  );
  assert.deepEqual(result, { answers: { scope: { answers: ['Fixture'] } } });
});

test('Pi project operations enforce relative paths, exact revisions and explicit write capability', async (t) => {
  const app = await setup(t);
  const root = join(app.runtime, 'fixture-project');
  await mkdir(root);
  const signal = new AbortController().signal;
  const readOnly = projectTools(root, false);
  assert.deepEqual(
    readOnly.map((tool) => tool.name),
    ['project_list', 'project_read'],
  );
  const tools = new Map(projectTools(root, true).map((tool) => [tool.name, tool]));
  const call = async (name: string, args: object) =>
    JSON.parse((await tools.get(name)!.execute('fixture', args, signal)).content[0].text);
  await assert.rejects(
    call('project_create', { path: '../escape.txt', text: 'escape' }),
    /相对路径/,
  );
  await call('project_create', { path: 'sample.txt', text: 'Initial fixture' });
  const current = await call('project_read', { path: 'sample.txt' });
  await call('project_replace', {
    path: 'sample.txt',
    revision: current.revision,
    before: 'Initial',
    after: 'Changed',
  });
  await assert.rejects(
    call('project_replace', {
      path: 'sample.txt',
      revision: current.revision,
      before: 'fixture',
      after: 'overwritten',
    }),
    /已变化/,
  );
  assert.equal(await readFile(join(root, 'sample.txt'), 'utf8'), 'Changed fixture');
});

test('workbench approves only its own live turn and validates structured answers', async (t) => {
  const app = await setup(t);
  const chat = conversation(app),
    other = conversation(app);
  const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
  const rpc = (name: string, args: object) => app.registry.call(name, args, ui);
  const settings = {
    id: chat.id,
    permissions: { codex: { sandbox: 'workspace-write', approvals: 'ask' }, pi: { tools: 'none' } },
  };
  await assert.rejects(
    app.registry.call('conversations.permissions', settings, internal),
    /工作台/,
  );
  await rpc('conversations.permissions', settings);
  assert.equal(app.store.conversation(chat.id)?.permissions?.pi.tools, 'none');
  assert.equal(app.store.conversation(other.id)?.permissions, undefined);
  const backend = new FakeBackend();
  const host = new AbortController();
  backend.responder = async (req) => {
    const approval = await req.onInteraction!(
      { kind: 'approval', title: 'Fictional command' },
      host.signal,
    );
    assert.equal(approval.decision, 'allow');
    const result = await req.onInteraction!(
      {
        kind: 'questions',
        questions: [
          {
            id: 'choice',
            text: 'Fictional question?',
            options: [{ label: 'Alpha' }, { label: 'Beta' }],
          },
        ],
      },
      host.signal,
    );
    assert.deepEqual(result, {
      decision: 'answer',
      answers: [{ id: 'choice', selected: ['Beta'] }],
    });
    return { text: 'Confirmed' };
  };
  app.router.backends.set('api', backend);
  const turn = app.router.send({
    conversationId: chat.id,
    requestId: 'approval-flow',
    text: 'Synthetic',
  });
  const pending = () => app.router.interactions.list(chat.id)[0];
  await until(() => pending()?.kind === 'approval');
  const approval = pending().id;
  const answer = (id: string, interactionId: string, answer: object) =>
    rpc('conversations.answer', { id, interactionId, answer });
  await assert.rejects(answer(other.id, approval, { decision: 'allow' }), /当前会话/);
  await assert.rejects(rpc('conversations.permissions', settings), /会话结束/);
  await answer(chat.id, approval, { decision: 'allow' });
  await assert.rejects(answer(chat.id, approval, { decision: 'allow' }), /已结束/);
  await until(() => pending()?.kind === 'questions');
  const question = pending().id;
  await assert.rejects(
    answer(chat.id, question, {
      decision: 'answer',
      answers: [{ id: 'choice', selected: ['Forged'] }],
    }),
    /不符合/,
  );
  await answer(chat.id, question, {
    decision: 'answer',
    answers: [{ id: 'choice', selected: ['Beta'] }],
  });
  assert.equal((await turn).state, 'succeeded');
  assert.deepEqual(await rpc('conversations.interactions', { id: chat.id }), []);

  backend.responder = async (req) => {
    const result = await req.onInteraction!(
      { kind: 'approval', title: 'Cancelled by host' },
      host.signal,
    );
    assert.equal(result.decision, 'cancel');
    return { text: 'Cancelled' };
  };
  const cancelled = app.router.send({
    conversationId: chat.id,
    requestId: 'cancel-flow',
    text: 'Synthetic',
  });
  await until(() => pending()?.kind === 'approval');
  const stale = pending().id;
  host.abort();
  await assert.rejects(answer(chat.id, stale, { decision: 'allow' }), /已结束/);
  await cancelled;
});
