import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FakeBackend, until, submitFixtureReplies } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { echoToolPermissions } from '../packages/kernel/tool-access.ts';
import { contextPoint } from '../packages/kernel/context.ts';
import { deliveryPoint } from '../packages/contracts/delivery.ts';
import { localDay } from '../packages/kernel/time.ts';

async function role(app: Awaited<ReturnType<typeof setup>>) {
  const result = await app.registry.call('persona.character.commit', { requestId: 'work-role', draft: characterDraft.parse({
    persona: { id: 'work-role', name: 'Fixture', prompt: 'ROLE_SENTINEL' }, profileId: 'test',
    features: ['memory', 'review', 'delegation'], independentToolGrants: true,
    toolPermissions: ['memory.read', 'memory.write', 'delegation.read', 'delegation.write'],
    compaction: { triggerTokens: 1024, keepRecentPercent: 50 },
    configurations: { delegation: { authorizationVersion: 3, reportOnCompletion: false,
      toolPermissions: ['memory.read', 'memory.write'], approvals: 'deny' } },
  }) }, internal);
  return { ...result, id: 'work-role' };
}

test('workers inherit persona and core memory, keep recall off, and support registered context selection', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  await app.memories.save({ personaId: parent.id, title: 'Core', text: 'CORE_SENTINEL', core: true, tags: [], sources: [] }, true);
  await app.memories.save({ personaId: parent.id, title: 'pet name', text: 'RECALL_SENTINEL kitten', core: false, tags: [], sources: [] });
  const create = async (name: string, contextBlocks?: string[]) => {
    const task = await app.registry.call('delegation.request', { conversationId: parent.mainConversationId,
      requestId: name, goal: 'kitten task', acceptance: 'Evidence', execution: { contextBlocks } }, internal);
    await until(() => app.store.document<any>('delegated-tasks', task.id)?.state === 'completed');
    return fake.calls.find(call => call.principal?.conversationId === task.workerConversationId)!;
  };
  const normal = JSON.stringify((await create('normal')).messages);
  assert.match(normal, /ROLE_SENTINEL/); assert.match(normal, /CORE_SENTINEL/);
  assert.doesNotMatch(normal, /RECALL_SENTINEL/);
  const selected = JSON.stringify((await create('selected', ['persona.profile'])).messages);
  assert.match(selected, /ROLE_SENTINEL/); assert.doesNotMatch(selected, /CORE_SENTINEL/);
  const recall = JSON.stringify((await create('recall', ['persona.profile', 'memory.core', 'memory.recall'])).messages);
  assert.match(recall, /RECALL_SENTINEL/);
  const options = await app.router.workerContextOptions(parent.id);
  assert.equal(options.find(option => option.id === 'memory.recall')?.default, false);
});

test('task results enter canonical history without waking and are available to the next user turn', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  const result = { id: 'result-once', conversationId: parent.mainConversationId,
    text: 'BACKGROUND_RESULT', source: 'review' as const, task: 'Fixture review', report: false };
  await app.router.taskResults.submit(result); await app.router.taskResults.submit(result);
  assert.equal(fake.calls.length, 0);
  assert.equal(app.store.allMessages(parent.mainConversationId).filter(message => message.text.includes('BACKGROUND_RESULT')).length, 1);
  const run = await app.router.send({ conversationId: parent.mainConversationId, requestId: 'ask-result', text: 'What happened?' });
  assert.equal(run.state, 'succeeded', run.error ?? 'Run failed');
  assert.match(JSON.stringify(fake.calls.at(-1)!.messages), /BACKGROUND_RESULT/);
});

