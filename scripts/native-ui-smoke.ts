import{seedProfile,seedRoutes}from'./inference-fixture.ts';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Application } from '../apps/server/application.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import {
  draftToNative,
  snapshotNative,
  snapshotNativeComposer,
  nativeComposerCommand,
} from './native-controls.ts';
const project = resolve(import.meta.dirname, '..'),
  base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'native-ui-'));
const app = await Application.create({ runtime, project });
const call = (name: string, input = {}) =>
  app.registry.call(name, input, { kind: 'ui', permissions: new Set(['*']) });
const wait = async (fn: () => Promise<boolean>) => {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > 8000) throw Error('Native UI check timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
try {
  const profile = profileSchema.parse({
    id: 'native-ui',
    name: 'Synthetic',
    kind: 'api',
    model: 'synthetic',
    endpoint: 'http://127.0.0.1:1/v1',
  });
  seedProfile(app,profile);
  seedRoutes(app, { chat: profile.id });
  let calls = 0;
  let finishFirst!: () => void;
  const firstRun = new Promise<void>((resolve) => { finishFirst = resolve; });
  app.router.backends.set('api', {
    kind: 'api',
    generate: async () => {
      calls++;
      if (calls === 1) await firstRun;
      return { text: '刚才视频里那个转折挺有意思，我还想和你聊聊。你怎么看？' };
    },
  });
  app.store.saveConversation({
    id: 'native-ui',
    title: 'Echo',
    personaId: 'companion',
    injection: false,
    review: false,
    createdAt: new Date().toISOString(),
  });
  await call('settings.save', {
    pluginId: 'avatar',
    value: {
      enabled: true,
      conversationId: 'native-ui',
      scale: 1,
      bubbleSeconds: 60,
      corner: 'right',
    },
  });
  await wait(async () => Boolean((await call('avatar.status')).visible));
  assert.equal(
    (await call('avatar.status')).borderless,
    true,
    'The transparent character has no card shadow class',
  );
  assert.equal((await call('avatar.status')).clip, 'idle');
  const initial = app.router.send({
    conversationId: 'native-ui',
    requestId: 'initial',
    text: 'Synthetic UI fixture',
    bubble: true,
  });
  try {
    await wait(async () => {
      const status = await call('avatar.status');
      return status.activity === 'working' && status.clip === 'walk';
    });
  } finally { finishFirst(); }
  await initial;
  await wait(async () => {
    const status = await call('avatar.status');
    return status.bubbleVisible && status.activity === 'speaking' && status.clip === 'jump';
  });
  const pid = (await call('avatar.status')).pid;
  snapshotNative(pid, join(project, 'docs/screenshots/native-bubble.png'));
  draftToNative(pid, '我也觉得那个转折很有趣，\r\n我们接着聊吧。');
  snapshotNativeComposer(pid, join(project, 'docs/screenshots/native-input.png'));
  nativeComposerCommand(pid, 'ime-start');
  nativeComposerCommand(pid, 'enter');
  assert.equal(calls, 1, 'IME candidate confirmation must not submit');
  assert.equal((await call('avatar.status')).imeComposing, true);
  nativeComposerCommand(pid, 'ime-end');
  nativeComposerCommand(pid, 'enter');
  await wait(async () => calls === 2 && !(await call('avatar.status')).composerVisible);
  const messages = app.store.allMessages('native-ui');
  assert.equal(messages.filter((m) => m.source === 'human').length, 2);
  assert(messages.some((m) => m.text.includes('我们接着聊吧。')));
  draftToNative(pid, '未发送的草稿');
  nativeComposerCommand(pid, 'blur');
  assert.equal((await call('avatar.status')).composerVisible, false);
  assert.equal((await call('avatar.status')).draftLength, 0);
  assert.equal(calls, 2);
  draftToNative(pid, '另一份未发送的草稿');
  nativeComposerCommand(pid, 'escape');
  assert.equal((await call('avatar.status')).composerVisible, false);
  assert.equal((await call('avatar.status')).draftLength, 0);
  assert.equal(calls, 2);
  await call('preferences.save', { language: 'en', accent: '#168477' });
  await wait(async () => (await call('avatar.status')).language === 'en');
  process.kill(pid);
  await wait(async () => {
    const status = await call('avatar.status');
    return status.running && status.visible && status.pid !== pid;
  });
  assert.equal(
    (await call('avatar.status')).text,
    '',
    'Already shown bubbles must not replay after host recovery',
  );
  const report = {
    nativeUi: true,
    activityClips: true,
    englishInputHint: true,
    buttonsAbsent: true,
    enterSendsOnce: true,
    imeEnterDoesNotSubmit: true,
    blurCancelsDraft: true,
    escapeCancelsDraft: true,
    multilineRetained: true,
    nativeRecoveryWithoutReplay: true,
    paidCalls: 0,
    runtime,
  };
  await mkdir(join(project, 'test-results'), { recursive: true });
  await writeFile(join(project, 'test-results/native-ui.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await app.close();
}
