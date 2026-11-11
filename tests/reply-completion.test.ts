import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import { setup } from './helpers.ts';
import { PiBackend } from '../packages/backends/pi.ts';
import { profileSchema } from '../packages/contracts/index.ts';

test('missing channel delivery continues once with only reply tools and never repeats completed work', async (t) => {
  const app = await setup(t, []);
  let reads = 0;
  app.registry.register({
    name: 'fixture.read',
    owner: 'core',
    description: 'Synthetic read',
    input: z.object({}),
    output: z.unknown(),
    permission: 'fixture.read',
    mcp: true,
    run: () => {
      reads++;
      return { finding: 'verified synthetic fact' };
    },
  });
  const bodies: any[] = [],
    delivered: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const calls =
      bodies.length === 1
        ? [{ name: 'fixture_read', args: {} }]
        : bodies.length === 2
          ? []
          : ['core.chat', 'notifications.inbox'].map((targetId) => ({
              name: 'echo_respond',
              args: { targetId, phase: 'final', messages: ['Verified finding for ' + targetId] },
            }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: calls.length ? 'tool_calls' : 'stop',
              delta: {
                role: 'assistant',
                ...(calls.length
                  ? {
                      tool_calls: calls.map((call, index) => ({
                        index,
                        id: 'call-' + bodies.length + '-' + index,
                        type: 'function',
                        function: { name: call.name, arguments: JSON.stringify(call.args) },
                      })),
                    }
                  : { content: 'Internal work notes, not a user delivery.' }),
              },
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const backend = new PiBackend(
    app.registry,
    async () => undefined,
    () => new Set(['fixture.read']),
  );
  await backend.generate({
    profile: profileSchema.parse({
      id: 'fixture',
      name: 'Fixture',
      kind: 'pi',
      model: 'synthetic',
      endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    }),
    messages: [
      {
        role: 'user',
        text: 'Inspect the synthetic fixture and deliver to both selected channels.',
      },
    ],
    requestId: 'repair',
    signal: AbortSignal.timeout(8000),
    replyTargets: ['core.chat', 'notifications.inbox'],
    respond: (value) => {
      delivered.push(value);
      return { accepted: true };
    },
  });
  assert.equal(reads, 1);
  assert.equal(bodies.length, 3);
  assert.deepEqual(
    bodies[2].tools.map((tool: any) => tool.function.name),
    ['echo_respond'],
  );
  assert.deepEqual(bodies[2].tools[0].function.parameters.properties.phase.const, 'final');
  assert.deepEqual(delivered.map((item) => item.targetId).sort(), [
    'core.chat',
    'notifications.inbox',
  ]);
  assert(delivered.every((item) => !item.messages.join('').includes('Internal work notes')));
});

test('an explicitly permitted quiet proactive turn does not trigger delivery completion', async (t) => {
  const app = await setup(t, []);
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              delta: { role: 'assistant', content: '[ECHO_SKIP]' },
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const result = await new PiBackend(app.registry, async () => undefined).generate({
    profile: profileSchema.parse({
      id: 'fixture',
      name: 'Fixture',
      kind: 'pi',
      model: 'synthetic',
      endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    }),
    messages: [{ role: 'system', text: 'A synthetic quiet observation.' }],
    requestId: 'quiet',
    signal: AbortSignal.timeout(5000),
    replyTargets: ['core.chat'],
    allowSilence: true,
    respond: () => {
      throw Error('Unexpected delivery');
    },
  });
  assert.equal(result.text, '[ECHO_SKIP]');
  assert.equal(calls, 1);
});

test('delivery completion stops after a bounded number of uncooperative tool turns', async (t) => {
  const app = await setup(t, []);
  let calls = 0,
    deliveries = 0;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: calls === 1 ? 'stop' : 'tool_calls',
              delta: {
                role: 'assistant',
                ...(calls === 1
                  ? { content: 'Internal finding.' }
                  : {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'uncooperative-' + calls,
                          type: 'function',
                          function: {
                            name: 'echo_respond',
                            arguments: JSON.stringify({
                              targetId: 'core.chat',
                              phase: 'progress',
                              messages: ['still working'],
                            }),
                          },
                        },
                      ],
                    }),
              },
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(
    new PiBackend(app.registry, async () => undefined).generate({
      profile: profileSchema.parse({
        id: 'fixture',
        name: 'Fixture',
        kind: 'pi',
        model: 'synthetic',
        endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      }),
      messages: [{ role: 'user', text: 'Synthetic delivery.' }],
      requestId: 'bounded',
      signal: AbortSignal.timeout(5000),
      replyTargets: ['core.chat'],
      respond: () => {
        deliveries++;
        return { accepted: true };
      },
    }),
    /模型没有返回正文/,
  );
  assert.equal(calls, 3);
  assert.equal(deliveries, 0);
});