test('agent Review reads sources, applies versioned memory tools, proposes core approval, and reports through the parent once', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  await app.plugins.enable('approvals');
  app.router.backends.set('api', fake);
  const memory = await app.memories.save({ personaId: parent.id, title: 'Existing', text: 'OLD_BODY', core: false, tags: [], sources: [] });
  app.store.append(parent.mainConversationId, 'user', 'human', 'New facts for the review.');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'agent-review', settings: {
    name: 'Fixture review', personaId: parent.id, enabled: false, autoApply: true,
    reportConversationId: parent.mainConversationId, conversationScope: 'selected', conversationIds: [parent.mainConversationId],
    sourceIds: [], targetIds: [], memoryOperations: ['update', 'propose-core'], report: true, outputTargets: ['core.chat'],
  } }, internal);
  fake.responder = async request => {
    if (request.principal?.conversationId === parent.mainConversationId) return submitFixtureReplies(request, 'Parent report');
    const job = app.reviews.jobs().find(job => job.workerConversationId === request.principal?.conversationId)!;
    assert(job);
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: echoToolPermissions(app.store, false,
      request.principal, app.plugins.characterPermissions()) };
    const call = (name: string, value: any) => app.registry.call(name, value, caller);
    while (app.reviews.jobs().find(row => row.id === job.id)!.nextPacket < job.packets.length)
      { const packet = await call('review.readMaterial', { jobId: job.id }) as any;
        await call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] }); }
    const sources = job.packets[0].sources;
    await call('memory.read', { id: memory.id });
    const memories = await call('memory.list', {});
    assert(memories.some((row: any) => row.id === memory.id && row.version === memory.version));
    await call('memory.change', { requestId: 'review-update', change: {
      operation: 'update', subjectId: memory.id, expectedVersion: memory.version,
      title: 'Existing', text: 'NEW_BODY', sources,
    } });
    const proposed = await call('memory.change', { requestId: 'review-core', change: {
      operation: 'propose-core', coreOperation: 'add', title: 'Core proposal', text: 'PENDING_CORE', sources,
    } });
    assert.equal(proposed.state, 'pending-approval');
    await call('review.finish', { jobId: job.id, report: 'Updated an ordinary memory; one core proposal awaits confirmation.', notes: 'Read all material.' });
    return { text: 'Work finished' };
  };
  const job = await app.reviews.start(parent.id, 'agent-review-test');
  await until(() => app.reviews.jobs().find(row => row.id === job.id)?.state === 'completed');
  await until(() => fake.calls.some(call => call.principal?.conversationId === parent.mainConversationId));
  assert.equal(app.store.document<any>('memories', memory.id)?.text, 'NEW_BODY');
  assert.equal(app.store.document<any>('approvals', 'review-core')?.state, 'pending');
  assert(!app.store.documents<any>('memories').some(row => row.text === 'PENDING_CORE'));
  assert(app.router.workSessions.list(parent.id).some(row => row.origin.type === 'review.policies'));
  await app.reviews.execute(job.id);
  assert.equal(fake.calls.filter(call => call.principal?.conversationId === parent.mainConversationId).length, 1);
  app.reviews.saveTask('agent-review', { ...app.reviews.tasks().find(task => task.id === 'agent-review')!, memoryOperations: [] });
  const approval = app.store.document<any>('approvals', 'review-core');
  const decided = await app.registry.call('approvals.decide', { id: approval.id, revision: approval.revision,
    decision: 'approve', confirmed: true }, { kind: 'ui', permissions: new Set(['*']) });
  assert.equal(decided.state, 'failed');
  assert(!app.store.documents<any>('memories').some(row => row.text === 'PENDING_CORE'));
});

