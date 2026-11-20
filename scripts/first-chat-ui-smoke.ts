import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium, type Browser } from '@playwright/test';

const runtime = resolve(process.argv[2] ?? 'dist/runtime');
const data = await mkdtemp(join(tmpdir(), 'Echo-first-chat-'));
const reply = 'Fresh account delivery verified';
let replies = 0;
const provider = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'isolated-chat' }] }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  assert.equal(input.model, 'isolated-chat');
  assert(input.tools?.some((tool: any) => tool.function?.name === 'echo_respond'));
  replies++;
  const done = input.messages.some((message: any) => message.role === 'tool');
  const delta = done ? { role:'assistant' } : { role: 'assistant', tool_calls: [{ type: 'function', index: 0, id: 'delivery',
    function: { name: 'echo_respond', arguments: JSON.stringify({ targetId:'core.chat', phase:'final', messages:[reply] }) } }] };
  res.writeHead(200, { 'Content-Type':'text/event-stream' });
  res.end('data: '+JSON.stringify({ id:'test',choices:[{ index:0, delta, finish_reason: done ? 'stop' : 'tool_calls' }] })+'\n\ndata: [DONE]\n\n');
});
await new Promise<void>(r => provider.listen(0,'127.0.0.1',r));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ECHO_')));
const child = spawn(join(runtime,'node.exe'),[join(runtime,'dist/server.mjs')],{ cwd:runtime, windowsHide:true, stdio:'ignore', env:{
  ...env, ECHO_DATA_DIR:data,ECHO_PROJECT_ROOT:runtime,ECHO_WEB_ROOT:process.argv[3] ? resolve(process.argv[3]) : join(runtime,'dist/web'),ECHO_NATIVE_PATH:join(runtime,'echo-native.exe'),ECHO_PORT:'0',
}});
let browser: Browser | undefined;
let connection: { url:string; token:string; pid:number } | undefined;
const pause = (ms:number) => new Promise(r=>setTimeout(r,ms));
const rpc = async (method:string, params:object={}) => {
  const response = await fetch(connection!.url+'/rpc',{method:'POST',headers:{authorization:'Bearer '+connection!.token,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const body = await response.json();
  if (body.error) throw Error(method+': '+body.error.message);
  return body.result;
};
try {
  for (let i=0;i<150&&!connection;i++) {
    if (child.exitCode!==null) throw Error('Isolated Echo exited before startup');
    connection=await readFile(join(data,'connection.json'),'utf8').then(JSON.parse).catch(()=>undefined);
    if (!connection) await pause(120);
  }
  assert(connection && connection.pid===child.pid && new URL(connection.url).hostname==='127.0.0.1');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1360,height:880},locale:'zh-CN'});
  page.setDefaultTimeout(12000);
  const go=async (query:string) => {
    await page.goto('about:blank');
    await page.goto(connection!.url+'/?'+query+'#token='+connection!.token,{waitUntil:'domcontentloaded'});
  };
  const responseFor=(method:string)=>page.waitForResponse(res=>res.url().endsWith('/rpc')&&res.request().postDataJSON()?.method===method);
  const original = await rpc('system.bootstrap');
  const originalIds = new Set(original.personas.map((p: any) => p.id));
  await go('');
  await page.getByRole('button',{name:'开始聊天',exact:true}).click();
  await page.getByLabel('服务提供商').selectOption('custom');
  await page.getByLabel('API Base URL').fill('http://127.0.0.1:'+(provider.address() as any).port+'/v1');
  await page.getByRole('button',{name:'读取模型列表',exact:true}).click();
  await page.getByRole('button',{name:'使用此模型',exact:true}).click();
  const box=page.getByRole('textbox',{name:'聊天消息'});
  await box.fill('你好');
  await box.press('Enter');
  await page.getByText(reply,{exact:true}).first().waitFor({timeout:40000});
  const boot=await rpc('system.bootstrap');
  const added = boot.personas.filter((p: any) => !originalIds.has(p.id));
  assert.deepEqual(added.map((p: any) => p.id),['example-hina']);
  assert.equal(boot.groups?.length??0, original.groups?.length??0);
  assert.equal(boot.routes['embeddings.encode'],'echo-bge-small-zh');
  assert(replies>0);
  console.log('Single companion, inline connection, first delivered reply, default BGE: passed');
  const role=added[0].id;
  const before=await rpc('persona.character.read',{id:role});
  await go('persona='+role+'&page=character');
  await page.getByRole('button',{name:'配置角色',exact:true}).click();
  const navigation=page.locator('.role-editor-nav');
  await navigation.getByRole('button',{name:'记忆与资料'}).click();
  const historyBudget = page.getByLabel('参考最近消息数');
  await historyBudget.waitFor({state:'attached'});
  assert.equal(await historyBudget.isVisible(),false);
  await navigation.getByRole('button',{name:'模型与权限'}).first().click();
  const advanced=page.locator('.role-editor-content details').filter({hasText:'压缩触发上限'}).first();
  await advanced.waitFor({state:'attached'});
  assert.equal(await advanced.getAttribute('open'),null);
  await navigation.getByRole('button',{name:/角色资料|基本资料|人设|角色档案/}).first().click();
  await page.getByRole('textbox',{name:'角色名称'}).fill('Hina acceptance');
  const [saved]=await Promise.all([responseFor('persona.character.patch'),page.getByRole('button',{name:'保存角色',exact:true}).click()]);
  assert(!(await saved.json()).error);
  const after=await rpc('persona.character.read',{id:role});
  assert.equal(after.persona.name,'Hina acceptance');
  for(const key of ['permissions','tasks','configurations','features','mcpTools']) assert.deepEqual(after[key],before[key],key);
  await go('workspace=true&page=knowledge');
  await page.getByRole('button',{name:'新建笔记',exact:true}).click();
  await page.getByRole('textbox',{name:'知识标题'}).fill('图书馆预约');
  await page.getByRole('textbox',{name:'知识正文'}).fill('星期六到图书馆取书。');
  const [note]=await Promise.all([responseFor('knowledge.save'),page.getByRole('button',{name:'保存正文',exact:true}).click()]);
  assert(!(await note.json()).error);
  await page.getByRole('textbox',{name:'知识检索词'}).fill('图书馆');
  const [search]=await Promise.all([responseFor('knowledge.searchAdvanced'),page.getByRole('button',{name:'检索',exact:true}).click()]);
  assert.equal(search.request().postDataJSON().params.strategy,'hybrid');
  assert((await search.json()).result.length>0);
  const emb=await rpc('embeddings.encode',{modelId:'echo-bge-small-zh',inputs:[{content:[{type:'text',text:'取书'}]}]});
  assert.equal(emb.vectors[0].length,512);
  console.log('Collapsed settings preserved, new note found, bundled CPU encoder returned 512 dimensions: passed');
} finally {
  await browser?.close();
  if (connection) await rpc('system.shutdown').catch(()=>{});
  for(let i=0;i<50&&child.exitCode===null;i++) await pause(100);
  if(child.exitCode===null) child.kill();
  provider.closeAllConnections();
  await new Promise<void>(done=>provider.close(()=>done()));
  assert(resolve(data).startsWith(resolve(tmpdir())+sep+'Echo-first-chat-'));
  await rm(data,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  await rm(data+'-workspaces',{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
