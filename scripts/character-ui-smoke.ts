import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile, seedRoutes } from './inference-fixture.ts';
import { submitFixtureReplies } from '../tests/helpers.ts';
const project = resolve(import.meta.dirname, '..');
const root = join(tmpdir(), 'EchoTests');
await mkdir(root, { recursive: true });
const runtime = await mkdtemp(join(root, 'characters-ui-'));
const app = await Application.create({ runtime, project });
await app.plugins.enable('reflections');
await app.plugins.enable('chatstick');
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    name: 'Fixture API',
    kind: 'api',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'fixture',
  }),
);
seedRoutes(app, { chat: 'fixture', review: 'fixture' });
seedProfile(app, profileSchema.parse({ id: 'fixture-pi', name: 'Fixture Pi', kind: 'pi', model: 'synthetic' }));
for (const kind of ['codex', 'dsh'] as const) {
  seedProfile(
    app,
    profileSchema.parse({
      id: 'fixture-' + kind,
      name: 'Fixture ' + kind,
      kind,
      model: 'synthetic',
      ...(kind === 'dsh' ? { args: ['--preset', 'sdk-minimal'] } : {}),
    }),
  );
}
const generate: import('../packages/contracts/index.ts').Backend['generate'] = async (request) => {
  const { messages } = request;
  if (messages.at(-1)?.text === 'Bubble fixture')
    return submitFixtureReplies(request, 'Fixture bubble-only reply');
  if (messages.at(-1)?.text === 'Fixture work session input')
    return { text: 'Fixture work session response' };
  if (messages.at(-1)?.text === 'Fixture multipart input') {
    request.respond?.({ targetId: 'core.chat', phase: 'final', messages: ['One bubble.\n\nSame bubble.', 'Second bubble.', 'Third bubble.'] });
    return { text: '' };
  }
  if (!messages.at(-1)?.text.includes('Sticker fixture'))
    return submitFixtureReplies(request, 'Synthetic group response');
  assert.match(messages[0].text, /Fixture prefers playful stickers/);
  assert.equal(messages.at(-1)?.text, 'Sticker fixture');
  return submitFixtureReplies(request, 'Synthetic sticker response\n[ECHO_STICKER:hello]');
};
for (const kind of ['api', 'pi', 'codex', 'dsh'] as const)
  app.router.backends.set(kind, {
    kind,
    generate,
    ...(kind === 'pi' ? { capabilities: app.router.backends.get('pi')?.capabilities } : {}),
  });
