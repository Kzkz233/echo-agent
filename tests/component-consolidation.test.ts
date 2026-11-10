import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,temporary,project } from './helpers.ts';
import {Application} from '../apps/server/application.ts';
import {Store} from '../packages/kernel/store.ts';
import {join} from 'node:path';
import { internal, PluginManager, Registry, defineManifest } from '../packages/kernel/registry.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { effectiveReasoning, readReasoningSupport } from '../packages/backends/model-metadata.ts';
import { thinking } from '../packages/backends/api.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';

test('optional dependencies normalize legacy manifests, load first when requested and never disable consumers', async () => {
  const manager = new PluginManager(new Registry()),
    events: string[] = [];
  manager.add({
    manifest: defineManifest({
      id: 'base',
      name: 'Base',
      description: '',
      version: '1',
      permissions: [],
    }),
    activate: () => {
      events.push('base');
    },
  });
  manager.add({
    manifest: defineManifest({
      id: 'consumer',
      name: 'Consumer',
      description: '',
      version: '1',
      enhances: ['base'],
      permissions: [],
    }),
    activate: () => {
      events.push('consumer');
    },
  });
  try {
    await manager.restore({ consumer: true, base: true });
    assert.deepEqual(events, ['base', 'consumer']);
    assert.deepEqual(manager.list().find((p) => p.id === 'consumer')?.optionalDependencies, [
      'base',
    ]);
    await manager.disable('base');
    assert(manager.active.has('consumer'));
    assert.throws(
      () =>
        manager.validateReplacement(
          defineManifest({
            id: 'base',
            name: 'Base',
            description: '',
            version: '2',
            optionalDependencies: ['consumer'],
            permissions: [],
          }),
        ),
      /循环|cycle/,
    );
  } finally {
    await manager.close();
  }
});

test('documented thinking protocols preserve MiniCPM toggles and DeepSeek effort metadata', () => {
  const mini = profileSchema.parse({
    id: 'mini',
    name: 'Mini',
    kind: 'api',
    endpoint: 'https://api.modelbest.cn/v1',
    model: 'MiniCPM-V-4.7-35B-A3B',
  });
  assert.deepEqual(effectiveReasoning(mini)?.levels, ['off', 'high']);
  assert.deepEqual(thinking(mini, 'high'), { chat_template_kwargs: { enable_thinking: true } });
  assert.deepEqual(thinking(mini, 'xhigh'), { chat_template_kwargs: { enable_thinking: true } });
  assert.deepEqual(thinking(mini, 'off'), { chat_template_kwargs: { enable_thinking: false } });
  const support = readReasoningSupport({
    owned_by: 'deepseek',
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
  });
  assert.equal(effectiveReasoning({...mini,kind:'dsh',reasoningStyle:'none'},support),support);
  const deep = {
    ...mini,
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    reasoningSupport: support,
  };
  assert.deepEqual(thinking(deep, 'off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(thinking(deep, 'max'), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'max',
  });
  assert.equal(effectiveReasoning({ ...mini, endpoint: 'https://unknown.invalid/v1' }), undefined);
});

test('calendar rescheduling moves children across DST, checks revisions, supports undo', async (t) => {
  const app = await setup(t, ['agenda']);
  app.store.set('clock.config', { timezone: 'America/New_York' });
  const parent = app.agenda.save({
    title: 'Timed',
    start: '2026-03-07T14:00:00.000Z',
    end: '2026-03-07T15:00:00.000Z',
  });
  const child = app.agenda.save({
    title: 'Child',
    date: '2026-03-07',
    dateEnd: '2026-03-08',
    parentId: parent.id,
  });
  const request = {
    id: parent.id,
    revision: parent.revision,
    date: '2026-03-09',
    requestId: 'move-fixture',
  };
  const result = await app.registry.call('agenda.reschedule', request, internal);
  assert.equal(app.store.document<any>('agenda', parent.id)?.start, '2026-03-09T13:00:00.000Z');
  assert.equal(app.store.document<any>('agenda', parent.id)?.end, '2026-03-09T14:00:00.000Z');
  assert.equal(app.store.document<any>('agenda', child.id)?.dateEnd, '2026-03-10');
  assert.deepEqual(await app.registry.call('agenda.reschedule', request, internal), result);
  await assert.rejects(
    app.registry.call('agenda.reschedule', { ...request, requestId: 'stale' }, internal),
    /变化/,
  );
  await app.registry.call(
    'agenda.undo',
    { changeId: result.id, requestId: 'undo-fixture' },
    internal,
  );
  assert.equal(app.store.document<any>('agenda', parent.id)?.start, parent.start);
  assert.deepEqual(await app.registry.call('agenda.fields', {}, internal), []);
  const current = app.store.document<any>('agenda', child.id);
  await app.registry.call(
    'agenda.reschedule',
    { id: child.id, revision: current.revision, date: '2026-03-11', requestId: 'basic' },
    internal,
  );
  assert.equal(app.store.document<any>('agenda', child.id)?.date, '2026-03-11');
});

