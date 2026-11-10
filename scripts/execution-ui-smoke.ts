import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema, type GenerateRequest } from '../packages/contracts/index.ts';
import { seedProfile } from './inference-fixture.ts';
const project = resolve(import.meta.dirname, '..'),
  base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'execution-ui-'));
const workspace = await mkdtemp(join(base, 'execution-project-'));
await writeFile(join(workspace, 'README.md'), 'Synthetic project reference');
const app = await Application.create({ runtime, project });
let release: (v: any) => void = () => {},
  mainCalls = 0,
  steers = 0;
app.router.backends.set('pi', {
  kind: 'pi',
  capabilities: () => ({ events: true, steer: true, images: true, projectTools: true }),
  createSession: async () => crypto.randomUUID(),
  steer: async () => {
    steers++;
    release({ text: 'Finished with your update' });
  },
  generate: async (request: GenerateRequest) => {
    if (request.profile.id === 'worker') {
      const task = app.store.documents<any>('delegated-tasks').at(-1);
      await app.registry.call(
        'delegation.submit',
        {
          conversationId: task.workerConversationId,
          taskId: task.id,
          summary: 'Worker result',
          artifacts: [],
          verification: 'Synthetic verification',
          unresolved: '',
        },
        internal,
      );
      return { text: 'Worker result' };
    }
    mainCalls++;
    assert(request.messages.some((message) => message.text.includes('ATTACHMENT_FACT')));
    request.onNativeRun?.('native-fixture');
    request.onItem?.({
      id: 'command',
      kind: 'command',
      title: 'Fixture command',
      state: 'running',
      text: 'Current output',
    });
    return new Promise((resolve) => {
      const progress = setInterval(
        () =>
          request.onItem?.({
            id: 'command',
            kind: 'command',
            text: 'Live output before completion',
          }),
        60,
      );
      release = (value) => {
        clearInterval(progress);
        request.onItem?.({
          id: 'command',
          kind: 'command',
          title: 'Fixture command',
          state: 'completed',
          text: 'PASS',
        });
        resolve(value);
      };
      request.signal.addEventListener(
        'abort',
        () => {
          clearInterval(progress);
          resolve({ text: 'Stopped' });
        },
        { once: true },
      );
    });
  },
});
for (const id of ['main', 'worker'])
  seedProfile(
    app,
    profileSchema.parse({
      id,
      name: id === 'main' ? 'Fixture main' : 'Fixture worker',
      kind: 'pi',
      vision: true,
    }),
  );
