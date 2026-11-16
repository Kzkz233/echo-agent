import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ApiBackend } from '../packages/backends/api.ts';
import { PiBackend } from '../packages/backends/pi.ts';
import { modelProtocol } from '../packages/backends/protocol.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { Registry } from '../packages/kernel/registry.ts';
import { memoryConfigSchema } from '../plugins/memory/index.ts';

const event = (body: object) => 'data: ' + JSON.stringify(body) + '\n\n';

for (const field of ['max_tokens', 'max_completion_tokens'] as const)
  test(`agent and auxiliary API requests honor ${field} without treating characters as tokens`, async (t) => {
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += part;
      requests.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        event({
          id: 'fixture',
          model: 'synthetic',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Complete result' },
              finish_reason: 'stop',
            },
          ],
        }) + 'data: [DONE]\n\n',
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
      id: 'fixture',
      name: 'Fixture',
      kind: 'api',
      model: 'synthetic',
      endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      contextChars: 4000,
      maxOutputTokens: 128000,
      modelOptions: { maxTokensField: field },
    });
    const api = new ApiBackend(async () => undefined),
      pi = new PiBackend(new Registry(), async () => undefined);
    for (const backend of [api, pi]) {
      const result = await backend.generate({
        profile,
        requestId: 'fixture',
        toolPolicy: 'none',
        messages: [{ role: 'user', text: 'Give the result' }],
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(result.text, 'Complete result');
    }
    assert.equal(requests.length, 2);
    for (const body of requests) {
      assert.equal(body[field], 128000);
      assert.equal(
        body[field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'],
        undefined,
      );
    }
    // An explicitly declared model capacity still constrains generation.
    await pi.generate({
      profile: {
        ...profile,
        modelOptions: { ...profile.modelOptions, contextWindowTokens: 32000 },
      },
      requestId: 'bounded',
      toolPolicy: 'none',
      messages: [{ role: 'user', text: 'Give the result' }],
      signal: AbortSignal.timeout(5000),
    });
    assert(requests[2][field] > 0 && requests[2][field] < 32000);
  });

test('automatic output fields follow the endpoint and memory settings accept the common reasoning levels', async () => {
  const profile = profileSchema.parse({
    id: 'fixture',
    name: 'Fixture',
    kind: 'api',
    endpoint: 'https://api.openai.com/v1',
  });
  for (const [configured, expected] of [
    [profile, 'max_completion_tokens'],
    [{ ...profile, endpoint: 'http://127.0.0.1:1/v1' }, 'max_tokens'],
    [{ ...profile, modelOptions: { maxTokensField: 'max_tokens' } }, 'max_tokens'],
  ] as const) {
    const { model } = await modelProtocol(configured);
    assert(model.compat && 'maxTokensField' in model.compat);
    assert.equal(model.compat.maxTokensField, expected);
  }
  assert.equal(memoryConfigSchema.parse({ reasoning: 'max' }).reasoning, 'max');
  assert.equal(memoryConfigSchema.parse({}).reasoning, 'off');
});
