import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiBackend } from '../packages/backends/api.ts';
import { profileSchema, EchoError } from '../packages/contracts/index.ts';

for (const streamed of [false, true])
  for (const [reason, text, code] of [
    ['length', 'unfinished', 'provider_output_limit'],
    ['stop', '', 'provider_empty'],
  ])
    test(`API rejects ${reason}/${text || 'empty'} output (stream=${streamed}) without retry`, async () => {
      let calls = 0;
      const backend = new ApiBackend(
        async () => undefined,
        async () => {
          calls++;
          const choice = {
            finish_reason: reason,
            message: { content: text },
            delta: { content: text },
          };
          return new Response(
            streamed
              ? `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`
              : JSON.stringify({ choices: [choice] }),
            { headers: { 'Content-Type': streamed ? 'text/event-stream' : 'application/json' } },
          );
        },
      );
      await assert.rejects(
        backend.generate({
          profile: profileSchema.parse({
            id: 'fixture',
            name: 'Fixture',
            kind: 'api',
            endpoint: 'http://127.0.0.1:1/v1',
            model: 'fixture',
          }),
          messages: [{ role: 'user', text: 'Synthetic' }],
          requestId: 'fixture',
          signal: new AbortController().signal,
        }),
        (e) => e instanceof EchoError && e.code === code && !e.uncertain,
      );
      assert.equal(calls, 1);
    });