for (const report of [false, true]) test(`failed Review preserves confirmed changes and ${report ? 'hands off' : 'records'} one result per attempt`, async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  await app.plugins.enable('notifications');
  app.router.backends.set('api', fake);
  app.store.append(parent.mainConversationId, 'user', 'human', 'A supported new memory.');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'failure-review', settings: {
    name: 'Fixture failed review', personaId: parent.id, enabled: true, mode: 'daily', hour: 0, minute: 0,
    reportConversationId: parent.mainConversationId, conversationScope: 'selected', conversationIds: [parent.mainConversationId],
    sourceIds: [], targetIds: [], autoApply: true, memoryOperations: ['add'], report, outputTargets: ['core.chat', 'notifications.inbox'],
  } }, internal);
  let fail = true;
  fake.responder = async request => {
    if (request.principal?.conversationId === parent.mainConversationId) {
      assert.deepEqual([...(request.replyTargets ?? [])].sort(), ['core.chat', 'notifications.inbox']);
      return submitFixtureReplies(request, 'Fixture report');
    }
    const job = app.reviews.jobs().find(row => row.workerConversationId === request.principal?.conversationId)!;
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: echoToolPermissions(app.store, false,
      request.principal, app.plugins.characterPermissions()) };
    const call = (name: string, value: any) => app.registry.call(name, value, caller);
    while (app.reviews.jobs().find(row => row.id === job.id)!.nextPacket < job.packets.length)
      { const packet = await call('review.readMaterial', { jobId: job.id }) as any;
        await call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] }); }
    if (fail) {
      await call('memory.change', { requestId: 'confirmed-before-failure', change: {
        operation: 'add', title: 'Supported fact', text: 'CONFIRMED_MEMORY', sources: job.packets[0].sources,
      } });
      throw Error('Fixture API error (504): timeout\n<html>UPSTREAM_ERROR_PAGE</html>');
    }
    await call('review.finish', { jobId: job.id, report: 'Finished after explicit resume.', notes: '' });
    return { text: 'Finished' };
  };
  const now = new Date(), day = localDay(now, 'Asia/Shanghai');
  const job = await app.reviews.start(parent.id, 'daily-' + day);
  await until(() => app.reviews.jobs().find(row => row.id === job.id)?.state === 'paused');
  await until(() => app.store.allMessages(parent.mainConversationId).some(message =>
    message.source === 'review' && message.text.includes('记忆整理中断')));
  await app.reviews.tick(now); await app.reviews.tick(now);
  const records = app.store.allMessages(parent.mainConversationId).filter(message =>
    message.source === 'review' && !message.meta?.presentationOnly && message.text.includes('记忆整理中断'));
  assert.equal(records.length, 1); assert.equal(records[0].role, 'system');
  assert.match(records[0].text, /504/); assert.doesNotMatch(records[0].text, /UPSTREAM_ERROR_PAGE/);
  assert.match(records[0].text, /新增 1 条/);
  assert.equal(fake.calls.filter(call => call.principal?.conversationId === parent.mainConversationId).length, report ? 1 : 0);
  if (report) await until(() => app.deliveries.rows().filter(row => row.state === 'delivered').length === 2);
  else assert.equal(app.deliveries.rows().length, 0);
  assert.equal(app.store.documents<any>('memories').filter(row => row.text === 'CONFIRMED_MEMORY').length, 1);
  assert.equal(app.reviews.jobs().find(row => row.id === job.id)?.agentFinished, undefined);
  fail = false;
  await app.reviews.execute(job.id);
  await until(() => app.reviews.jobs().find(row => row.id === job.id)?.state === 'completed');
  if (report) await until(() => fake.calls.filter(call => call.principal?.conversationId === parent.mainConversationId).length === 2);
  assert.equal(app.store.documents<any>('memories').filter(row => row.text === 'CONFIRMED_MEMORY').length, 1);
  await app.reviews.tick(now);
  assert.equal(fake.calls.filter(call => call.principal?.conversationId === parent.mainConversationId).length, report ? 2 : 0);
});

test('general prompt automations reuse a worker, retain history and keep no-report runs silent', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  await app.registry.call('automation.save', { type: 'delegation.automations', id: 'general-task', settings: {
    name: 'Fixture automation', personaId: parent.id, prompt: 'Do the fixture work.', enabled: false,
    mode: 'interval', minutes: 60, report: false, execution: { toolPermissions: ['memory.read'] },
  } }, internal);
  await app.registry.call('automation.run', { type: 'delegation.automations', id: 'general-task', requestId: 'first-run' }, internal);
  await app.registry.call('automation.run', { type: 'delegation.automations', id: 'general-task', requestId: 'second-run' }, internal);
  const work = app.router.workSessions.list(parent.id).find(row => row.origin.id === 'general-task')!;
  assert(work);
  assert.equal(fake.calls.length, 2);
  assert(fake.calls.every(call => call.principal?.conversationId === work.conversationId));
  assert(fake.calls[1].messages.some(message => message.role === 'assistant'));
  assert.equal(app.store.allMessages(parent.mainConversationId).filter(message => message.meta.taskResultId).length, 2);
});