// Disabled host plugins must not make unresolved host models reappear as main models.
await app.plugins.disable('worker-codex');
await app.plugins.disable('worker-dsh');
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:' + http.port + '/#token=' + http.token);
  await page.getByRole('button', { name: '创建角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).fill('Mira');
  await page.getByLabel('角色人设', { exact: true }).fill('A fictional character for isolated acceptance.');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('checkbox', { name: /聊天表情/ }).check();
  await page.locator('.setup-capability summary').filter({ hasText: /^聊天表情$/ }).click();
  await page.getByLabel('表情使用偏好', { exact: true }).fill('Fixture sticker draft preference');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  const mainModels = await page.getByLabel('主会话模型', { exact: true }).locator('option').allTextContents();
  assert(!mainModels.some((text) => text.includes('Fixture codex') || text.includes('Fixture dsh') || / · Pi$/.test(text)));
  await page.getByLabel('主会话模型', { exact: true }).selectOption('fixture');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '创建角色', exact: true }).last().click();
  await page.getByRole('tab', { name: '聊天', exact: true }).waitFor();
  const roleTabs = page.getByRole('tablist', { name: '角色能力', exact: true });
  assert.deepEqual((await roleTabs.getByRole('tab').allTextContents()).slice(0, 4), ['聊天', '后台工作会话', '角色资料', '任务']);
  const role = app.store.documents<any>('personas').find((p) => p.name === 'Mira');
  const created = app.store.document<any>('characters', role.id);
  assert(created.mainConversationId && created.state === 'ready');
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page.getByRole('button', { name: '角色资料', exact: true }).click();
  assert.equal(await page.getByLabel('角色名称', { exact: true }).inputValue(), 'Mira');
  await page.getByLabel('角色名称', { exact: true }).fill('Mira Updated');
  await page.getByRole('button', { name: '通道与表达', exact: true }).click();
  const chatStyle = await page.getByLabel('应用对话风格', { exact: true }).inputValue();
  assert(chatStyle.includes('复杂问题'));
  await page.getByLabel('QQ 回复风格', { exact: true }).fill('Fixture mobile style');
  await page.getByLabel('桌宠气泡风格', { exact: true }).fill('Fixture bubble style');
  const inboxStyle = page.getByLabel('通知收件箱 回复风格', { exact: true });
  assert((await inboxStyle.inputValue()).includes('标题写明'));
  await inboxStyle.fill('Fixture inbox style');
  assert.equal(await page.getByLabel('表情使用偏好', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '聊天表情', exact: true }).click();
  assert.equal(await page.getByLabel('表情使用偏好', { exact: true }).inputValue(), 'Fixture sticker draft preference');
  await page.getByLabel('表情使用偏好', { exact: true }).fill('Fixture prefers playful stickers');
  const stickerChannels = page.getByRole('group', { name: '表情投递渠道', exact: true });
  assert.equal(await stickerChannels.getByRole('checkbox', { name: '通知收件箱', exact: true }).isDisabled(), true);
  await stickerChannels.getByRole('checkbox', { name: '桌宠气泡', exact: true }).uncheck();
  await page.getByRole('button', { name: '角色功能', exact: true }).click();
  const stickerFeature = page.getByRole('checkbox', { name: /聊天表情/ });
  await stickerFeature.uncheck();
  assert.equal(await page.getByRole('button', { name: '聊天表情', exact: true }).count(), 0);
  await stickerFeature.check();
  await page.getByRole('button', { name: '聊天表情', exact: true }).click();
  assert.equal(await page.getByLabel('表情使用偏好', { exact: true }).inputValue(), 'Fixture prefers playful stickers');
  await page.getByRole('button', { name: '模型与权限', exact: true }).click();
  await page.getByLabel('主会话模型', { exact: true }).selectOption('fixture-pi');
  await page.getByText('工作目录与文件权限', { exact: true }).click();
  await page.getByLabel('主会话文件访问范围', { exact: true }).waitFor();
  await page.getByRole('button', { name: '配置概览', exact: true }).click();
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page
    .locator('.character-home-heading')
    .getByRole('heading', { name: 'Mira Updated', exact: true })
    .waitFor();
  assert.equal(app.store.conversations().filter((c) => c.personaId === role.id).length, 1);
  assert.equal(app.store.binding(created.mainConversationId)?.profileId, 'fixture-pi');
  const expression = {
    chat: chatStyle,
    external: 'Fixture mobile style',
    bubble: 'Fixture bubble style',
    stickers: 'Fixture prefers playful stickers',
    channels: { 'notifications.inbox': 'Fixture inbox style' },
  };
  assert.deepEqual(app.store.document<any>('personas', role.id)?.expression, expression);
  assert.equal(app.store.document<any>('character-settings.chatstick', role.id)?.channels['avatar.bubble'], false);
  const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
  const pack = await app.registry.call(
    'persona.package.export',
    {
      personaId: role.id,
      packageId: 'fixture-expression',
      version: '1',
    },
    ui,
  );
  const imported = await app.registry.call('persona.package.import', pack, ui);
  assert.deepEqual(imported.draft.persona.expression, expression);
  assert.equal(await page.getByRole('tab', { name: '桌宠展示', exact: true }).count(), 0);
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page.getByRole('button', { name: '外观与桌宠', exact: true }).click();
  await page.locator('label.field').filter({ has: page.getByText('停靠位置', { exact: true }) }).locator('select').selectOption('left');
  await page.getByLabel('桌宠大小', { exact: true }).fill('1.2');
  await page.getByLabel('气泡停留时间（秒）', { exact: true }).fill('18');
  await page.getByLabel('桌宠帧率', { exact: true }).fill('12');
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('tab', { name: '聊天', exact: true }).waitFor();
  const avatar = app.store.document<any>('avatar-profiles', role.id);
  assert.equal(avatar.corner, 'left');
  assert.equal(avatar.scale, 1.2);
  assert.equal(avatar.bubbleSeconds, 18);
  assert.equal(avatar.fps, 12);
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page.getByRole('button', { name: '聊天表情', exact: true }).click();
  assert.equal(await page.getByLabel('表情使用偏好', { exact: true }).inputValue(), expression.stickers);
  await page.getByRole('button', { name: '添加聊天表情', exact: true }).click();
  await page.getByLabel('表情编号', { exact: true }).fill('hello');
  await page.getByLabel('表情名称', { exact: true }).fill('Fixture hello');
  await page.getByLabel('适用语境', { exact: true }).fill('A casual greeting.');
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#bde' } })
    .png()
    .toBuffer();
  await page
    .getByLabel('表情图片', { exact: true })
    .setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('img', { name: 'Fixture hello', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await app.router.send({
    conversationId: created.mainConversationId,
    requestId: 'fixture-sticker',
    text: 'Sticker fixture',
  });
  await app.router.send({
    conversationId: created.mainConversationId,
    requestId: 'fixture-bubble',
    text: 'Bubble fixture',
    bubble: true,
  });
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await page.getByText('Synthetic sticker response', { exact: true }).waitFor();
  const sticker = page.getByRole('img', { name: 'Fixture hello', exact: true });
  await sticker.waitFor();
  await sticker.evaluate((img: HTMLImageElement) => img.decode());
  assert.equal(await page.getByText('Bubble fixture', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Fixture bubble-only reply', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('本会话思考强度').count(), 0);
  assert.equal(await page.getByText('执行过程', { exact: true }).count(), 0);
  const composer = page.getByRole('textbox', { name: '聊天消息', exact: true });
  await composer.fill('Fixture main chat input');
  await page.getByRole('tab', { name: '后台工作会话', exact: true }).click();
  await page.getByText('Bubble fixture', { exact: true }).waitFor();
  await page.getByText('Fixture bubble-only reply', { exact: true }).waitFor();
  await page.getByRole('button', { name: '会话状态与上下文', exact: true }).waitFor();
  await page.getByLabel('查看上下文明细').waitFor();
  await page.getByText('执行过程', { exact: true }).first().waitFor();
  assert.equal(await composer.inputValue(), 'Fixture main chat input');
  assert.equal(await page.locator('.chat-main').getAttribute('data-conversation'), created.mainConversationId);
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await page.getByRole('tab', { name: '聊天', exact: true, selected: true }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('Fixture main chat input', { exact: true }).waitFor();
  assert.equal(await page.locator('.chat-main').getAttribute('data-conversation'), created.mainConversationId);
  const sent = app.store.messages(created.mainConversationId).find((message) => message.text === 'Fixture main chat input');
  assert.equal((sent?.meta.delivery as any)?.targets[0]?.id, 'core.chat');
  await page.getByText('Synthetic group response', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '后台工作会话', exact: true }).click();
  await page.getByText('Fixture main chat input', { exact: true }).waitFor();
  await composer.fill('Fixture work session input');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('Fixture work session response', { exact: true }).waitFor();
  const workReply = app.store.messages(created.mainConversationId).find((message) => message.text === 'Fixture work session response');
  assert.equal(workReply?.meta.workSession, true);
  assert.equal(workReply?.meta.delivery, undefined);
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  assert.equal(await page.getByText('Fixture work session input', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Fixture work session response', { exact: true }).count(), 0);
  await sticker.waitFor();
  const marks = await page.evaluateHandle(() => {
    const times: Record<string, number> = {};
    const observer = new MutationObserver(() => {
      const bubbles = Array.from(document.querySelectorAll('.dialogue-bubble'), (element) => element.textContent ?? '');
      for (const text of ['One bubble.', 'Third bubble.'])
        if (times[text] === undefined && bubbles.some((bubble) => bubble.includes(text))) times[text] = performance.now();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return { times, observer };
  });
  await composer.fill('Fixture multipart input');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const segments = page.locator('.dialogue-delivery').filter({ hasText: 'Third bubble.' });
  await segments.waitFor();
  assert.equal(await segments.locator('.dialogue-bubble').count(), 3);
  assert.match(await segments.locator('.dialogue-bubble').first().innerText(), /One bubble\.[\s\S]*Same bubble\./);
  const interval = await marks.evaluate(({ times, observer }) => {
    observer.disconnect();
    return times['Third bubble.'] - times['One bubble.'];
  });
  await marks.dispose();
  assert(interval >= 1500, 'Live bubbles are spaced out without splitting paragraphs into separate messages');
  await page.screenshot({ path: join(project, 'test-results/dialogue-channel.png') });
  await page.getByRole('button', { name: '创建群聊', exact: true }).click();
  await page.getByRole('button', { name: '创建群聊', exact: true }).last().click();
  await page.getByLabel('群聊名称', { exact: true }).fill('Project room');
  await page.getByRole('checkbox', { name: 'Mira Updated', exact: true }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByPlaceholder('说点什么…').fill('A shared plan');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('Synthetic group response', { exact: true }).waitFor();
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const popup = await popupPromise;
  await popup.getByRole('heading', { name: '扩展', exact: true }).waitFor();
  assert(popup.url().includes('window=settings'));
  await app.plugins.disable('chatstick');
  await page.reload();
  await page
    .locator('aside')
    .getByRole('button', { name: /Mira Updated/ })
    .first()
    .click();
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await sticker.waitFor();
  await sticker.evaluate((img: HTMLImageElement) => img.decode());
  await mkdir(join(project, 'test-results'), { recursive: true });
  await page.screenshot({ path: join(project, 'test-results/character-group.png') });
  assert.deepEqual(errors, []);
  const result = {
    created: true,
    editedSameConfig: true,
    singleMainConversation: true,
    groupReply: true,
    avatarControls: true,
    characterSticker: true,
    roleExpressionSaved: true,
    apiToPiWithoutRenderError: true,
    externalHostsAreWorkerOnly: true,
    roleExpressionRoundTrip: true,
    historicalStickerWithoutPlugin: true,
    separateSettingsWindow: true,
  };
  await writeFile(join(project, 'test-results/character-ui.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify(app.store.documents('characters')));
  console.log(JSON.stringify(app.store.documents('character-drafts')));
  console.log(
    JSON.stringify(
      (await app.automation.catalog(new AbortController().signal)).types.map((type) => ({
        id: type.id,
        items: type.items.map((item) => ({ id: item.id, settings: item.settings })),
      })),
    ),
  );
  console.log((await page.locator('body').innerText()).slice(-5000));
  await page.screenshot({ path: join(project, 'test-results/character-ui-failure.png') });
  throw error;
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
