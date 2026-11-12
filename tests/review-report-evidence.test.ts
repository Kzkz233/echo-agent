import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, FakeBackend, until, submitFixtureReplies } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';

test('Review hands registered target acknowledgements to the parent separately from unverified model claims', async t => {
  const app = await setup(t), fake = new FakeBackend();
  await app.plugins.enable('notifications');
  app.router.backends.set('api', fake);
  const role = await app.registry.call('persona.character.commit', { requestId: 'role', draft: characterDraft.parse({
    persona: { id: 'fixture', name: 'Fixture', prompt: 'Synthetic persona' }, profileId: 'test', features: ['memory', 'review'],
  }) }, internal);
  let applied = 0;
  app.plugins.add({ manifest: { id: 'fixture-target', name: 'Fixture target', description: 'Synthetic', version: '1',
    dependencies: ['review'], permissions: ['review.contribute'], settings: [] }, activate(ctx) {
    ctx.capabilities.provide('review.targets@1', 'fixture-target.state', 'Fixture', (input: any) => {
      if (input.action === 'describe') return { context: 'No existing records', instructions: 'Can add a record.' };
      assert.deepEqual(input.proposals.map((p: any) => p.operation), ['add']);
      applied++;
      return { applied: 1 };
    });
  } });
  await app.plugins.enable('fixture-target');
  app.store.append(role.mainConversationId, 'user', 'human', 'Synthetic material');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'review', settings: {
    personaId: 'fixture', enabled: false, report: true, autoApply: true, memoryOperations: [],
    conversationScope: 'selected', conversationIds: [role.mainConversationId], sourceIds: [],
    targetIds: ['fixture-target.state'], outputTargets: ['core.chat', 'notifications.inbox'],
  } }, internal);
  fake.responder = async request => {
    if (request.principal?.conversationId === role.mainConversationId) return submitFixtureReplies(request, 'Report');
    const job = app.reviews.jobs()[0];
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: new Set(['review.read', 'review.write']) };
    const call = (name: string, value: unknown) => app.registry.call(name, value, caller);
    while (app.reviews.jobs()[0].nextPacket < job.packets.length) {
      const packet = await call('review.readMaterial', { jobId: job.id }) as any;
      await call('review.checkpoint', { jobId: job.id, packetIndex: packet.index, candidates: [] });
    }
    await assert.rejects(call('review.stageAction', { jobId: job.id, action: {
      target: 'fixture-target.state', operation: 'forget', text: 'Invalid deletion', sources: job.packets[0].sources,
    } }));
    await call('review.stageAction', { jobId: job.id, action: {
      target: 'fixture-target.state', operation: 'add', title: 'Record', text: 'Added', sources: job.packets[0].sources,
    } });
    await call('review.finish', { jobId: job.id, report: 'UNVERIFIED_CLAIM: also deleted an old record.' });
    return { text: 'Done' };
  };
  const job = await app.reviews.start('fixture', 'evidence');
  await until(() => app.reviews.jobs()[0].state === 'completed');
  await until(() => fake.calls.some(call => call.principal?.conversationId === role.mainConversationId));
  const report = app.store.document<any>('review-reports', 'review-report.' + job.id + '.completed');
  assert(report.text.includes('执行结果以以下程序回执为准'));
  assert(report.text.includes('通过校验并交付的操作类型 add'));
  assert(report.text.includes('插件确认生效 1 次'));
  assert(report.text.indexOf('不是执行凭证') < report.text.indexOf('UNVERIFIED_CLAIM'));
  assert(!report.text.includes('操作类型 forget'));
  assert.equal(applied, 1);
  await app.reviews.execute(job.id);
  assert.equal(applied, 1);
  assert.equal(app.store.documents('review-target-results.' + job.id).length, 1);
  await app.registry.call('review.verifyReport', { id: job.id, confirmed: true }, internal);
  await app.registry.call('review.verifyReport', { id: job.id, confirmed: true }, internal);
  await until(() => fake.calls.filter(call => call.principal?.conversationId === role.mainConversationId).length === 2);
  const verification = app.store.document<any>('review-reports', 'review-report.' + job.id + '.verified');
  assert(!verification.text.includes('UNVERIFIED_CLAIM'));
  assert(verification.text.includes('不是再次整理'));
  assert(verification.text.includes('fixture-target.state: add'));
  assert(!verification.text.includes('fixture-target.state: forget'));
  assert.equal(applied, 1);
  assert.equal(fake.calls.filter(call => call.principal?.conversationId !== role.mainConversationId).length, 1);
  await assert.rejects(app.registry.call('review.verifyReport', { id: job.id, confirmed: true, targetIds: ['unconfigured'] }, internal), /原已授权/);
  await assert.rejects(app.registry.call('review.verifyReport', { id: job.id, confirmed: true, targetIds: [] }, internal), /原已授权/);
  await app.registry.call('review.verifyReport', { id: job.id, confirmed: true, targetIds: ['notifications.inbox'] }, internal);
  await app.registry.call('review.verifyReport', { id: job.id, confirmed: true, targetIds: ['notifications.inbox'] }, internal);
  await until(() => fake.calls.filter(call => call.principal?.conversationId === role.mainConversationId).length === 3);
  assert.deepEqual(fake.calls.filter(call => call.principal?.conversationId === role.mainConversationId).at(-1)?.replyTargets, ['notifications.inbox']);
  assert.equal(applied, 1);
  assert.equal(fake.calls.filter(call => call.principal?.conversationId !== role.mainConversationId).length, 1);
});
