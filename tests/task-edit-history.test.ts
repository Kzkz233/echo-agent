import test from 'node:test';
import assert from 'node:assert/strict';
import { conversation, FakeBackend, setup } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { editedCharacter, taskKey } from '../plugins/persona/character-edits.ts';

test('stale role editors preserve independent tasks, disjoint edits and explicit deletion intent', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('care');
  const call = (method: string, params: object) => app.registry.call(method, params, internal);
  const base = characterDraft.parse(
    await call('persona.character.commit', {
      requestId: 'create',
      draft: {
        persona: { id: 'fixture', name: 'Fixture', prompt: 'Initial' },
        features: ['care'],
      },
    }),
  );
  const main = app.store.document<any>('characters', 'fixture').mainConversationId;
  const taskSettings = { name: 'Independent', enabled: false, conversationId: main };
  const saveTask = (id: string, name: string) =>
    call('automation.save', { type: 'care.rules', id, settings: { ...taskSettings, name } });
  await saveTask('one', 'First');
  const patch = (changes: any, requestId: string) =>
    call('persona.character.patch', { id: 'fixture', changes, requestId });
  const name = editedCharacter(
    base,
    { ...base, persona: { ...base.persona, name: 'Renamed' } },
    new Set(),
  );
  await patch(name, 'name');
  await patch(name, 'name');
  await patch(
    editedCharacter(
      base,
      { ...base, persona: { ...base.persona, prompt: 'New prompt' } },
      new Set(),
    ),
    'prompt',
  );
  await assert.rejects(
    patch(
      editedCharacter(
        base,
        { ...base, persona: { ...base.persona, name: 'Conflicting' } },
        new Set(),
      ),
      'conflict',
    ),
    /其他窗口/,
  );
  const live = characterDraft.parse(await call('persona.character.read', { id: 'fixture' }));
  assert.equal(live.persona.name, 'Renamed');
  assert.equal(live.persona.prompt, 'New prompt');
  const task = live.tasks.find((i) => i.id === 'one')!;
  assert(task);
  await saveTask('two', 'Second');
  const without = { ...live, tasks: live.tasks.filter((i) => i.id !== task.id) };
  await patch(editedCharacter(live, without, new Set()), 'omitted');
  assert(app.care.rules().some((i) => i.id === 'one'));
  await saveTask('one', 'Changed elsewhere');
  await assert.rejects(
    patch(editedCharacter(live, without, new Set([taskKey(task)])), 'remove-stale'),
    /任务配置已变化/,
  );
  const fresh = characterDraft.parse(await call('persona.character.read', { id: 'fixture' }));
  const removed = editedCharacter(fresh, { ...fresh, tasks: [] }, new Set([taskKey(task)]));
  await patch(removed, 'remove');
  await patch(removed, 'remove');
  assert(!app.care.rules().some((i) => i.id === 'one'));
  assert(app.care.rules().some((i) => i.id === 'two'));
});

test('task definitions skip instance reads and runtime status skips stream discovery', async (t) => {
  const app = await setup(t);
  const call = (name: string, type: string) => app.registry.call(name, { type }, internal);
  await app.plugins.enable('care');
  const original = app.care.rules.bind(app.care);
  let reads = 0;
  app.care.rules = () => {
    reads++;
    return original();
  };
  const defs = await call('automation.types', 'care.rules');
  assert(defs.types[0].fields.length);
  assert.equal(reads, 0);
  await call('automation.instances', 'care.rules');
  assert(reads > 0);
  let discovers = 0;
  const available = app.reviews.sources.entries;
  Object.defineProperty(app.reviews.sources, 'entries', {
    configurable: true,
    get: () => available,
  });
  const source = [...available.values()].find((s) => s.streams)!;
  const streams = source.streams!;
  source.streams = async () => {
    discovers++;
    return streams.call(source);
  };
  const state = await call('automation.instances', 'review.policies');
  assert.equal(state.unavailable.length, 0);
  assert.equal(discovers, 0);
  await call('automation.types', 'review.policies');
  assert(discovers > 0);
});

test('task history joins a specific result, parent run and channel receipt; silent records stay distinct', async (t) => {
  const app = await setup(t);
  app.router.backends.set('api', new FakeBackend());
  const chat = conversation(app);
  await app.router.bind(chat.id, 'test', new AbortController().signal);
  const context = { tasks: [{ type: 'fixture.tasks', id: 'one' }] };
  const plan = await app.deliveries.plan(chat.id, 'handoff', ['core.chat'], {
    task: context.tasks[0],
  });
  const submit = (id: string, report: boolean) =>
    app.router.taskResults.submit({
      id,
      report,
      context,
      text: 'Fixture ' + id,
      conversationId: chat.id,
      source: 'handoff',
      task: 'Fixture',
      delivery: plan,
    });
  await submit('silent', false);
  await submit('speech', true);
  await app.router.send({ conversationId: chat.id, requestId: 'unrelated', text: 'Elsewhere' });
  const read = (personaId: string) =>
    app.registry.call(
      'automation.history',
      { type: 'fixture.tasks', id: 'one', personaId },
      internal,
    );
  const page = await read(chat.personaId);
  assert.deepEqual(
    page.results.map((r: any) => [r.id, r.handoff]),
    [
      ['speech', 'succeeded'],
      ['silent', 'recorded'],
    ],
  );
  assert.equal(page.results[0].outputs.length, 1);
  assert.equal(page.results[0].outputs[0].deliveries[0].targetId, 'core.chat');
  assert.equal(page.results[1].outputs.length, 0);
  assert.deepEqual((await read('unrelated')).results, []);
});
