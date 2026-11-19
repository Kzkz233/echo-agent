import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Application} from '../apps/server/application.ts';
import {browserPlugin} from '../plugins/browser-use/index.ts';
import type {Caller} from '../packages/kernel/registry.ts';

const fixture=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Fixture</title><input aria-label="Name"><button onclick="document.querySelector(\'main\').textContent=document.querySelector(\'input\').value">Show</button><main></main>');});
await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const address=fixture.address();assert(address && typeof address==='object');
const app=await Application.create({runtime:await mkdtemp(join(tmpdir(),'echo-browser-')),project:resolve(import.meta.dirname,'..'),plugins:[]});
try{
  app.plugins.plugins.set('browser-use',browserPlugin(app.store,app.router.attachments,route=>route.fetch({url:'http://127.0.0.1:'+address.port,maxRedirects:0,timeout:3000})));
  await app.plugins.enable('browser-use');
  app.store.set('browser-use.config',{origins:'https://reader.example.invalid',channel:'msedge'});
  const caller:Caller={kind:'mcp',conversationId:'synthetic',permissions:new Set(['browser-use.read','browser-use.interact'])};
  const call=(method:string,args:any,c=caller)=>app.registry.call('browser-use.'+method,args,c) as Promise<any>;
  const first=await call('open',{url:'https://reader.example.invalid/'});
  const input=first.elements.find((e:any)=>e.name==='Name');assert.ok(input);
  await assert.rejects(call('act',{action:'fill',ref:input.ref,text:'sample'},{...caller,conversationId:'other'}));
  const second=await call('act',{action:'fill',ref:input.ref,text:'sample'});
  await assert.rejects(call('act',{action:'fill',ref:input.ref,text:'stale'}));
  const btn=second.elements.find((e:any)=>e.name==='Show');
  const third=await call('act',{action:'click',ref:btn.ref});assert.match(third.text,/sample/);
  console.log('Headless Edge fixture passed: open, inspect, fill, click, stale reference and conversation isolation.');
}finally{await app.close();await new Promise<void>(r=>fixture.close(()=>r()));}