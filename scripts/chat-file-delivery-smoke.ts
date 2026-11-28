import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { Application } from '../apps/server/application.ts';
import { seedProfile } from './inference-fixture.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { FakeBackend } from '../tests/helpers.ts';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const app = await Application.create({
  project,
  runtime: await mkdtemp(join(tmpdir(), 'echo-dialogue-')),
});
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    kind: 'api',
    name: 'Synthetic',
    model: 'fixture',
    endpoint: 'http://127.0.0.1:1/v1',
    vision: true,
  }),
);
const backend = new FakeBackend();
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const answer = gate();
backend.responder = async (request) => {
  await answer.promise;
  const msg = app.store.allMessages(id).find((m) => m.text === 'First question');
  const file = (msg?.meta.attachments as { id: string }[] | undefined)?.[0];
  for (const targetId of request.replyTargets ?? [])
    request.respond?.({
      targetId,
      phase: 'final',
      messages: ['Finished ' + backend.calls.length],
      ...(file ? { attachmentIds: [file.id] } : {}),
    });
  return { text: '' };
};
app.router.backends.set('api', backend);
await app.registry.call(
  'characters.examples.create',
  { profileId: 'fixture', requestId: 'fixture-role' },
  internal,
);
const id = app.store.document<any>('characters', 'example-aria')!.mainConversationId;
const server = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ack = gate();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    `http://127.0.0.1:${server.port}/?page=character&persona=example-aria#token=${server.token}`,
  );
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const input = page.getByRole('textbox', { name: '聊天消息' });
  await page.route('**/rpc', async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === 'conversations.send' && body.params.text === 'First question')
      await ack.promise;
    await route.continue();
  });
  const content = Buffer.from('%PDF-1.7\n% Synthetic bytes\n');
  await page
    .locator('.attachment-actions input[type=file]')
    .setInputFiles({ name: 'example.pdf', mimeType: 'application/pdf', buffer: content });
  await page.waitForFunction(() =>
    document.querySelector('.composer')?.textContent?.includes('example.pdf'),
  );
  await input.fill('First question');
  await input.press('Enter');
  const outgoing = (value: string) =>
    page.locator('.dialogue-delivery.outgoing').filter({ hasText: value });
  await outgoing('First question').waitFor();
  assert.equal(backend.calls.length, 0);
  ack.resolve();
  await page.waitForFunction(
    () => !document.querySelector('.composer')?.textContent?.includes('example.pdf'),
  );
  await input.fill('Second question');
  await input.press('Enter');
  await outgoing('Second question').waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('.dialogue-delivery.outgoing').length === 2,
  );
  const deadline = Date.now() + 10000;
  while (
    !app.store.queuedInput(id) ||
    app.store.queuedInput(id)?.input.text !== 'Second question'
  ) {
    if (Date.now() > deadline) throw Error('Second turn was not queued');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  await page.reload();
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await outgoing('Second question').waitFor();
  assert.equal(await outgoing('First question').count(), 1);
  assert.equal(await page.locator('article.dialogue-delivery.incoming').count(), 0);
  answer.resolve();
  const incoming = page.locator('.dialogue-delivery.incoming').filter({ hasText: 'Finished 1' });
  await incoming.waitFor();
  const downloaded = page.waitForEvent('download');
  await incoming.getByRole('button', { name: 'example.pdf' }).click();
  const output = await downloaded;
  assert.deepEqual(await readFile((await output.path())!), content);
  await page.locator('.dialogue-delivery.incoming').filter({ hasText: 'Finished 2' }).waitFor();
  assert.equal(await outgoing('Second question').count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: bubble before acknowledgement, queued turn across reload, one bubble per input, file delivery and original bytes.',
  );
} finally {
  ack.resolve();
  answer.resolve();
  await browser.close();
  await server.close();
  await app.close();
}
