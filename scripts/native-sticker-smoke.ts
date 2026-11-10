import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { Application } from '../apps/server/application.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile, seedRoutes } from './inference-fixture.ts';
import { snapshotNative } from './native-controls.ts';
import chatstickManifest from '../plugins/chatstick/echo-plugin.json' with { type: 'json' };

const project = resolve(import.meta.dirname, '..');
const temp = await realpath(tmpdir());
const runtime = await mkdtemp(join(temp, 'EchoStickerFixture-'));
const app = await Application.create({ runtime, project, plugins: ['files', 'persona', 'avatar', 'chatstick'] });
const call = (name: string, params = {}) =>
  app.registry.call(name, params, { kind: 'ui', permissions: new Set(['*']) });
const wait = async <T>(probe: () => Promise<T | undefined>) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 60));
  }
  throw Error('Timed out waiting for native sticker fixture');
};

try {
  assert(!chatstickManifest.dependencies.includes('channels'));
  assert.equal(app.channels.bindings().length, 0);
  const profile = profileSchema.parse({
    id: 'fixture-api', name: 'Fixture', kind: 'api', model: 'fixture',
    endpoint: 'http://127.0.0.1:1/v1',
  });
  seedProfile(app, profile);
  seedRoutes(app, { chat: profile.id });
  const persona = app.store.document<any>('personas', 'companion')!;
  app.store.put('personas', persona.id, { ...persona, expression: { bubble: 'Fixture short and warm' } });
  const conversationId = 'sticker-ui';
  app.store.saveConversation({
    id: conversationId, title: 'Sticker fixture', personaId: 'companion',
    injection: true, review: false, createdAt: new Date().toISOString(),
  });
  const colors = ['#cc1680', '#1587bb', '#9935cd'];
  for (const [i, key] of ['regular', 'care', 'missing'].entries()) {
    const png = await sharp({
      create: { width: 48, height: 36, channels: 4, background: colors[i] },
    }).png().toBuffer();
    await call('chatstick.save', {
      personaId: 'companion', key, label: key, meaning: 'A synthetic sticker', data: png.toString('base64'),
    });
  }
  const missing = app.store.document<any>('chatstick', 'companion:missing')!;
  app.store.put('chatstick', 'companion:missing', { ...missing, image: { ...missing.image, hash: '0'.repeat(64) } });
  const turns = [
    { source: 'human', key: 'regular', image: true, hint: true },
    { source: 'care', key: 'care', image: true, hint: true },
    { source: 'observation', key: 'regular', image: false, hint: false },
    { source: 'human', key: 'missing', image: false, hint: true },
  ] as const;
  let index = 0;
  app.router.backends.set('api', {
    kind: 'api',
    generate: async ({ messages }) => {
      const expected = turns[index];
      assert.equal(messages.some((m) => m.context === 'turn' && m.text.includes('本轮显示在桌宠小气泡')), expected.hint);
      assert.equal(messages.some((m) => m.context === 'turn' && m.text.includes('Fixture short and warm')), expected.hint);
      assert.equal(messages[0].text.includes('[ECHO_STICKER:编号]'), expected.source !== 'observation');
      return { text: `Synthetic reply ${index}\n[ECHO_STICKER:${expected.key}]` };
    },
  });
  await call('settings.save', {
    pluginId: 'avatar', value: { enabled: true, conversationId, scale: 1, bubbleSeconds: 5 },
  });
  await wait(async () => (await call('avatar.status')).visible || undefined);
  const output = join(project, 'test-results');
  await mkdir(output, { recursive: true });
  for (const expected of turns) {
    const run = await app.router.send({
      conversationId, requestId: `sticker-${index}`, text: `Fixture turn ${index}`,
      source: expected.source, bubble: true,
    });
    assert.equal(run.state, 'succeeded', run.error ?? 'Synthetic run did not complete');
    const message = app.store.assistantForRun(run.id)!;
    assert.equal(message.text, `Synthetic reply ${index}`);
    const receipt = await wait(async () => {
      const row = app.store.receipt('bubble-' + message.id);
      return row?.state === 'shown' ? row : undefined;
    });
    assert.equal(receipt.imageShown === true, expected.image);
    if (expected.image) {
      const image = join(output, `native-sticker-${expected.source}.png`);
      snapshotNative((await call('avatar.status')).pid, image);
      const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const color = Buffer.from(colors[index].slice(1), 'hex');
      let painted = 0;
      for (let offset = 0; offset < data.length; offset += info.channels)
        if (data[offset] === color[0] && data[offset + 1] === color[1] && data[offset + 2] === color[2])
          painted++;
      assert(painted >= 100, 'Expected real sticker pixels in the owned native bubble');
    }
    index++;
  }
  console.log(JSON.stringify({ chatAndCareImage: true, observeTextOnly: true, missingImageKeepsText: true,
    nativePixelsVerified: true, noChannelBindings: true, externalCalls: 0 }));
} finally {
  await app.close();
  if (dirname(await realpath(runtime)) === temp)
    await rm(runtime, { recursive: true, force: true });
}
