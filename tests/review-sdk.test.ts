import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup, until } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile } from '../scripts/inference-fixture.ts';

test('actual Pi SDK checkpoints, searches, reads, updates and hands Review to two parent deliveries', async t => {
  const app = await setup(t);
  await app.plugins.enable('notifications');
  const role = await app.registry.call('persona.character.commit', { requestId: 'role', draft: characterDraft.parse({
    persona: { id: 'fixture', name: 'Fixture', prompt: 'Synthetic persona' }, profileId: 'test', features: ['memory', 'review'],
  }) }, internal);
  const memory = await app.memories.save({ personaId: 'fixture', title: 'Orchid', text: 'Orchid needs weekly watering.',
    core: false, tags: [], sources: [] });
  app.store.put('character-settings.memory', 'fixture', { retrievalMethod: 'knowledge.keyword' });
  app.store.append(role.mainConversationId, 'user', 'human', 'The orchid needs watering twice a week now.');
  await app.registry.call('automation.save', { type: 'review.policies', id: 'sdk-review', settings: {
    personaId: 'fixture', enabled: false, report: true, autoApply: true, memoryOperations: ['update'],
    conversationScope: 'selected', conversationIds: [role.mainConversationId], sourceIds: [], targetIds: [],
    outputTargets: ['core.chat', 'notifications.inbox'],
  } }, internal);
  let workerSteps = 0, reports = 0;
  const toolSets: string[][] = [];
  const failedTools: string[] = [];
  let serverError: unknown;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      toolSets.push((payload.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name));
      const lastTool = payload.messages?.filter((message: any) => message.role === 'tool').at(-1);
      if (lastTool) failedTools.push(lastTool.content.slice(0, 600));
      const worker = payload.tools?.some((tool: any) => tool.function?.name === 'review_checkpoint');
      let name: string | undefined, args: any;
      const job = app.reviews.jobs()[0];
      if (worker) {
        const sources = job.packets[0].sources;
        const candidate = app.store.documents<any>('review-candidates.' + job.id)[0];
        [name, args] = [
          ['review_readMaterial', { jobId: job.id }],
          ['review_checkpoint', { jobId: job.id, packetIndex: 0, candidates: [{ title: 'Orchid', text: 'Water twice weekly.', sources }] }],
          ['review_candidates', { jobId: job.id }],
          ['memory_search', { query: 'orchid' }],
          ['memory_read', { id: memory.id }],
          ['memory_change', { requestId: 'sdk-change', change: { operation: 'update', subjectId: memory.id,
            expectedVersion: memory.version, title: 'Orchid', text: 'Orchid needs watering twice a week.', sources } }],
          ['review_resolveCandidate', { jobId: job.id, id: candidate?.id, state: 'changed', reason: 'Updated the verified fact.', receipts: ['sdk-change'] }],
          ['review_finish', { jobId: job.id, report: 'Updated one memory.', notes: 'Done' }],
          [undefined, undefined],
        ][workerSteps++] as [string | undefined, any];
      } else {
        name = 'echo_respond'; args = { targetId: reports++ ? 'notifications.inbox' : 'core.chat', phase: 'final', messages: ['Memory Review completed.'] };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant',
        ...(name ? { tool_calls: [{ index: 0, id: 'call_' + workerSteps + '_' + reports, type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] } : { content: 'Done' }) },
        finish_reason: name ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { serverError = error; res.writeHead(500); res.end('Synthetic server failed'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  seedProfile(app, profileSchema.parse({ id: 'test', name: 'Fixture', kind: 'api', model: 'synthetic',
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1` }));
  const job = await app.reviews.start('fixture', 'sdk-review-run');
  await until(() => ['completed', 'paused'].includes(app.reviews.jobs().find(row => row.id === job.id)!.state));
  assert.equal(serverError, undefined);
  assert.equal(app.reviews.jobs().find(row => row.id === job.id)!.state, 'completed', JSON.stringify({ error: app.reviews.jobs()[0].error, workerSteps, reports, failedTools }));
  await until(() => app.deliveries.rows().filter(row => row.state === 'delivered').length === 2);
  assert.equal(workerSteps, 9); assert.equal(reports, 2);
  assert.equal(app.store.document<any>('memories', memory.id).text, 'Orchid needs watering twice a week.');
  assert.equal(app.store.documents('memory-changes').length, 1);
  const history = app.store.modelMessages(app.reviews.jobs().find(row => row.id === job.id)!.workerConversationId!);
  const calls = history.flatMap(message => (message.meta.native as any)?.role === 'assistant'
    ? (message.meta.native as any).content.filter((part: any) => part.type === 'toolCall') : []);
  assert(calls.some(call => call.name === 'memory_change'));
  const results = history.filter(message => (message.meta.native as any)?.role === 'toolResult');
  assert.equal(calls.length, results.length);
  assert(!app.store.allMessages(role.mainConversationId).some(message => message.meta.native),
    'Worker traces do not become parent Review material or channel messages');
});