test('agenda import preserves changed destination rows and completed history, remaps child IDs and cannot replay old reminders', async (t) => {
  const app = await setup(t, ['agenda']);
  const existing = app.agenda.save({ title: 'User edit', date: '2026-11-10', state: 'done' });
  const input = {
    source: 'fixture',
    requestId: 'import-fixture',
    items: [
      { sourceId: 'old', existingId: existing.id, item: { title: 'Old source', state: 'open' } },
      {
        sourceId: 'parent',
        item: { title: 'History', date: '2020-01-01', state: 'done', reminder: { enabled: true } },
      },
      {
        sourceId: 'child',
        item: { title: 'Child', parentId: 'parent', date: '2020-01-01', state: 'done' },
      },
    ],
  };
  const preview = await app.registry.call('agenda.import', input, internal);
  assert.equal(preview.created, 2);
  assert.equal(preview.preserved, 1);
  assert.equal(app.agenda.items().length, 1);
  const result = await app.registry.call('agenda.import', { ...input, commit: true }, internal);
  assert.deepEqual(app.store.document('agenda', existing.id), existing);
  assert.equal(
    app.store.document<any>('agenda', result.mapping.child).parentId,
    result.mapping.parent,
  );
  assert(app.agenda.items().every((item) => !item.reminder.enabled));
  await app.agenda.tick();
  assert.equal(app.store.documents('agenda-reminders').length, 0);
  await app.registry.call('agenda.import', { ...input, commit: true }, internal);
  assert.equal(app.agenda.items().length, 3);
});

test('basic knowledge and character collections require no semantic plugin and preserve owner write policies', async (t) => {
  const app = await setup(t, ['memory']);
  const saved = await app.memories.save({
    personaId: 'companion',
    title: 'Rivers',
    text: 'A quiet river',
    core: false,
    tags: [],
    sources: [],
  });
  const library = await app.registry.call(
    'knowledge.character-library',
    { personaId: 'companion' },
    internal,
  );
  assert(library.entries.some((entry: any) => entry.metadata.memory?.id === saved.id));
  const entry = library.entries.find((entry: any) => entry.metadata.memory?.id === saved.id);
  await assert.rejects(
    app.registry.call(
      'knowledge.save',
      {
        id: entry.id,
        vaultId: entry.vaultId,
        revision: entry.revision,
        title: 'Bypass',
        text: 'No',
      },
      internal,
    ),
    /所属插件|来源页面/,
  );
  assert(
    app.capabilities
      .list('knowledge.retrieval@1')
      .some((p) => p.id === 'knowledge.keyword' && p.state === 'active'),
  );
  assert.equal(app.localModels.status().loaded, 0);
});
test('portrait preparation is local, normalized, optional and portable with the character package', async (t) => {
  const app = await setup(t, []),
    sharp = (await import('sharp')).default;
  const source = await sharp({
    create: { width: 40, height: 80, channels: 4, background: '#315abc' },
  })
    .png()
    .toBuffer();
  const { portrait } = await app.registry.call(
    'persona.portrait.prepare',
    { data: source.toString('base64') },
    internal,
  );
  const meta = await sharp(Buffer.from(portrait.split(',')[1], 'base64')).metadata();
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  assert.equal(meta.format, 'webp');
  const draft = characterDraft.parse({
    persona: { id: 'portrait-fixture', name: 'Fixture', prompt: 'Original text.', portrait },
  });
  await app.registry.call(
    'persona.character.commit',
    { requestId: 'portrait-create', draft },
    internal,
  );
  const packed = await app.registry.call(
    'persona.package.export',
    { personaId: 'portrait-fixture', packageId: 'portrait-fixture', version: '1.0.0' },
    internal,
  );
  assert.equal(packed.persona.portrait, portrait);
  assert.equal(packed.persona.prompt, 'Original text.');
  const current = await app.registry.call(
    'persona.character.read',
    { id: 'portrait-fixture' },
    internal,
  );
  await app.registry.call(
    'persona.character.commit',
    {
      requestId: 'portrait-remove',
      draft: { ...current, persona: { ...current.persona, portrait: undefined } },
    },
    internal,
  );
  assert.equal(app.store.document<any>('personas', 'portrait-fixture').portrait, undefined);
  await assert.rejects(
    app.registry.call(
      'persona.portrait.prepare',
      { data: Buffer.from('<svg/>').toString('base64') },
      internal,
    ),
  );
});
test('adopting the task component preserves a previously disabled legacy worker policy',async(t)=>{
  const runtime=await temporary(t),store=new Store(join(runtime,'echo.sqlite'));
  store.set('plugins.intent',{delegation:false});store.put('personas','fixture',{id:'fixture',name:'Fixture',prompt:'Keep original'});
  store.put('character-settings.delegation','fixture',{profileId:'unconfigured',mode:'prefer',reportOnCompletion:true});store.close();
  const app=await Application.create({runtime,project});try{
    assert(app.plugins.isBuiltin('delegation'));assert.equal(app.store.document<any>('character-settings.delegation','fixture').autonomous,false);assert.equal(app.store.document<any>('character-settings.delegation','fixture').reportOnCompletion,false);
    assert.equal(app.store.document<any>('personas','fixture').prompt,'Keep original');assert.equal(app.store.unresolved().length,0);
  }finally{await app.close();}
});
