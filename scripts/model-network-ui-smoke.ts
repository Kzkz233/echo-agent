import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { seedProfile } from './inference-fixture.ts';

const project = resolve(import.meta.dirname, '..');
const runtime = await mkdtemp(join(tmpdir(), 'echo-model-network-'));
const app = await Application.create({project, runtime, plugins:[]});
const calls: string[] = [];
const upstream = createServer((req, res) => {
  calls.push(req.method + ' ' + req.url);
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({data:[{id:'mock-model'}]}));
});
await new Promise<void>(resolve => upstream.listen(0,'127.0.0.1',resolve));
seedProfile(app, profileSchema.parse({id:'mock', name:'Catalog fixture', kind:'api', model:'mock-model', endpoint:
  'http://127.0.0.1:' + (upstream.address() as {port:number}).port + '/v1'}));
seedProfile(app, profileSchema.parse({id:'mock-pi',name:'Pi fixture',kind:'pi',model:'mock-model',endpoint:
  'http://127.0.0.1:' + (upstream.address() as {port:number}).port + '/v1'}));
const http = await serve(app, {webRoot:join(project,'dist/web')});
const browser = await chromium.launch({channel:'msedge', headless:true});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + http.port + '/?window=settings&page=general#token=' + http.token);
  const mode = page.getByRole('combobox', {name:'模型连接方式', exact:true});
  await expect(mode).toBeEnabled();
  await expect(mode).toHaveValue('system');
  await mode.selectOption('manual');
  const address = page.getByRole('textbox', {name:'代理地址'});
  const save = page.getByRole('button', {name:'保存设置',exact:true});
  await address.fill('socks://invalid.example');
  await expect(save).toBeDisabled();
  await address.fill('http://127.0.0.1:18900');
  await save.click();
  await expect(page.getByText('已保存，下次请求生效。')).toBeVisible();
  await page.reload();
  await expect(mode).toHaveValue('manual');
  await expect(address).toHaveValue('http://127.0.0.1:18900');
  await page.getByRole('button',{name:'测试连接',exact:true}).click();
  await expect(page.getByText('模型目录连接成功。')).toBeVisible();
  await page.getByRole('combobox',{name:'验证模型服务'}).selectOption('mock-pi');
  await page.getByRole('button',{name:'测试连接',exact:true}).click();
  await expect(page.getByText('模型目录连接成功。')).toBeVisible();
  assert.deepEqual(calls,['GET /v1/models','GET /v1/models']);
  await mode.selectOption('direct');
  await save.click();
  await expect(page.getByText('已保存，下次请求生效。')).toBeVisible();
  const saved = await app.registry.call('network.settings',{},internal);
  assert.deepEqual(saved,{mode:'direct'});
  await assert.rejects(app.registry.call('network.save',{expected:{mode:'system'},settings:{mode:'manual',proxy:'http://localhost:18000'}},internal));
  assert(!app.registry.list(internal,true).some(tool => tool.name === 'network.save'));
  // Re-enter General in a desktop-shaped test window. The system registry is
  // covered separately by a native fixture using a temporary registry subtree.
  await page.goto('http://127.0.0.1:' + http.port + '/?window=settings&page=general#token=' + http.token);
  await expect(page.getByRole('combobox', {name:'模型连接方式',exact:true})).toBeEnabled();
  await page.locator('[data-section="appearance"]').click();
  let startupState = 'off';
  const writes:boolean[] = [];
  await page.exposeFunction('startupFixture', (op:string,args?:{enabled?:boolean}) => {
    if (op !== 'login_startup') return;
    if (typeof args?.enabled === 'boolean') {
      writes.push(args.enabled);
      startupState = args.enabled ? 'on' : 'off';
    }
    return startupState;
  });
  await page.evaluate(() => { (window as any).__TAURI_INTERNALS__ = {invoke:(window as any).startupFixture}; });
  await page.locator('[data-section="general"]').click();
  const startup=page.getByRole('checkbox',{name:'登录 Windows 后启动 Echo'});
  await expect(startup).toBeEnabled(); await expect(startup).not.toBeChecked();
  assert.deepEqual(writes,[]);
  await startup.click(); await expect(startup).toBeChecked();
  await startup.click(); await expect(startup).not.toBeChecked();
  assert.deepEqual(writes,[true,false]);
  assert.deepEqual(errors,[]);
  console.log('Settings navigation, defaults, validation, persisted modes, local bypass, authenticated RPC scope and stale-edit protection passed.');
} finally {
  await browser.close(); await http.close(); await app.close(); upstream.close();
}
