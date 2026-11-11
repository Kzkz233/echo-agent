import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { conversation, FakeBackend, setup, until } from './helpers.ts';
import {
  contributeMessageSource,
  messageSourcePoint,
  storedMessageContext,
} from '../packages/kernel/message-context.ts';
import {
  materializeMessage,
  messageTimestamp,
  renderMessageText,
  type MessageContext,
} from '../packages/contracts/message-context.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { ApiBackend } from '../packages/backends/api.ts';
import { PiBackend } from '../packages/backends/pi.ts';

const context: MessageContext = {
  time: '2026-11-11T11:45:21Z',
  preparedAt: '2026-11-11T11:47:05Z',
  timezone: 'Asia/Shanghai',
  sender: 'user',
  channel: 'QQ',
};

test('message headers name their fields, preserve body and distinguish message time from current time', () => {
  const input = { text: 'BODY\n[time: quoted text]', messageContext: context };
  const rendered = renderMessageText(input);
  assert.match(
    rendered,
    /^\[current_time: 2026-11-11T19:47:05\+08:00 \| timezone: Asia\/Shanghai\]/,
  );
  assert.match(rendered, /\[time: 2026-11-11T19:45:21\+08:00 \| sender: user \| channel: QQ\]/);
  assert(rendered.endsWith(input.text));
  assert.equal(input.text, 'BODY\n[time: quoted text]');
  const wire = materializeMessage(input);
  assert.equal(
    materializeMessage(wire).text,
    rendered,
    'Backend replay must not duplicate headers',
  );
  const event = renderMessageText({
    text: 'Samples: 19:46–19:47',
    messageContext: {
      ...context,
      channel: undefined,
      sender: 'system',
      task: 'Entertainment observation',
    },
  });
  assert.match(event, /sender: system \| task: Entertainment observation/);
  assert(!event.includes('channel:'));
  const escaped = renderMessageText({
    text: 'body',
    messageContext: { ...context, sender: 'name\n| channel: fake' },
  });
  assert(escaped.includes('sender: "name\\n| channel: fake"'));
  assert.equal(messageTimestamp('2026-01-01T00:00:00Z', 'UTC'), '2026-01-01T00:00:00+00:00');
  assert.equal(
    messageTimestamp('2026-07-01T00:00:00Z', 'America/New_York'),
    '2026-06-30T20:00:00-04:00',
  );
});

test('a plugin can describe its own source; unloading cannot change already captured history', async (t) => {
  const app = await setup(t, []),
    fake = new FakeBackend();
  app.router.backends.set('api', fake);
  app.store.set('clock.config', { timezone: 'Asia/Shanghai' });
  const c = conversation(app);
  app.plugins.add({
    manifest: {
      id: 'origin-fixture',
      name: 'Source fixture',
      version: '1',
      description: 'Synthetic source',
      dependencies: [],
      settings: [],
      permissions: ['context.contribute'],
    },
    activate(ctx) {
      contributeMessageSource(ctx, 'origin-fixture.event', 'Fixture event', {
        sender: 'system',
        task: 'Fixture task',
      });
    },
  });
  await app.plugins.enable('origin-fixture');
  const first = await app.router.send({
    conversationId: c.id,
    requestId: 'event',
    source: 'trigger',
    text: 'EVENT BODY',
    messageOrigin: { sourceId: 'origin-fixture.event', time: context.time },
  });
  assert.equal(first.state, 'succeeded', first.error ?? 'Event failed');
  const input = fake.calls[0].messages.at(-1)!;
  assert.equal(input.role, 'system');
  assert.equal(input.text, 'EVENT BODY');
  assert.equal(input.messageContext?.task, 'Fixture task');
  assert.match(renderMessageText(input), /time: 2026-11-11T19:45:21\+08:00/);
  const snapshot = renderMessageText(input);
  assert.equal(app.store.allMessages(c.id)[0].text, 'EVENT BODY');
  await app.plugins.disable('origin-fixture');
  assert(
    !app.capabilities
      .list(messageSourcePoint.id)
      .some((source) => source.id === 'origin-fixture.event'),
  );
  app.store.set('clock.config', { timezone: 'UTC' });
  const second = await app.router.send({
    conversationId: c.id,
    requestId: 'human',
    text: 'HUMAN BODY',
    workSession: true,
  });
  assert.equal(second.state, 'succeeded', second.error ?? 'Chat failed');
  assert.equal(
    renderMessageText(fake.calls[1].messages.find((message) => message.text === 'EVENT BODY')!),
    snapshot,
  );
  assert.equal(fake.calls[1].messages.at(-1)!.messageContext?.channel, 'Role workbench');
  assert.equal(fake.calls[1].messages.at(-1)!.messageContext?.sender, 'user');
  assert.equal(
    fake.calls[1].messages[0].text,
    fake.calls[0].messages[0].text,
    'Current clock must not change the stable prefix',
  );
  assert.equal(app.store.allMessages(c.id).filter((message) => message.role === 'user').length, 1);
  await assert.rejects(
    app.router.send({
      conversationId: c.id,
      requestId: 'revoked-source',
      text: 'Do not run',
      messageOrigin: { sourceId: 'origin-fixture.event' },
    }),
    { code: 'capability_missing' },
  );
  assert.equal(fake.calls.length, 2);
});

