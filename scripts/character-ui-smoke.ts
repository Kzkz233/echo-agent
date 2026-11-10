import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile, seedRoutes } from './inference-fixture.ts';
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
const generate: import('../packages/contracts/index.ts').Backend['generate'] = async ({
  messages,
}) => {
  if (!messages.at(-1)?.text.includes('Sticker fixture'))
    return { text: 'Synthetic group response' };
  assert.match(messages[0].text, /Fixture prefers playful stickers/);
  assert.equal(messages.at(-1)?.text, 'Sticker fixture');
  return { text: 'Synthetic sticker response\n[ECHO_STICKER:hello]' };
};
for (const kind of ['api', 'pi', 'codex', 'dsh'] as const)
  app.router.backends.set(kind, { kind, generate });
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
  const mainModels = await page.getByLabel('主会话模型', { exact: true }).locator('option').allTextContents();
  assert(!mainModels.some((text) => text.includes('Fixture codex') || text.includes('Fixture dsh') || / · Pi$/.test(text)));
  await page.getByLabel('主会话模型', { exact: true }).selectOption('fixture');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('checkbox', { name: /聊天表情/ }).check();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '创建角色', exact: true }).last().click();
  await page.getByRole('button', { name: '配置角色', exact: true }).waitFor();
  const role = app.store.documents<any>('personas').find((p) => p.name === 'Mira');
  const created = app.store.document<any>('characters', role.id);
  assert(created.mainConversationId && created.state === 'ready');
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  await page.getByRole('button', { name: '角色资料', exact: true }).click();
  assert.equal(await page.getByLabel('角色名称', { exact: true }).inputValue(), 'Mira');
  await page.getByLabel('角色名称', { exact: true }).fill('Mira Updated');
  await page.getByRole('button', { name: '通道与表达', exact: true }).click();
  await page.getByText('表达风格', { exact: true }).click();
  await page.getByLabel('QQ 回复风格', { exact: true }).fill('Fixture mobile style');
  await page.getByLabel('桌宠气泡风格', { exact: true }).fill('Fixture bubble style');
  await page.getByLabel('表情使用偏好', { exact: true }).fill('Fixture prefers playful stickers');
  await page.getByRole('button', { name: '模型与权限', exact: true }).click();
  await page.getByLabel('主会话模型', { exact: true }).selectOption('fixture-pi');
  await page.getByText('工作空间与权限', { exact: true }).click();
  await page.getByText('工具权限', { exact: true }).waitFor();
  await page.getByRole('button', { name: '配置概览', exact: true }).click();
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page
    .locator('.character-home-heading')
    .getByRole('heading', { name: 'Mira Updated', exact: true })
    .waitFor();
  assert.equal(app.store.conversations().filter((c) => c.personaId === role.id).length, 1);
  assert.equal(app.store.binding(created.mainConversationId)?.profileId, 'fixture-pi');
  const expression = {
    external: 'Fixture mobile style',
    bubble: 'Fixture bubble style',
    stickers: 'Fixture prefers playful stickers',
  };
  assert.deepEqual(app.store.document<any>('personas', role.id)?.expression, expression);
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
  await page.getByRole('button', { name: '配置角色', exact: true }).waitFor();
  const avatar = app.store.document<any>('avatar-profiles', role.id);
  assert.equal(avatar.corner, 'left');
  assert.equal(avatar.scale, 1.2);
  assert.equal(avatar.bubbleSeconds, 18);
  assert.equal(avatar.fps, 12);
  await page.getByRole('tab', { name: '聊天表情', exact: true }).click();
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
  await app.router.send({
    conversationId: created.mainConversationId,
    requestId: 'fixture-sticker',
    text: 'Sticker fixture',
  });
  await page.getByRole('tab', { name: '主会话', exact: true }).click();
  await page.getByText('Synthetic sticker response', { exact: true }).waitFor();
  const sticker = page.getByRole('img', { name: 'Fixture hello', exact: true });
  await sticker.waitFor();
  await sticker.evaluate((img: HTMLImageElement) => img.decode());
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
  await page.getByRole('tab', { name: '主会话', exact: true }).click();
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
