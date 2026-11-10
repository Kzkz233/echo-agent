import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { seedProfile } from './inference-fixture.ts';

const project = resolve(import.meta.dirname, '..'), base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'product-ui-'));
let generations = 0;
const upstream = createServer((request, response) => {
  if (request.url !== '/v1/models') { generations++; response.writeHead(400).end(); return; }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ data: [{ id: 'fixture-language', object: 'model' }, { id: 'fixture-vision', object: 'model' }] }));
});
await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
const app = await Application.create({ runtime, project });
await app.plugins.enable('worker-dsh'); await app.plugins.enable('documents');
await app.plugins.enable('embeddings'); await app.plugins.enable('semantic');
await app.plugins.enable('mail');
app.store.put('mail-accounts', 'fixture-inbox', { id: 'fixture-inbox', name: 'Fixture inbox' });
seedProfile(app, profileSchema.parse({ id: 'main', name: 'Main language', kind: 'api', endpoint, model: 'fixture-language', vision: true }));
app.store.put('profiles', 'main', { ...app.store.document<any>('profiles', 'main'), embedding: { enabled: false, inputs: ['text'] } });
seedProfile(app, profileSchema.parse({ id: 'worker', name: 'DSH task', kind: 'dsh', model: 'fixture-worker' }));
app.router.backends.set('dsh', { kind: 'dsh', generate: async () => { throw Error('No inference in UI acceptance'); },
  listModels: async () => [{ id: 'fixture-worker', label: 'Fixture worker' }] });
