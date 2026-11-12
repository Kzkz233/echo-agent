import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';

test('pending candidate cursor does not skip rows when earlier candidates are resolved', async t => {
  const app = await setup(t), main = conversation(app, { kind: 'main', review: true }), fake = new FakeBackend();
  app.router.backends.set('api', fake);
  app.store.append(main.id, 'user', 'human', 'Synthetic material');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'cursor-review', settings: {
    personaId: main.personaId, enabled: false, autoApply: false, report: false, memoryOperations: [], sourceIds: [], targetIds: [],
  } }, internal);
  fake.responder = async request => {
    const job = app.reviews.jobs().find(job => job.state === 'running')!;
    const caller = { kind: 'mcp' as const, ...request.principal!, permissions: new Set(['review.read', 'review.write']) };
    const call = (name: string, input: any) => app.registry.call(name, input, caller) as Promise<any>;
    const packet = await call('review.readMaterial', { jobId: job.id });
    await call('review.checkpoint', { jobId: job.id, packetIndex: 0, candidates: [0, 1, 2].map(index => ({
      title: 'Candidate ' + index, text: 'Synthetic candidate', sources: packet.sources })) });
    let after: string | undefined;
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const page = await call('review.candidates', { jobId: job.id, limit: 1, after });
      assert.equal(page.items.length, 1);
      const row = page.items[0]; ids.add(row.id);
      await call('review.resolveCandidate', { jobId: job.id, id: row.id, state: 'unchanged', reason: 'No durable change.' });
      after = page.nextAfter;
    }
    assert.equal(ids.size, 3);
    assert.equal((await call('review.candidates', { jobId: job.id })).total, 0);
    await call('review.finish', { jobId: job.id, report: 'Checked all candidates' });
    return { text: 'Done' };
  };
  const job = await app.reviews.start(main.personaId, 'cursor');
  await until(() => ['completed', 'paused'].includes(app.reviews.jobs().find(row => row.id === job.id)!.state));
  assert.equal(app.reviews.jobs().find(row => row.id === job.id)!.state, 'completed', app.reviews.jobs()[0].error ?? 'Review failed');
});
