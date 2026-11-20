import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { echoToolPermissions } from '../packages/kernel/tool-access.ts';
import { authorizeExecution } from '../plugins/delegation/authorization.ts';
import { executionRequest, settings as delegationPolicy } from '../plugins/delegation/config.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { seedProfile } from './inference-fixture.ts';

const project = resolve(import.meta.dirname, '..');
const app = await Application.create({ project, runtime: await mkdtemp(join(tmpdir(), 'echo-role-tools-')) });
const call = (op: string, args: object) => app.registry.call(op, args, internal);
await app.plugins.enable('browser-use');
await app.plugins.enable('computer-use');
seedProfile(app, profileSchema.parse({ id: 'fixture', kind: 'api', name: 'Fixture', model: 'fixture',
  endpoint: 'http://127.0.0.1:1/v1' }));
await call('persona.character.commit', { requestId: 'create-fixture', draft: characterDraft.parse({
  persona: { id: 'fixture-role', name: 'Fixture', prompt: 'Isolated fixture' }, profileId: 'fixture',
  independentToolGrants: true, toolPermissions: ['knowledge.read', 'offline-fixture.read'],
  features: ['delegation'], configurations: { delegation: { toolPermissions: ['persona.read'] } },
}) });
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${http.port}/?persona=fixture-role#token=${http.token}`);
  const edit = async () => {
    await page.getByRole('button', { name: '配置角色', exact: true }).click();
    await page.getByRole('button', { name: '角色功能', exact: true }).click();
  };
  const grant = (id: string, scope: string) =>
    page.locator(`[data-permission="${id}"]`).getByRole('checkbox', { name: scope, exact: true });
  await edit();
  await page.getByText('尚未配置允许的网站', { exact: true }).waitFor();
  await page.getByText('尚未配置允许的应用', { exact: true }).waitFor();
  await page.getByRole('searchbox', { name: '搜索插件或工具' }).fill('Browser Use');
  assert.equal(await page.locator('[data-permission]').count(), 2);
  await grant('browser-use.read', '主会话').check();
  const popup = page.waitForEvent('popup');
  await page.getByRole('region', { name: '浏览器操作', exact: true }).getByRole('button', { name: '插件设置' }).click();
  const settings = await popup;
  const origins = settings.getByLabel('允许的网站，每行一个 HTTPS 来源', { exact: true });
  await origins.fill('https://fixture.example');
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByRole('region', { name: '浏览器操作', exact: true }).getByText('已配置', { exact: true }).waitFor();
  assert(await grant('browser-use.read', '主会话').isChecked());
  await page.getByRole('searchbox', { name: '搜索插件或工具' }).fill('');
  await page.locator('details').filter({has:page.locator('[data-permission="computer-use.read"]')}).last().locator(':scope > summary').click();
  await grant('computer-use.read', '子任务').check();
  await page.getByRole('button', { name: '模型与权限', exact: true }).click();
  assert.equal(await page.locator('[data-permission]').count(), 0);
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('tab', { name: '聊天', exact: true }).waitFor();
  const saved = await call('persona.character.read', { id: 'fixture-role' });
  assert.deepEqual(saved.toolPermissions.sort(), ['browser-use.read', 'knowledge.read', 'offline-fixture.read']);
  assert.deepEqual(saved.configurations.delegation.toolPermissions.sort(), ['computer-use.read', 'persona.read']);
  const role = app.store.document<{ mainConversationId: string }>('characters', 'fixture-role')!;
  const effective = echoToolPermissions(app.store, false, { personaId: 'fixture-role', conversationId: role.mainConversationId },
    app.plugins.characterPermissions());
  assert(effective.has('browser-use.read') && !effective.has('computer-use.read') && !effective.has('offline-fixture.read'));
  const authorize = (permission: string) => authorizeExecution(app.store, 'fixture-role', 'fixture',
    delegationPolicy.parse(saved.configurations.delegation), executionRequest.parse({ toolPermissions: [permission] }));
  assert.deepEqual((await authorize('computer-use.read')).toolPermissions, ['computer-use.read']);
  await assert.rejects(authorize('browser-use.read'), /子任务请求的工具权限超出角色授权/);
  await page.reload();
  await edit();
  for (const name of ['浏览器操作', 'Windows 桌面操作'])
    await page.getByRole('region',{name,exact:true}).locator('details > summary').click();
  assert(await grant('browser-use.read', '主会话').isChecked());
  assert(!(await grant('browser-use.read', '子任务').isChecked()));
  assert(await grant('computer-use.read', '子任务').isChecked());
  assert(!(await grant('computer-use.read', '主会话').isChecked()));
  await call('settings.save', { pluginId: 'computer-use', value: { applications: 'relative.exe' } });
  const state = await call('system.bootstrap', {});
  assert.equal(state.plugins.find((p: any) => p.id === 'computer-use').toolSetup.missing.length, 1);
  await call('settings.save', { pluginId: 'computer-use', value: { applications: 'C:\\Fixture\\Fixture.exe' } });
  await page.getByRole('region', { name: 'Windows 桌面操作', exact: true }).getByText('已配置', { exact: true }).waitFor();
  await page.getByRole('region', { name: 'DeepSeek 网页搜索', exact: true }).getByRole('button', { name: '配置连接' }).click();
  await settings.getByRole('tab', { name: '外部 MCP', selected: true }).waitFor();
  await settings.getByRole('heading', { name: 'DeepSeek 网页搜索', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: independent grants, hidden grants preserved, plugin settings link, live configuration and persisted selections.');
} finally {
  await browser.close();
  await http.close();
  await app.close();
}