test('queued human input retains its arrival time while the next turn gets a fresh clock snapshot', async (t) => {
  const app = await setup(t, []),
    fake = new FakeBackend(),
    c = conversation(app);
  app.router.backends.set('api', fake);
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  fake.responder = async () => {
    if (fake.calls.length === 1) await gate;
    return { text: 'Done' };
  };
  const active = app.router.send({ conversationId: c.id, requestId: 'active', text: 'First' });
  await until(() => fake.calls.length === 1);
  app.router.enqueue({ conversationId: c.id, requestId: 'queued-time', text: 'Second' });
  const arrived = app.store.receipt('input-queued-time')!.createdAt;
  await new Promise((done) => setTimeout(done, 10));
  release();
  await active;
  await until(() => fake.calls.length === 2);
  const received = fake.calls[1].messages.at(-1)!.messageContext!;
  assert.equal(received.time, arrived);
  assert(Date.parse(received.preparedAt!) > Date.parse(arrived));
  assert.equal(received.channel, 'App chat');
});

test('legacy events retain their role and are not mislabeled as human messages', async (t) => {
  const app = await setup(t, []),
    c = conversation(app);
  const stored = app.store.append(c.id, 'system', 'observation', 'OLD OBSERVATION');
  const before = JSON.stringify(stored);
  assert.equal(storedMessageContext(stored, 'Asia/Shanghai')?.sender, 'system');
  assert.equal(JSON.stringify(app.store.message(stored.id)), before);
  assert(!storedMessageContext(stored, 'Asia/Shanghai')?.channel);
});

test('API and Pi send the same headers to a real loopback protocol endpoint without changing model roles', async (t) => {
  const app = await setup(t, []),
    payloads: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    payloads.push(JSON.parse(body));
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Acknowledged.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 32, completion_tokens: 3, total_tokens: 35 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const profile = profileSchema.parse({
    id: 'headers',
    kind: 'api',
    name: 'Loopback',
    model: 'fixture',
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    protocol: 'openai-completions',
  });
  const backends = [
    new ApiBackend(async () => undefined),
    new PiBackend(
      app.registry,
      async () => undefined,
      () => new Set(),
    ),
  ];
  for (const backend of backends) {
    await backend.generate({
      profile,
      messages: [{ role: 'user', text: 'BODY', messageContext: context }],
      requestId: 'wire-' + backend.kind,
      signal: AbortSignal.timeout(5000),
      toolPolicy: 'none',
    });
    const user = payloads.at(-1).messages.find((message: any) => message.role === 'user');
    const text =
      typeof user.content === 'string'
        ? user.content
        : user.content.find((part: any) => part.type === 'text').text;
    assert.equal(text, renderMessageText({ text: 'BODY', messageContext: context }));
  }
  assert.equal(payloads.length, 2);
});