await app.registry.call(
  'persona.character.commit',
  {
    requestId: 'create',
    draft: characterDraft.parse({
      persona: { id: 'fixture', name: 'Fixture', prompt: 'Synthetic' },
      profileId: 'main',
      permissions: { projectDirectory: workspace },
      features: ['delegation'],
      configurations: {
        delegation: {
          reportOnCompletion: false,
          templates: [{ id: 'build', name: 'Builder', profileId: 'worker' }],
        },
      },
    }),
  },
  internal,
);
const http = await serve(app, { webRoot: join(project, 'dist/web') }),
  browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${http.port}/#token=${http.token}`);
  await page
    .locator('aside')
    .getByRole('button', { name: /Fixture/ })
    .click();
  await page.getByLabel('本会话思考强度', { exact: true }).selectOption('off');
  assert.equal(await page.locator('.composer-model').count(), 0);
  assert.equal(await page.locator('.composer-controls .field').count(), 0);
  assert.equal(await page.locator('select[aria-label="本会话模型"]').count(), 0);
  assert.equal(await page.locator('.chat-settings').count(), 0);
  assert.equal(await page.getByText('人格记忆', { exact: true }).count(), 0);
  assert.equal(await page.getByText('纳入整理', { exact: true }).count(), 0);
  await page.waitForTimeout(150);
  assert.equal(app.store.conversation('main-fixture')!.reasoning, 'off');
  const composer = page.locator('.composer'), message = page.getByRole('textbox', { name: '聊天消息', exact: true });
  const initialHeight = (await message.boundingBox())!.height;
  await message.fill(Array.from({ length: 8 }, (_, i) => 'Line ' + i).join('\n'));
  assert((await message.boundingBox())!.height > initialHeight);
  await message.fill('中文输入测试');
  await message.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(mainCalls, 0);
  assert.equal(await message.inputValue(), '中文输入测试');
  await message.fill('');
  await composer.screenshot({ path: join(project, 'test-results/composer-idle.png') });
  await page.setViewportSize({ width: 480, height: 860 });
  const bounds = (await composer.boundingBox())!;
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 480);
  await composer.screenshot({ path: join(project, 'test-results/composer-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '引用项目文件', exact: true }).click();
  await page.locator('.project-reference').waitFor();
  await page.getByLabel('项目文件', { exact: true }).press('Escape');
  assert.equal(await page.locator('.project-reference').count(), 0);
  await page.getByRole('button', { name: '引用项目文件', exact: true }).click();
  await message.click();
  assert.equal(await page.locator('.project-reference').count(), 0);
  await page.getByRole('button', { name: '引用项目文件', exact: true }).click();
  await page.getByLabel('项目文件', { exact: true }).fill(join(workspace, 'README.md'));
  await page.getByRole('button', { name: '附加引用', exact: true }).click();
  const referenceChip = page.locator('.attachment-chip').filter({ hasText: 'README.md' });
  await referenceChip.waitFor();
  await referenceChip.getByRole('button', { name: '移除附件', exact: true }).click();
  assert.equal(await referenceChip.count(), 0);
  await page.locator('input[type=file]').setInputFiles({
    name: 'fixture.md',
    mimeType: 'text/plain',
    buffer: Buffer.from('ATTACHMENT_FACT'),
  });
  await page.locator('.attachment-chip').filter({ hasText: 'fixture.md' }).first().waitFor();
  await page.getByRole('textbox', { name: '聊天消息', exact: true }).fill('Begin');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('Fixture command', { exact: true }).waitFor();
  await page.getByText('Fixture command', { exact: true }).click();
  await page.getByText('Live output before completion', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止执行', exact: true }).waitFor();
  await composer.screenshot({ path: join(project, 'test-results/composer-running.png') });
  await page.getByRole('textbox', { name: '聊天消息', exact: true }).fill('Change the requirement');
  await page.getByLabel('发送方式', { exact: true }).selectOption('steer');
  await page.getByRole('button', { name: '补充指令', exact: true }).click();
  await page.getByText('Finished with your update', { exact: true }).waitFor();
  assert.equal(mainCalls, 1);
  assert.equal(steers, 1);
  await message.fill('Stop the next task');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '停止执行', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(mainCalls, 2);
  await page.getByRole('tab', { name: '任务委派', exact: true }).click();
  await page.getByText('交办项目任务', { exact: true }).click();
  await page.getByLabel('工作目标', { exact: true }).fill('Produce a test result');
  await page.getByLabel('验收要求', { exact: true }).fill('A verified synthetic result');
  await page.getByRole('button', { name: '交办任务', exact: true }).click();
  await page.getByText('Worker result', { exact: true }).waitFor();
  await page.getByLabel('验收意见', { exact: true }).fill('Checked the synthetic evidence');
  await page.getByRole('button', { name: '验收通过', exact: true }).click();
  assert.equal(app.store.documents<any>('delegated-tasks')[0].acceptanceStatus, 'accepted');
  await page.screenshot({ path: join(project, 'test-results/execution-workspace.png') });
  assert.deepEqual(errors, []);
  const result = {
    attachments: true,
    executionTrace: true,
    activeSteering: true,
    singleNativeTurn: true,
    workerCreation: true,
    explicitAcceptance: true,
    compactComposer: true,
    imeSafe: true,
    autoExpandingInput: true,
    projectReferencePopover: true,
    stopControl: true,
  };
  await writeFile(join(project, 'test-results/execution-ui.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: join(project, 'test-results/execution-ui-failure.png') });
  console.log((await page.locator('body').innerText()).slice(-5000));
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
  assert(resolve(workspace).startsWith(resolve(base) + sep));
  await rm(workspace, { recursive: true, force: true });
}
