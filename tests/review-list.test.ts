import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';

test('Review agents get paginated persona-scoped progress without frozen context or historical drafts', async t => {
  const app = await setup(t);
  for (let index = 0; index < 25; index++) {
    app.store.put('review-jobs', 'job-' + index, { id: 'job-' + index,
      personaId: 'companion', state: 'paused', createdAt: new Date(100000 + index).toISOString(),
      materials: [], packets: [], nextPacket: 0, applied: false, drafts: [{ text: 'PRIVATE_DRAFT' }],
      context: 'PRIVATE_FROZEN_CONTEXT'.repeat(10000), memorySnapshot: [{ text: 'PRIVATE_MEMORY' }],
      targets: [{ prompt: 'PRIVATE_TARGET' }], actions: [], notes: 'PRIVATE_NOTES',
      policy: { id: 'fixture-task', name: 'Fixture task', prompt: 'PRIVATE_POLICY' },
    });
  }
  app.store.put('review-jobs', 'other-job', { id: 'other-job', personaId: 'other',
    createdAt: new Date(200000).toISOString(), materials: [], packets: [], drafts: [] });
  const caller = { kind: 'mcp' as const, permissions: new Set(['review.read']),
    personaId: 'companion', conversationId: 'fixture-work' };
  const first = await app.registry.call('review.list', {}, caller) as any[];
  assert.equal(first.length, 20);
  assert.equal(first[0].id, 'job-24');
  assert.equal(first[0].draftCount, 1);
  assert.equal(first[0].taskName, 'Fixture task');
  assert(first.every(job => job.personaId === 'companion'));
  assert(!JSON.stringify(first).includes('PRIVATE_'));
  assert(JSON.stringify(first).length < 10000);
  const next = await app.registry.call('review.list', { offset: 20 }, caller) as any[];
  assert.equal(next.length, 5);
  assert.equal(new Set([...first, ...next].map(job => job.id)).size, 25);
  const ui = await app.registry.call('review.list', {}, { kind: 'ui', permissions: new Set(['*']) }) as any[];
  assert.equal(ui.length, 26);
  assert.equal(ui.find(job => job.id === 'job-0').drafts[0].text, 'PRIVATE_DRAFT');
});