test('worker context options follow plugin registration and unload without changing saved choices', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  app.plugins.add({ manifest: { id: 'work-fixture', name: 'Work fixture', version: '1', description: 'Synthetic context',
    dependencies: [], permissions: ['context.contribute'], settings: [] }, activate(ctx) {
    ctx.capabilities.provide(contextPoint.id, 'work-fixture.context', 'Fixture context', (input: any) =>
      input.action === 'describe' ? [{ id: 'work-fixture.extra', label: 'Fixture extra', layer: 'stable', worker: 'optional' }] :
        { 'work-fixture.extra': [{ text: 'OPTIONAL_WORK_CONTEXT' }] });
  } });
  await app.plugins.enable('work-fixture');
  app.store.put('characters', parent.id, { ...app.store.document<any>('characters', parent.id),
    features: ['memory', 'review', 'delegation', 'work-fixture'] });
  const work = app.router.workSessions.register({ id: 'plugin-context', personaId: parent.id,
    parentConversationId: parent.mainConversationId, title: 'Fixture', origin: { owner: 'delegation', type: 'fixture', id: 'context', name: 'Fixture' },
    contextBlocks: ['persona.profile', 'work-fixture.extra'] });
  assert((await app.router.workerContextOptions(parent.id)).some(option => option.id === 'work-fixture.extra'));
  await app.router.workSessions.run({ id: work.id, requestId: 'extra-on', profileId: 'test', text: 'Inspect' }, new AbortController().signal);
  assert.match(JSON.stringify(fake.calls.at(-1)!.messages), /OPTIONAL_WORK_CONTEXT/);
  await app.plugins.disable('work-fixture');
  await app.router.workSessions.run({ id: work.id, requestId: 'extra-off', profileId: 'test', text: 'Inspect again' }, new AbortController().signal);
  assert.doesNotMatch(JSON.stringify(fake.calls.at(-1)!.messages), /OPTIONAL_WORK_CONTEXT/);
  assert(app.store.conversation(work.conversationId)!.contextBlocks!.includes('work-fixture.extra'));
});

test('automation workers compact inherited context and revoked grants cannot remain active', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.useConversationRuntime(app.api, { kind: 'pi', generate: request => fake.generate(request) });
  const work = app.router.workSessions.register({ id: 'compact-worker', personaId: parent.id,
    parentConversationId: parent.mainConversationId, title: 'Fixture', origin: { owner: 'review', type: 'fixture', id: 'compact', name: 'Fixture' },
    permissions: { echoTools: ['memory.read'], projectDirectory: '', codex: { sandbox: 'read-only', approvals: 'deny' },
      dsh: { approvals: 'deny' }, pi: { tools: 'none', projectWrite: false, echoTools: 'granted' } } });
  for (let i = 0; i < 5; i++) {
    app.store.append(work.conversationId, 'user', 'delegation', 'OLD_TASK '.repeat(90), 'old-' + i);
    app.store.append(work.conversationId, 'assistant', 'delegation', 'OLD_RESULT '.repeat(90), 'old-' + i);
  }
  fake.responder = async request => {
    if (request.toolPolicy === 'none') return { text: 'WORK_HISTORY_SUMMARY' };
    assert(echoToolPermissions(app.store, false, request.principal, app.plugins.characterPermissions()).has('memory.read'));
    return { text: 'Work completed' };
  };
  const run = await app.router.workSessions.run({ id: work.id, requestId: 'compact-worker', profileId: 'test', text: 'Continue',
    authority: { owner: 'review', taskType: 'fixture', taskId: 'compact', permissions: ['memory.read'] } }, new AbortController().signal);
  assert.equal(run.state, 'succeeded', run.error ?? 'Worker failed');
  assert(fake.calls.some(call => call.toolPolicy === 'none'));
  assert.match(JSON.stringify(fake.calls.at(-1)!.messages), /WORK_HISTORY_SUMMARY/);
  assert.equal(fake.calls.at(-1)!.compaction?.triggerTokens, 1024);
  assert.equal(echoToolPermissions(app.store, false, { personaId: parent.id, conversationId: work.conversationId },
    app.plugins.characterPermissions()).size, 0);
});

