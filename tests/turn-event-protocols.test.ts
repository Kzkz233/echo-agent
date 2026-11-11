import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PiBackend } from '../packages/backends/pi.ts';
import { ApiBackend } from '../packages/backends/api.ts';
import {
  profileSchema,
  generationProtocol,
  type GenerateRequest,
} from '../packages/contracts/index.ts';
import { setup } from './helpers.ts';

const sse = (value: any) =>
  (value.type ? 'event: ' + value.type + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n';
function response(protocol: string) {
  if (protocol === 'openai-completions')
    return (
      sse({
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Synthetic reply' },
            finish_reason: 'stop',
          },
        ],
      }) + 'data: [DONE]\n\n'
    );
  if (protocol === 'openai-responses')
    return [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [] },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'Synthetic reply',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Synthetic reply', annotations: [] }],
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      },
    ]
      .map(sse)
      .join('');
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Synthetic reply' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
    .map(sse)
    .join('');
}

for (const protocol of generationProtocol.options)
  test(
    protocol +
      ' preserves current event, current channel contract and disabled thinking on the wire',
    async (t) => {
      const app = await setup(t, []);
      const bodies: any[] = [];
      const server = createServer(async (req, res) => {
        let text = '';
        for await (const chunk of req) text += chunk;
        bodies.push(JSON.parse(text));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(response(protocol));
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const backends = [
        new PiBackend(app.registry, async () => 'fixture-key'),
        new ApiBackend(async () => 'fixture-key'),
      ];
      let requests = 0;
      for (const backend of backends) {
        for (const effort of ['off', 'high'] as const) {
          for (const source of ['observation', 'care', 'mail', 'handoff', 'human']) {
            const items: any[] = [];
            let deliveries = 0;
            const request: GenerateRequest = {
              profile: profileSchema.parse({
                id: 'fixture',
                name: 'Fixture',
                kind: 'pi',
                protocol,
                endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
                model: 'fixture',
                reasoningStyle: 'deepseek',
              }),
              reasoning: effort,
              requestId: source,
              signal: AbortSignal.timeout(6000),
              messages: [
                { role: 'system', text: 'STABLE_PERSONA' },
                { id: 'prior-human', role: 'user', text: 'OLD_USER_REQUEST' },
                { id: 'prior-reply', role: 'assistant', text: 'OLD_ASSISTANT_REPLY' },
                {
                  id: 'turn-context',
                  role: 'system',
                  context: 'turn',
                  text: 'CURRENT_CHANNEL_CONTRACT echo_respond',
                },
                {
                  id: 'current',
                  role: source === 'human' ? 'user' : 'system',
                  text: 'CURRENT_' + source.toUpperCase() + '_EVENT',
                },
              ],
              respond: () => {
                deliveries++;
                return { accepted: true };
              },
              onItem: (item) => items.push(item),
              replyTargets: ['core.chat'],
            };
            await backend.generate(request);
            assert.equal(deliveries, 0, 'Ordinary model text is never forwarded');
            if (backend.kind === 'pi')
              assert(
                items.some((item) => item.kind === 'message' && item.text === 'Synthetic reply'),
                'Workbench must retain raw model output, including protocol failures',
              );
            assert.equal(
              bodies.length,
              ++requests,
              'No supplemental generation should be introduced',
            );
            const body = bodies.at(-1),
              input = body.input ?? body.messages;
            assert(
              JSON.stringify(input.at(-1)).includes('CURRENT_' + source.toUpperCase() + '_EVENT'),
              'Current ' + source + ' event was hoisted ahead of the prior user request',
            );
            const wire = JSON.stringify(input);
            if (protocol === 'openai-responses') {
              assert.equal(
                input[0].role,
                'system',
                'DeepSeek must not downgrade the stable prompt into developer/user input',
              );
              if (source !== 'human') {
                assert.equal(input.at(-1).role, 'user');
                assert(JSON.stringify(input.at(-1)).includes('<echo_application_event>'));
              }
              const contract = input.find((message: any) =>
                JSON.stringify(message).includes('CURRENT_CHANNEL_CONTRACT'),
              );
              assert.equal(
                contract.role,
                'system',
                'Per-turn channel rules must keep system authority',
              );
            }
            if (backend.kind === 'pi')
              assert(
                JSON.stringify(body.tools).includes('echo_respond'),
                'Reply tool must be declared on the wire',
              );
            assert(
              wire.indexOf('CURRENT_CHANNEL_CONTRACT') > wire.indexOf('OLD_ASSISTANT_REPLY'),
              'Current channel contract was hoisted into the historical prefix',
            );
            if (protocol === 'openai-responses')
              assert.equal(
                body.reasoning?.effort,
                effort === 'off' ? 'none' : 'high',
                'The selected effort must reach the upstream unchanged',
              );
            else assert.equal(body.thinking?.type, effort === 'off' ? 'disabled' : 'enabled');
          }
        }
      }
    },
  );
