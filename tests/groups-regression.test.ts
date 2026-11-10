import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoError } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { FakeBackend, setup, until } from './helpers.ts';

test('a failed group member does not block the next speaker, while an uncertain result does', async (t) => {
  const app = await setup(t);
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const call = (method: string, args: object) => app.registry.call(method, args, internal);
  for (const name of ['first', 'second']) {
    await call('persona.character.commit', {
      requestId: 'role-' + name,
      draft: { persona: { id: name, name, prompt: 'Fixture' }, profileId: 'test' },
    });
  }
  await call('groups.save', { id: 'team', name: 'Team', members: ['first', 'second'] });
  let uncertain = false;
  backend.responder = async (request) => {
    if (request.principal?.personaId === 'first') {
      throw new EchoError('fixture_timeout', 'fixture connection timed out', uncertain);
    }
    return { text: 'Second speaker responded' };
  };
  const send = (requestId: string) => call('groups.send', {
    groupId: 'team', text: 'Hello', speakers: ['first', 'second'], requestId,
  });
  const turn = (requestId: string) => app.store.document<any>('group-turns', requestId);
  await send('definite-failure');
  await until(() => turn('definite-failure')?.state === 'failed');
  assert.deepEqual(turn('definite-failure').done, ['second']);
  assert.match(turn('definite-failure').error, /first.*timed out/);
  const result = await call('groups.messages', { id: 'team' });
  assert.equal(result.busy, false);
  assert.equal(result.messages.at(-1).text, 'Second speaker responded');
  assert.equal(backend.calls.length, 2);

  uncertain = true;
  await send('uncertain-failure');
  await until(() => turn('uncertain-failure')?.state === 'unknown');
  assert.equal(backend.calls.length, 3);
  await assert.rejects(send('must-reconcile'), /核对/);
});