test('task result retries are concurrent-safe and freeze their reporting instruction', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  const input = { id: 'race-result', conversationId: parent.mainConversationId,
    source: 'review' as const, task: 'Fixture', report: false, text: 'CANONICAL_RESULT' };
  await Promise.all([app.router.taskResults.submit(input), app.router.taskResults.submit(input)]);
  assert.equal(app.store.allMessages(parent.mainConversationId).filter(row => row.meta.taskResultId === input.id).length, 1);
  await assert.rejects(app.router.taskResults.submit({ ...input, text: 'CHANGED_RESULT' }), /内容或处理方式/);
  const delivery = await app.deliveries.plan(parent.mainConversationId, 'handoff', ['core.chat']);
  const report = { ...input, id: 'report-result', report: true, delivery, reportPrompt: 'ORIGINAL_REPORT_PROMPT' };
  await app.router.taskResults.submit(report);
  await app.router.taskResults.submit({ ...report, reportPrompt: 'CHANGED_REPORT_PROMPT' });
  assert.equal(fake.calls.length, 1);
  assert.match(JSON.stringify(fake.calls[0].messages), /ORIGINAL_REPORT_PROMPT/);
  assert.doesNotMatch(JSON.stringify(fake.calls[0].messages), /CHANGED_REPORT_PROMPT/);
});

test('new Review freezes destinations before worker execution and does not redirect reports', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  let revision = 'one', sends = 0;
  app.plugins.add({ manifest: { id: 'work-output', name: 'Fixture output', description: 'Synthetic', version: '1',
    dependencies: [], permissions: ['outputs.provide'], settings: [] }, activate(ctx) {
    ctx.capabilities.provide(deliveryPoint, 'work-output.outputs', 'Fixture output', (input: any) => {
      if (input.action === 'list') return { targets: [{ id: 'work-output.target', label: 'Fixture', revision }] };
      sends++; return { result: { state: 'delivered' } };
    });
  } });
  await app.plugins.enable('work-output');
  app.store.append(parent.mainConversationId, 'user', 'human', 'Review this material');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'frozen-review', settings: {
    name: 'Frozen review', personaId: parent.id, enabled: false, sourceIds: [], targetIds: [],
    autoApply: true, memoryOperations: [], outputTargets: ['work-output.target'], report: true,
  } }, internal);
  fake.responder = async request => {
    if (request.principal?.conversationId === parent.mainConversationId) return submitFixtureReplies(request, 'Report');
    revision = 'two';
    const job = app.reviews.jobs().find(job => job.workerConversationId === request.principal?.conversationId)!;
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: new Set(['review.read', 'review.write']) };
    while (app.reviews.jobs().find(row => row.id === job.id)!.nextPacket < job.packets.length)
      { const packet = await app.registry.call('review.readMaterial', { jobId: job.id }, caller) as any;
        await app.registry.call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] }, caller); }
    await app.registry.call('review.finish', { jobId: job.id, report: 'Read everything.', notes: 'Done' }, caller);
    return { text: 'Done' };
  };
  const job = await app.reviews.start(parent.id, 'frozen-v2');
  await until(() => app.reviews.jobs().find(row => row.id === job.id)?.state === 'completed');
  await until(() => app.deliveries.rows().some(row => row.state === 'skipped'));
  assert.equal(sends, 0);
});

