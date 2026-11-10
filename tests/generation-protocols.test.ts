import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { z } from 'zod';
import { PiBackend } from '../packages/backends/pi.ts';
import { generationProtocol } from '../packages/contracts/index.ts';
import { setup } from './helpers.ts';

const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
const sse = (data: Record<string, unknown>) =>
  (data.type ? 'event: ' + data.type + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n';

function providerStream(protocol: string, output: string, tool?: string, truncated = false) {
  const args = '{}';
  if (protocol === 'openai-completions')
    return [
      sse({
        id: 'chatcmpl_test',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              ...(tool
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_test',
                        type: 'function',
                        function: { name: tool, arguments: args },
                      },
                    ],
                  }
                : { content: output }),
            },
            finish_reason: tool ? 'tool_calls' : 'stop',
          },
        ],
      }),
      'data: [DONE]\n\n',
    ].join('');
  if (protocol === 'openai-responses') {
    const item = tool
      ? { id: 'fc_test', type: 'function_call', call_id: 'call_test', name: tool, arguments: '' }
      : { id: 'msg_test', type: 'message', role: 'assistant', content: [] };
    const done = tool
      ? { ...item, arguments: args }
      : { ...item, content: [{ type: 'output_text', text: output, annotations: [] }] };
    return [
      { type: 'response.output_item.added', output_index: 0, item },
      tool
        ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: args }
        : { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: output },
      { type: 'response.output_item.done', output_index: 0, item: done },
      ...(!truncated
        ? [
            {
              type: 'response.completed',
              response: {
                id: 'resp_test',
                status: 'completed',
                output: [done],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ]
        : []),
    ]
      .map(sse)
      .join('');
  }
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: tool
        ? { type: 'tool_use', id: 'toolu_test', name: tool, input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: tool
        ? { type: 'input_json_delta', partial_json: args }
        : { type: 'text_delta', text: output },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: tool ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 2 },
    },
    ...(!truncated ? [{ type: 'message_stop' }] : []),
  ]
    .map(sse)
    .join('');
}

for (const protocol of generationProtocol.options)
  test(
    protocol + ' goes through the saved connection, tool loop and generation test',
    async (t) => {
      const app = await setup(t, []);
      let toolRuns = 0,
        requests = 0;
      let serverError: unknown;
      app.registry.register({
        name: 'fixture.read',
        owner: 'core',
        description: 'Synthetic read',
        permission: 'fixture.read',
        mcp: true,
        input: z.object({}),
        output: z.object({ fixture: z.string() }),
        run: () => {
          toolRuns++;
          return { fixture: 'read result' };
        },
      });
      const server = createServer(async (req, res) => {
        requests++;
        try {
          if (protocol === 'anthropic-messages') {
            assert.equal(req.headers['x-api-key'], 'fixture-key');
            assert.equal(req.headers['anthropic-version'], '2023-06-01');
          } else {
            assert.equal(req.headers.authorization, 'Bearer fixture-key');
          }
          if (req.method === 'GET') {
            assert.equal(req.url, '/v1/models');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
            return;
          }
          const path = {
            'openai-completions': '/v1/chat/completions',
            'openai-responses': '/v1/responses',
            'anthropic-messages': '/v1/messages',
          }[protocol];
          assert.equal(req.url?.split('?')[0], path);
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const data = JSON.parse(raw);
          assert.equal(data.stream, true);
          if (protocol === 'openai-responses') assert.equal(data.store, false);
          const turns = data.messages ?? data.input;
          const continuation = JSON.stringify(turns);
          const isProbe = continuation.includes('Call echo_connection_test');
          const hasToolResult =
            protocol === 'openai-completions'
              ? turns.some((m: any) => m.role === 'tool')
              : protocol === 'openai-responses'
                ? turns.some(
                    (m: any) => m.type === 'function_call_output' && m.call_id === 'call_test',
                  )
                : turns.some(
                    (m: any) =>
                      Array.isArray(m.content) &&
                      m.content.some(
                        (part: any) =>
                          part.type === 'tool_result' && part.tool_use_id === 'toolu_test',
                      ),
                  );
          if (hasToolResult) assert(continuation.includes(isProbe ? 'ECHO_OK' : 'read result'));
          const toolName = isProbe ? 'echo_connection_test' : 'fixture_read';
          const wantsTool =
            !hasToolResult && (isProbe || continuation.includes('Read the fixture'));
          if (wantsTool)
            assert(data.tools.some((tool: any) => (tool.function?.name ?? tool.name) === toolName));
          if (continuation.includes('Check image')) assert(continuation.includes('aGk='));
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(
            providerStream(
              protocol,
              isProbe ? 'ECHO_OK' : 'Fixture reply',
              wantsTool ? toolName : undefined,
              continuation.includes('Truncate fixture'),
            ),
          );
        } catch (error) {
          serverError = error;
          res.writeHead(500);
          res.end();
        }
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      t.after(() => {
        server.closeAllConnections();
        return new Promise<void>((done) => server.close(() => done()));
      });
      const endpoint = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
      await app.secrets.set('fixture-credential', 'fixture-key');
      await app.router.inference.saveConnection({
        id: 'fixture-protocol',
        name: 'Fixture',
        adapterId: 'core.api',
        deployment: 'local',
        config: {
          endpoint,
          apiKeyRef: 'fixture-credential',
          ...(protocol === 'openai-completions' ? {} : { protocol }),
        },
      });
      await app.router.inference.saveModel({
        id: 'fixture-model',
        name: 'Fixture model',
        connectionId: 'fixture-protocol',
        model: 'fixture',
        generation: { enabled: true, inputs: ['text', 'image'] },
      });
      const profile = app.router.profile('fixture-model');
      assert.equal(profile.protocol, protocol);
      assert.equal((await app.api.listModels(profile))[0].id, 'fixture');
      const pi = new PiBackend(
        app.registry,
        async () => 'fixture-key',
        () => new Set(['fixture.read']),
      );
      const signal = AbortSignal.timeout(10000);
      const result = await pi.generate({
        profile,
        messages: [{ role: 'user', text: 'Read the fixture' }],
        requestId: 'fixture-pi',
        signal,
      });
      assert.equal(result.text, 'Fixture reply');
      assert.equal(toolRuns, 1);
      const check = await app.registry.call(
        'connections.test',
        { id: 'fixture-protocol', generation: true },
        ui,
      );
      assert.equal(check.verified, 'generation');
      assert.equal(check.toolCall, true);
      assert.equal(toolRuns, 1);
      const deltas: string[] = [];
      assert.equal(
        (
          await app.api.generate({
            profile,
            requestId: 'fixture-api',
            signal,
            onDelta: (value) => deltas.push(value),
            messages: [
              { role: 'system', text: 'Only report the image.' },
              {
                role: 'user',
                text: 'Check image',
                images: [{ mimeType: 'image/png', data: 'aGk=' }],
              },
            ],
          })
        ).text,
        'Fixture reply',
      );
      assert.equal(deltas.join(''), 'Fixture reply');
      if (protocol !== 'openai-completions') {
        await assert.rejects(
          app.api.generate({
            profile,
            requestId: 'fixture-truncated',
            signal,
            messages: [{ role: 'user', text: 'Truncate fixture' }],
          }),
          { code: 'provider_stream_lost', uncertain: true },
        );
      }
      assert.equal(serverError, undefined);
      assert.equal(requests, protocol === 'openai-completions' ? 6 : 7);
    },
  );
