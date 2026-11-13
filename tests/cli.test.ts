import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { FakeBackend, setup, submitFixtureReplies } from './helpers.ts';

const exec = promisify(execFile);

test('CLI uses the shared conversation and task state and cannot call workbench operations', async (t) => {
  const app = await setup(t);
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const call = (method: string, args: object) => app.registry.call(method, args, internal);
  const role = await call('persona.character.commit', {
    requestId: 'cli-role',
    draft: { persona: { id: 'cli-role', name: 'CLI fixture', prompt: 'Fixture' }, profileId: 'test' },
  });
  const http = await serve(app, { webRoot: app.project });
  t.after(() => http.close());
  const url = 'http://127.0.0.1:' + http.port;
  await writeFile(join(app.runtime, 'connection.json'), JSON.stringify({ url, token: http.token }));
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath,
    ['--import', 'tsx', 'apps/cli/main.ts', '--data-dir', app.runtime, '--json', ...args],
    { cwd: app.project, windowsHide: true },
  )).stdout);
  assert.equal((await cli('doctor')).backend, 'ready');
  assert.equal((await cli('roles')).find((item: { id: string }) => item.id === 'cli-role').conversationId, role.mainConversationId);
  assert(Array.isArray((await cli('tasks')).tasks));
  const reply = await cli('chat', '--role', 'cli-role', '--request-id', 'cli-message', 'Hello');
  assert.equal(reply.state, 'succeeded');
  assert.equal(reply.text, '合成回复');
  assert.equal((await cli('chat-status', 'cli-message')).runId, reply.runId);
  assert.equal(app.store.allMessages(role.mainConversationId).at(-1)?.text, reply.text);
  assert.equal(backend.calls.length, 1);
  const policy = app.reviews.policy('cli-role');
  await call('automation.save', {
    type: 'review.policies', id: policy.id, settings: { ...policy, sourceIds: [] },
  });
  backend.responder = async request => request.replyTargets?.length
    ? submitFixtureReplies(request) : { text: '{"notes":"Synthetic review","memories":[]}' };
  const review = await cli('task', 'run', 'review.policies', policy.id, '--request-id', 'cli-review', '--wait');
  assert.equal(review.state, 'completed');
  assert(app.reviews.jobs().some(job => job.personaId === 'cli-role' && job.materials.some(material => material.text.includes('Hello'))));
  assert.equal(
    (await cli('task', 'status', 'review.policies', policy.id, '--request-id', 'cli-review')).runId,
    review.runId,
  );

  const post = (method: string, headers: Record<string, string> = {}) => fetch(url + '/cli', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  });
  const token = { Authorization: 'Bearer ' + http.token };
  assert.equal((await post('doctor')).status, 401);
  assert.equal((await post('doctor', { ...token, Origin: url })).status, 403);
  const forbidden = await post('system.bootstrap', token);
  assert.equal(forbidden.status, 409);
  assert.equal((await forbidden.json() as any).error.code, 'cli_method');
});