test('Review tool grants enforce complete reading, operation scope and source identity', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  const existing = await app.memories.save({ personaId: parent.id, title: 'Fixture', text: 'Keep', core: false, tags: [], sources: [] });
  app.store.append(parent.mainConversationId, 'user', 'human', 'New information.');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'scoped-review', settings: {
    name: 'Scoped review', personaId: parent.id, enabled: false, sourceIds: [], targetIds: [], autoApply: true,
    report: false, memoryOperations: ['add'],
  } }, internal);
  fake.responder = async request => {
    const job = app.reviews.jobs().find(job => job.workerConversationId === request.principal?.conversationId)!;
    assert.equal(request.permissions?.pi.projectWrite, false);
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: new Set(['review.read', 'review.write', 'memory.write']) };
    const add = { requestId: 'scoped-add', change: { operation: 'add', title: 'New', text: 'Fact', sources: job.packets[0].sources } };
    await assert.rejects(app.registry.call('memory.change', add, caller), /完整阅读/);
    while (app.reviews.jobs().find(row => row.id === job.id)!.nextPacket < job.packets.length)
      { const packet = await app.registry.call('review.readMaterial', { jobId: job.id }, caller) as any;
        await app.registry.call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] }, caller); }
    await assert.rejects(app.registry.call('memory.change', { requestId: 'wrong-source', change: { ...add.change, sources: ['foreign-source'] } }, caller), /来源编号/);
    await assert.rejects(app.registry.call('memory.change', { requestId: 'wrong-operation', change: {
      operation: 'delete', subjectId: existing.id, expectedVersion: existing.version, title: existing.title, text: existing.text, sources: job.packets[0].sources,
    } }, caller), /未获准/);
    await app.registry.call('memory.change', add, caller);
    await app.registry.call('review.finish', { jobId: job.id, report: 'Scoped changes complete.', notes: '' }, caller);
    return { text: 'Done' };
  };
  const job = await app.reviews.start(parent.id, 'scoped-review');
  await until(() => ['completed', 'paused'].includes(app.reviews.jobs().find(row => row.id === job.id)!.state));
  const finished = app.reviews.jobs().find(row => row.id === job.id)!;
  assert.equal(finished.state, 'completed', finished.error ?? 'Scoped review failed');
  assert(app.store.document('memories', existing.id));
  assert.equal(fake.calls.length, 1);
});

test('a paused Review does not consume later materials or block the next job', async t => {
  const app = await setup(t), parent = await role(app), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  await app.registry.call('automation.save', { type: 'review.policies', id: 'periodic-review', settings: {
    name: 'Periodic review', personaId: parent.id, enabled: false, sourceIds: [], targetIds: [], autoApply: true,
    report: false, memoryOperations: [],
  } }, internal);
  app.store.append(parent.mainConversationId, 'user', 'human', 'EARLIER_DAY');
  fake.responder = async () => { throw Error('Synthetic provider failure'); };
  const first = await app.reviews.start(parent.id, 'earlier-day');
  await until(() => app.reviews.jobs().find(row => row.id === first.id)?.state === 'paused');
  app.store.append(parent.mainConversationId, 'user', 'human', 'LATER_DAY');
  fake.responder = async request => {
    const job = app.reviews.jobs().find(job => job.workerConversationId === request.principal?.conversationId && job.state === 'running')!;
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: new Set(['review.read', 'review.write']) };
    while (app.reviews.jobs().find(row => row.id === job.id)!.nextPacket < job.packets.length)
      { const packet = await app.registry.call('review.readMaterial', { jobId: job.id }, caller) as any;
        await app.registry.call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] }, caller); }
    await app.registry.call('review.finish', { jobId: job.id, report: 'Later work completed.', notes: 'LATER_NOTES' }, caller);
    return { text: 'Done' };
  };
  const second = await app.reviews.start(parent.id, 'later-day');
  await until(() => app.reviews.jobs().find(row => row.id === second.id)?.state === 'completed');
  const material = app.reviews.jobs().find(row => row.id === second.id)!.materials.map(row => row.text).join(' ');
  assert.match(material, /LATER_DAY/); assert.doesNotMatch(material, /EARLIER_DAY/);
  assert.equal(app.reviews.jobs().find(row => row.id === first.id)?.state, 'paused');
});
