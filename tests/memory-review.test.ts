import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packets, localDay, type ReviewJob } from '../plugins/review/index.ts';
import { setup, conversation, FakeBackend, until } from './helpers.ts';

test('recall is scoped to persona and suppresses versions already in effective context', async (t) => {
  const app = await setup(t);
  const memory = await app.memories.save({
    personaId: 'companion',
    title: '宠物名字',
    text: '小猫名字叫团子。',
    core: false,
    tags: ['猫'],
    sources: [],
  });
  await app.memories.save({
    personaId: 'someone-else',
    title: '宠物名字',
    text: '小猫名字叫另一个。',
    core: false,
    tags: [],
    sources: [],
  });
  const first = await app.memories.recall(
    'companion',
    '小猫名字',
    [],
    new AbortController().signal,
  );
  assert.equal(first[0].memory.id, memory.id);
  const c = conversation(app);
  app.store.append(c.id, 'system', 'import', '资料', undefined, {
    memoryVersion: memory.id + ':' + memory.version,
  });
  const second = await app.memories.recall(
    'companion',
    '小猫名字',
    app.store.messages(c.id),
    new AbortController().signal,
  );
  assert.equal(second.length, 0);
  const again = await app.memories.recall(
    'companion',
    '小猫名字',
    [],
    new AbortController().signal,
  );
  assert.equal(again.length, 1);
});
test('core memory cannot be changed through ordinary save', async (t) => {
  const app = await setup(t);
  await assert.rejects(
    app.memories.save({
      personaId: 'companion',
      title: 'core',
      text: 'test',
      core: true,
      tags: [],
      sources: [],
    }),
    /确认/,
  );
  const memory = await app.memories.save(
    { personaId: 'companion', title: 'core', text: 'test', core: true, tags: [], sources: [] },
    true,
  );
  await assert.rejects(app.memories.save({ ...memory, core: false }), /确认/);
});
test('automatic injection uses same recall and does not repeat memory in next round', async (t) => {
  const app = await setup(t),
    c = conversation(app, { injection: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  await app.memories.save({
    personaId: 'companion',
    title: '团子',
    text: '小猫喜欢晒太阳',
    core: false,
    tags: [],
    sources: [],
  });
  await app.router.send({ conversationId: c.id, text: '小猫喜欢什么', requestId: 'one' });
  await app.router.send({ conversationId: c.id, text: '小猫今天也在晒太阳', requestId: 'two' });
  assert.equal(app.store.messages(c.id).filter((m) => m.meta.kind === 'memory').length, 1);
  assert.match(backend.calls[1].messages[0].text, /友善/);
});
test('one source file produces one current knowledge package', async (t) => {
  const app = await setup(t),
    source = join(app.runtime, 'source.txt');
  await writeFile(source, 'first');
  const first = await app.knowledge.import('local', source);
  await writeFile(source, 'second');
  const second = await app.knowledge.import('local', source);
  assert.equal(first.id, second.id);
  assert.equal((await app.knowledge.read(first.id)).content, 'second');
  assert.equal((await app.knowledge.list()).filter((d) => d.source === source).length, 1);
});
test('vault path traversal and absolute escape are rejected', async (t) => {
  const app = await setup(t);
  await assert.rejects(app.knowledge.path('local', '../outside.txt'), /超出/);
  await assert.rejects(app.knowledge.path('local', join(app.runtime, 'outside.txt')), /超出/);
});
test('packet splitting covers every character of long materials', () => {
  const text = Array.from({ length: 15000 }, (_, i) =>
    String.fromCharCode(0x4e00 + (i % 100)),
  ).join('');
  const result = packets(
    [{ id: 'record', text, timestamp: '2026-01-01', personaId: 'companion' }],
    2000,
  );
  assert(result.length > 7);
  assert(result.every((p) => p.text.length <= 2000));
  assert.equal(result.map((p) => p.text.replace(/\n\[record 2026-01-01\]\n/g, '')).join(''), text);
});
test('review reads full incremental inputs, skips application input copies, commits only at completion', async (t) => {
  const app = await setup(t),
    c = conversation(app, { review: true }),
    ignored = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(c.id, 'user', 'human', '今天领养了一只小猫。'.repeat(500));
  app.store.append(c.id, 'system', 'observation', 'app control must not be collected');
  app.store.append(c.id, 'assistant', 'chat', '它叫团子。');
  app.store.append(ignored.id, 'user', 'human', 'not opted in');
  let calls = 0;
  backend.responder = async (request) => {
    const value = JSON.parse(request.messages.at(-1)!.text);
    assert(!value.packet.includes('app control'));
    assert(!value.packet.includes('not opted in'));
    calls++;
    return { text: JSON.stringify({ notes: '累计笔记 ' + calls, memories: [] }) };
  };
  const job = await app.reviews.start('companion', 'daily-test');
  await until(() => app.store.document<ReviewJob>('review-jobs', job.id)?.state === 'completed');
  const completed = app.store.document<ReviewJob>('review-jobs', job.id)!;
  assert.equal(calls, completed.packets.length);
  assert.equal(completed.nextPacket, completed.packets.length);
  assert.equal((await app.reviews.collect('companion')).length, 0);
  const repeated = await app.reviews.start('companion', 'daily-test');
  assert.equal(repeated.id, job.id);
});
test('review resumes at last complete checkpoint without advancing watermarks on error', async (t) => {
  const app = await setup(t),
    c = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(c.id, 'user', 'human', 'a'.repeat(14000));
  let count = 0;
  backend.responder = async () => {
    if (++count === 2) throw Error('synthetic interruption');
    return { text: JSON.stringify({ notes: 'completed checkpoint', memories: [] }) };
  };
  const job = await app.reviews.start('companion', 'resume-test');
  await until(() => app.store.document<ReviewJob>('review-jobs', job.id)?.state === 'paused');
  assert.equal(app.store.get(`review.watermark.${c.id}`, 0), 0);
  assert.equal(app.store.document<ReviewJob>('review-jobs', job.id)!.nextPacket, 1);
  let resumed = false;
  backend.responder = async (request) => {
    if (!resumed) assert.match(request.messages.at(-1)!.text, /completed checkpoint/);
    resumed = true;
    return { text: JSON.stringify({ notes: 'resumed', memories: [] }) };
  };
  await app.reviews.execute(job.id);
  assert.equal(app.store.document<ReviewJob>('review-jobs', job.id)!.state, 'completed');
  assert.equal(await app.reviews.collect('companion').then((r) => r.length), 0);
});
test('review proposals require real packet source IDs', async (t) => {
  const app = await setup(t),
    c = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.append(c.id, 'user', 'human', 'test');
  backend.responder = async () => ({
    text: JSON.stringify({
      notes: '',
      memories: [{ title: 'made up', text: 'unfounded', sources: ['not-a-source'] }],
    }),
  });
  const job = await app.reviews.start('companion', 'bad-source');
  await until(() => app.store.document<ReviewJob>('review-jobs', job.id)?.state === 'paused');
  assert.equal(app.store.document<ReviewJob>('review-jobs', job.id)!.nextPacket, 0);
  assert.equal(app.store.documents('memories').length, 0);
});

test('Review sees an ordinary-memory comparison index and does not add an exact fact again across jobs', async (t) => {
  const app = await setup(t),
    c = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  app.store.set('review.config', { autoApply: true });
  for (const n of [1, 2]) {
    const message = app.store.append(c.id, 'user', 'human', '虚构小猫喜欢蓝色玩具。');
    backend.responder = async (request) => {
      if (n === 2) assert.match(request.messages[0].text, /已有普通记忆索引[\s\S]*蓝色玩具/);
      return {
        text: JSON.stringify({
          notes: '完整阅读。',
          memories: [{ title: '小猫玩具', text: '虚构小猫喜欢蓝色玩具。', sources: [message.id] }],
        }),
      };
    };
    const job = await app.reviews.start('companion', 'dedup-' + n);
    await until(() => app.reviews.jobs().find((j) => j.id === job.id)?.state === 'completed');
  }
  assert.equal(app.store.documents('memories').length, 1);
});

test('optional Review targets use frozen persona context, commit only after complete reading and apply idempotently', async (t) => {
  const app = await setup(t),
    c = conversation(app, { review: true }),
    backend = new FakeBackend();
  await app.plugins.enable('reflections');
  app.router.backends.set('api', backend);
  app.store.set('review.config', { targetIds: ['reflections.state'], autoApply: false });
  const message = app.store.append(c.id, 'user', 'human', '请下周问问我小猫的复诊情况。');
  backend.responder = async (request) => {
    assert.match(request.messages[0].text, /友善/);
    assert.match(request.messages[0].text, /reflections.state/);
    return {
      text: JSON.stringify({
        notes: '已完整阅读。',
        memories: [],
        actions: [
          {
            target: 'reflections.state',
            title: '小猫复诊',
            text: '下周关心小猫复诊的情况。',
            sources: [message.id],
          },
        ],
      }),
    };
  };
  const job = await app.reviews.start('companion', 'targets');
  await until(() => app.store.document<ReviewJob>('review-jobs', job.id)?.state === 'completed');
  assert.equal(app.store.documents('reflections').length, 0);
  await app.reviews.apply(app.store.document<ReviewJob>('review-jobs', job.id)!);
  await app.reviews.apply(app.store.document<ReviewJob>('review-jobs', job.id)!);
  assert.equal(app.store.documents('reflections').length, 1);
  await app.plugins.disable('reflections');
  assert(
    app.registry
      .list({ kind: 'internal', permissions: new Set(['*']) })
      .some((o) => o.name === 'review.start'),
  );
});

test('daily Review publishes one fallback and one completion report, without another inference for reporting', async (t) => {
  const app = await setup(t),
    c = conversation(app, { review: true }),
    backend = new FakeBackend();
  await app.plugins.enable('notifications');
  app.store.set('review.config', {
    enabled: true,
    mode: 'daily',
    hour: 7,
    minute: 0,
    timezone: 'Asia/Shanghai',
    fallbackMinutes: 45,
    reportConversationId: c.id,
  });
  app.router.backends.set('api', backend);
  app.store.append(c.id, 'user', 'human', '昨天的小猫复诊情况。');
  // Use a later natural day so current fixture input is eligible, without changing system time.
  const tomorrow = new Date(Date.now() + 86400000),
    day = localDay(tomorrow, 'Asia/Shanghai');
  backend.responder = async () => {
    throw Error('synthetic interruption');
  };
  await app.reviews.tick(new Date(day + 'T07:00:00+08:00'));
  await until(() => app.reviews.jobs()[0]?.state === 'paused');
  await app.reviews.tick(new Date(day + 'T07:45:00+08:00'));
  await app.reviews.tick(new Date(day + 'T07:46:00+08:00'));
  assert.equal(app.store.documents('notifications').length, 1);
  assert.equal(backend.calls.length, 1);
  backend.responder = async () => ({ text: '{"notes":"内部续跑笔记。","report":"保留复诊这个线索。","memories":[]}' });
  await app.reviews.execute(app.reviews.jobs()[0].id);
  await app.reviews.tick(new Date(day + 'T07:47:00+08:00'));
  assert.equal(app.store.documents('notifications').length, 2);
  assert.equal(backend.calls.length, 2);
  const reports = app.store.allMessages(c.id).filter((m) => m.source === 'notification');
  assert.equal(reports.length, 2);
  assert(reports.every((m) => m.role === 'system'));
  assert.match(reports[1].text, /保留复诊这个线索/);
  assert.doesNotMatch(reports[1].text, /内部续跑笔记/);
});
test('observation archives use local natural day and retain original JSONL bytes', async (t) => {
  const app = await setup(t);
  const previous = {
    id: 'old',
    personaId: 'companion',
    conversationId: 'c',
    timestamp: '2026-11-04T15:59:00.000Z',
    frameTimes: [],
    sources: ['synthetic'],
    summary: '观察原文',
    interesting: false,
  };
  const current = { ...previous, id: 'today', timestamp: '2026-11-04T16:01:00.000Z' };
  await app.observations.record(previous);
  await app.observations.record(current);
  const results = await app.observations.archiveBefore('2026-11-05');
  assert.equal(results.length, 1);
  const archived = await app.knowledge.read(results[0].id);
  assert.equal(archived.content, JSON.stringify(previous) + '\n');
  assert.equal(localDay(new Date(current.timestamp), 'Asia/Shanghai'), '2026-11-05');
  assert.equal((await app.observations.archiveBefore('2026-11-05')).length, 0);
});

test("daily Review includes this morning's received observations while leaving later material for the next run", async (t) => {
  const app = await setup(t),
    c = conversation(app, { review: true }),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  backend.responder = async () => ({
    text: '{"notes":"Read all received material","memories":[]}',
  });
  const morning = new Date(),
    day = localDay(morning, 'Asia/Shanghai'),
    now = new Date(day + 'T07:00:00+08:00');
  app.store.set('review.config', {
    enabled: true,
    mode: 'daily',
    hour: 7,
    minute: 0,
    timezone: 'Asia/Shanghai',
    sourceIds: ['fixture.source'],
  });
  app.materials.register(
    {
      id: 'fixture',
      label: 'Synthetic morning',
      read: async () => [
        {
          id: 'morning',
          personaId: c.personaId,
          timestamp: new Date(day + 'T05:00:00+08:00').toISOString(),
          text: 'Observation from the same morning',
        },
        {
          id: 'later',
          personaId: c.personaId,
          timestamp: new Date(day + 'T08:00:00+08:00').toISOString(),
          text: 'Not yet eligible',
        },
      ],
    },
    app.capabilities.forOwner(
      {
        id: 'fixture',
        permissions: new Set(['review.contribute']),
        signal: new AbortController().signal,
      },
      (dispose) => t.after(dispose),
    ),
  );
  await app.reviews.tick(now);
  await until(() => app.reviews.jobs()[0]?.state === 'completed');
  const job = app.reviews.jobs()[0];
  assert.equal(job.materials.length, 1);
  assert.equal(job.materials[0].id, 'morning');
  assert.match(backend.calls[0].messages.map((m) => m.text).join('\n'), /same morning/);
});
