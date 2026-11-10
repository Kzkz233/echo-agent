import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../apps/server/application.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { seedProfile } from './inference-fixture.ts';
import { FakeBackend } from '../tests/helpers.ts';
import { replyToNative } from './native-controls.ts';

const project = resolve(import.meta.dirname, '..'),
  base = join(await realpath(tmpdir()), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'avatar-fleet-'));
const app = await Application.create({ project, runtime, plugins: ['persona', 'avatar'] });
const call = (name: string, value: any = {}) => app.registry.call(name, value, internal);
const wait = async <T>(probe: () => Promise<T | undefined>) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error('Native fleet fixture timed out');
};
const backend = new FakeBackend();
app.router.backends.set('api', backend);
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    name: 'Fixture',
    kind: 'api',
    model: 'fixture',
    endpoint: 'http://127.0.0.1:1/v1',
  }),
);
try {
  for (const name of ['hina', 'miyu'])
    await call('persona.character.commit', {
      requestId: name,
      draft: characterDraft.parse({
        persona: { id: name, name, prompt: 'Synthetic fixture' },
        profileId: 'fixture',
        features: ['avatar'],
        configurations: {
          avatar: {
            enabled: true,
            scale: name === 'hina' ? 1.4 : 0.7,
            roam: false,
            assetDirectory: join(project, 'apps/workbench/public/assets/starter-characters', name),
            animationClips: { idle: 'idle', working: 'running', speaking: 'waving' },
            fps: 8,
          },
        },
      }),
    });
  const status = await wait(async () => {
    const value = await call('avatar.status');
    if (value.count !== 2) return;
    const ordered = [...value.instances].sort((a:any,b:any)=>a.left-b.left);
    return ordered[0].left + ordered[0].width <= ordered[1].left ? value : undefined;
  });
  const [hina, miyu] = ['hina', 'miyu'].map((id) =>
    status.instances.find((n: any) => n.personaId === id),
  );
  assert.notEqual(hina.pid, miyu.pid);
  assert.notEqual(hina.left, miyu.left);
  assert.notEqual(hina.width, miyu.width);
  for (const name of ['hina', 'miyu'])
    app.router.notice({
      conversationId: 'main-' + name,
      requestId: name + '-notice',
      title: name,
      text: 'Fixture ' + name,
      bubble: true,
    });
  await wait(async () => {
    const state = await call('avatar.status');
    return state.instances.every(
      (n: any) => n.bubbleVisible && n.text === n.personaId + '\nFixture ' + n.personaId,
    )
      ? true
      : undefined;
  });
  // Test only owned fixture windows by exact PID. No real provider or user window is touched.
  replyToNative(hina.pid, 'Hina input fixture');
  await wait(async () =>
    app.store.allMessages('main-hina').some((m) => m.source === 'human') ? true : undefined,
  );
  assert.equal(app.store.allMessages('main-miyu').filter((m) => m.source === 'human').length, 0);
  replyToNative(miyu.pid, 'Miyu input fixture');
  await wait(async () =>
    app.store.allMessages('main-miyu').some((m) => m.source === 'human') ? true : undefined,
  );
  assert.equal(app.store.allMessages('main-hina').filter((m) => m.source === 'human').length, 1);
  await call('characters.setActive', { personaId: 'hina', enabled: false, revision: 0 });
  await wait(async () => {
    const state = await call('avatar.status');
    return state.count === 1 && state.instances[0].personaId === 'miyu' ? true : undefined;
  });
  assert.equal((await call('avatar.status', { personaId: 'miyu' })).pid, miyu.pid);
  await call('characters.setActive', { personaId: 'hina', enabled: true, revision: 1 });
  await wait(async () => ((await call('avatar.status')).count === 2 ? true : undefined));
  assert.equal(backend.calls.length, 2);
  await call('avatar.setVisible', {visible:false});
  assert.equal((await call('avatar.status')).count,0);
  await call('avatar.setVisible', {visible:true});
  await wait(async()=>((await call('avatar.status')).count===2)?true:undefined);
  console.log(
    JSON.stringify({
      nativeWindows: 2,
      distinctPositions: true,
      bubbleIsolation: true,
      replyIsolation: true,
      independentRoleToggle: true,
      fakeModelCalls: 2,
      externalCalls: 0,
    }),
  );
} finally {
  await app.close();
  if (dirname(await realpath(runtime)) === base)
    await rm(runtime, { recursive: true, force: true });
}