await app.router.inference.refresh();
await app.registry.call('persona.character.commit', { requestId: 'create', draft: characterDraft.parse({
  persona: { id: 'mira', name: 'Mira', prompt: 'Synthetic original persona, preserved exactly.' }, profileId: 'main',
  features: ['memory', 'observation', 'review', 'delegation', 'mail'], configurations: { delegation: {
    templates: [{ id: 'default-worker', name: 'Default task worker', profileId: '' }],
  } }, tasks: [{ id: 'watch', type: 'observation.tasks', settings: { name: 'Watch fixture', enabled: false, personaId: 'mira' } }],
}) }, internal);
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${http.port}/?persona=mira#token=${http.token}`);
  await page.getByRole('button', { name: '配置角色', exact: true }).click();
  assert.equal(await page.locator('.wizard-steps').count(), 0);
  await page.getByLabel('角色人设', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('角色人设', { exact: true }).inputValue(), 'Synthetic original persona, preserved exactly.');
  const sharp=(await import('sharp')).default;
  await page.getByLabel('头像图片',{exact:true}).setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:await sharp({create:{width:48,height:80,channels:4,background:'#4466ee'}}).png().toBuffer()});
  await page.locator('img.portrait-preview').waitFor();
  await page.getByRole('button', { name: '模型与权限', exact: true }).click();
  const options = await page.getByLabel('主会话模型', { exact: true }).locator('option').allTextContents();
  assert(options.some((name) => name.includes('fixture-language')));
  assert(!options.some((name) => /Pi|fixture-worker|Embedded/.test(name)));
  await page.screenshot({ path: join(project, 'test-results/product-role-editor.png') });
  await page.getByRole('button', { name: '通道与表达', exact: true }).click();
  await page.getByRole('heading', { name: '添加通道绑定', exact: true }).waitFor();
  assert.equal(await page.getByLabel('目标会话', { exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(project, 'test-results/product-role-channels.png') });
  await page.getByRole('button', { name: '工具与委派', exact: true }).click();
  const worker = page.locator('[data-role-feature="delegation"]');
  assert.equal(await worker.getByLabel('任务执行器', { exact: true }).count(), 0);
  await worker.getByRole('checkbox', { name: 'DSH task', exact: true }).check();
  await page.locator('[data-role-feature="mail"]').getByRole('checkbox', { name: 'Fixture inbox', exact: true }).check();
  assert.equal(await worker.getByRole('checkbox', { name: 'Main language', exact: true }).count(), 0);
  await page.getByRole('button', { name: '自动化任务', exact: true }).last().click();
  const task = page.locator('.task-configuration');
  await task.getByLabel('视觉模型', { exact: true }).selectOption('main');
  await task.getByRole('checkbox', { name: '启用任务', exact: true }).check();
  await page.getByRole('button', { name: '启用能力', exact: true }).click();
  await page.getByRole('checkbox', { name: /实时观察/ }).uncheck();
  await page.getByRole('button', { name: '自动化任务', exact: true }).last().click();
  assert.equal(await task.getByRole('checkbox', { name: '启用任务', exact: true }).isChecked(), false);
  assert.equal(await task.getByRole('checkbox', { name: '启用任务', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '启用能力', exact: true }).click();
  await page.getByRole('checkbox', { name: /实时观察/ }).check();
  await page.getByRole('button', { name: '自动化任务', exact: true }).last().click();
  assert.equal(await task.getByRole('checkbox', { name: '启用任务', exact: true }).isChecked(), true);
  await task.getByRole('checkbox', { name: '启用任务', exact: true }).uncheck();
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: '配置角色', exact: true }).waitFor();
  assert.equal(app.observations.configurations().find((task) => task.id === 'watch')!.visionProfileId, 'main');
  assert.equal(app.observations.configurations().find((task) => task.id === 'watch')!.enabled, false);
  assert.deepEqual(app.store.document('character-settings.mail', 'mira'), { accountIds: ['fixture-inbox'] });

  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('heading', { name: '任务', exact: true }).waitFor();
  await page.getByRole('tab', { name: '自动化', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '聊天表情', exact: true }).count(), 0);
  await page.getByRole('button', { name: '添加自动化', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.locator('.task-type-grid button').filter({ hasText: '记忆整理' }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('Short review');
  await page.getByRole('button', { name: '预览整理指引', exact: true }).click();
  await page.locator('.task-prompt-preview pre').waitFor();
  assert((await page.locator('.task-prompt-preview pre').innerText()).includes('Synthetic original persona'));
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.locator('.task-type-grid button').filter({ hasText: '记忆整理' }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('Long review');
  await page.screenshot({ path: join(project, 'test-results/tasks-role-editor.png') });
  await page.getByRole('button', { name: '保存角色', exact: true }).click();
  await page.getByRole('button', { name: '配置角色', exact: true }).waitFor();
  assert.equal(app.reviews.tasks().filter((task) => task.personaId === 'mira').length,2);
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  await page.getByRole('tab', { name: '自动化', exact: true }).click();
  await page.locator('.task-record').filter({hasText:'Long review'}).waitFor();
  await page.screenshot({ path: join(project, 'test-results/tasks-current.png') });
  await page.getByRole('tab', { name: '子任务', exact: true }).click();
  await page.getByRole('tab', { name: '非活跃', exact: true }).click();
  await page.getByText('暂无非活跃子任务', { exact:true }).waitFor();
  await page.getByRole('tab', { name: '主会话', exact: true }).click();

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = await popupPromise;
  settings.on('pageerror', (error) => errors.push(error.message));
  await settings.getByRole('heading', { name: '扩展', exact: true }).waitFor();
  await settings.locator('[data-plugin="mail"]').click();
  await settings.getByLabel('整理时回看天数（已读正文始终可纳入）', { exact: true }).waitFor();
  assert.equal(await settings.getByText('邮件提醒规则', { exact: true }).count(), 0);
  await settings.locator('[data-plugin="worker-dsh"]').click();
  await settings.getByRole('heading', { name: '执行配置', exact: true }).waitFor();
  assert.equal(await settings.locator('.service-card').count(), 1);
  await settings.locator('[data-plugin="clock"]').click();
  await settings.getByRole('heading', { name: '时钟', exact: true }).waitFor();
  assert.equal(await settings.locator('.plugin-details').getByRole('button', { name: '停用', exact: true }).count(), 0);
  await settings.locator('[data-plugin="storage"]').click();
  await settings.getByLabel('当前数据目录', { exact: true }).waitFor();
  await settings.locator('[data-plugin="knowledge"]').click();
  await settings.getByLabel('解析提供方', { exact: true }).waitFor();
  await settings.screenshot({ path: join(project, 'test-results/product-documents.png') });
  await settings.locator('nav [data-section="connections"]').click();
  await settings.getByRole('heading', { name: '模型服务', exact: true }).first().waitFor();
  await settings.getByRole('tab', { name: '语义索引模型', exact: true }).click();
  assert(!(await settings.locator('.service-workspace').innerText()).includes('fixture-language'));
  await settings.getByRole('tab', { name: '重排模型', exact: true }).click();
  assert(!(await settings.locator('.service-workspace').innerText()).includes('fixture-language'));
  await settings.getByRole('tab', { name: '语言与视觉模型', exact: true }).click();
  assert.equal(await settings.locator('[data-inference-tab]').count(), 0);
  assert.equal(await settings.getByLabel('接入器', { exact: true }).count(), 0);
  assert(!(await settings.locator('.service-workspace').innerText()).includes('fixture-worker'));
  await settings.getByRole('button', { name: '添加服务', exact: true }).click();
  await settings.getByLabel('服务名称', { exact: true }).fill('Local fixture');
  await settings.getByLabel('API Base URL', { exact: true }).fill(endpoint);
  await settings.getByRole('button', { name: '保存服务', exact: true }).click();
  await settings.getByRole('button', { name: '选择可用模型', exact: true }).click();
  await settings.getByLabel('API 模型', { exact: true }).selectOption('fixture-vision');
  await settings.getByLabel('模型配置名称', { exact: true }).fill('Vision fixture');
  await settings.getByRole('button', { name: '保存模型', exact: true }).click();
  await settings.waitForTimeout(200);
  assert(app.router.inference.models().some((model) => model.model === 'fixture-vision'));
  await settings.screenshot({ path: join(project, 'test-results/product-model-services.png') });
  await settings.setViewportSize({ width: 900, height: 800 });
  await settings.screenshot({ path: join(project, 'test-results/product-model-services-narrow.png') });
  assert.deepEqual(errors, []);
  assert.equal(generations, 0);
  const result = { roleCategories: true, canonicalConfiguration: true, taskModelChoice: true,
    builtinWorkerDefault: true, registeredExternalWorkers: true, pluginOwnedServices: true,
    serviceAndModelWorkflow: true, noEmbeddedRuntimeChoice: true, originalPersonaPreserved: true,
    mailboxGrantsAndRuleOrder: true, noInferenceRequests: true, pageErrors: 0 };
  await writeFile(join(project, 'test-results/product-ui.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  for (const [index, current] of browser.contexts().flatMap((context) => context.pages()).entries()) {
    await current.screenshot({ path: join(project, `test-results/product-ui-failure-${index}.png`) });
    console.log((await current.locator('body').innerText()).slice(-4500));
  }
  throw error;
} finally {
  await browser.close(); await http.close(); await app.close();
  await new Promise<void>((done) => upstream.close(() => done()));
}
