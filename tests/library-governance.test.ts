import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {backup} from 'node:sqlite';
import {setup} from './helpers.ts';
const ui={kind:'ui' as const,permissions:new Set(['*'])};

test('plugin-owned memory libraries block generic edits and remain protected after the owner unloads',async t=>{
 const app=await setup(t);const memory=await app.memories.save({personaId:'companion',title:'A fact',text:'A synthetic fact',core:false,tags:[],sources:[]});
 const vault=app.files.roots().find(v=>v.owner==='memory')!;assert.equal(vault.writePolicy,'plugin');
 const doc=(await app.knowledge.list(vault.id))[0];
 await assert.rejects(app.registry.call('knowledge.save',{vaultId:vault.id,id:doc.id,title:'Bypass',text:'Changed',revision:doc.revision,writer:'memory'},ui),/所属插件/);
 await assert.rejects(app.registry.call('knowledge.save',{vaultId:vault.id,title:'New',text:'Bypass'},ui),/所属插件/);
 await assert.rejects(app.registry.call('knowledge.maintain',{vaultId:vault.id,items:[{id:doc.id,revision:doc.revision}],action:'delete',confirmed:true},ui),/所属插件/);
 const path=join(app.runtime,'fixture.txt');await writeFile(path,'fixture');
 await assert.rejects(app.registry.call('files.import',{vaultId:vault.id,source:path},ui),/所属插件/);
 await assert.rejects(app.registry.call('files.register',{...vault,name:'Bypass',owner:''},ui),/所属插件/);
 await app.plugins.disable('memory');
 assert.match((await app.knowledge.read(doc.id,0,12000,vault.id)).content,/synthetic fact/);
 await assert.rejects(app.registry.call('knowledge.save',{vaultId:vault.id,title:'New',text:'Bypass'},ui),/所属插件/);
 assert.equal(app.store.document<any>('memories',memory.id)?.text,'A synthetic fact');
 const copy=join(app.runtime,'copied-managed');await mkdir(copy);await backup((await app.files.database(vault.id)).db,join(copy,'library.sqlite'));
 const registered=await app.files.register({id:'copy',name:'Copy',path:copy});assert.equal(registered.owner,'memory');
 await assert.rejects(app.knowledge.save('copy','New','Bypass'),/所属插件/);
});

test('library declaration derives ownership from the caller rather than submitted fields',async t=>{
 const app=await setup(t);await assert.rejects(app.registry.call('files.declare',{name:'Owned',pluginId:'memory'},ui),/调用插件身份/);
 const caller={kind:'extension' as const,pluginId:'example',permissions:new Set(['files.declare','knowledge.write'])};
 const vault=await app.registry.call('files.declare',{name:'Owned',owner:'memory'},caller);assert.equal(vault.owner,'example');
 const doc=await app.registry.call('knowledge.save',{vaultId:vault.id,title:'Example',text:'Owned'},caller);
 assert.equal(doc.metadata.producer,'example');
 await assert.rejects(app.registry.call('knowledge.save',{vaultId:vault.id,id:doc.id,title:'Intruder',text:'No',revision:doc.revision},{...caller,pluginId:'other'}),/所属插件/);
 const normal=await app.knowledge.save('local','Ordinary','Editable');
 await app.registry.call('knowledge.save',{vaultId:'local',id:normal.id,title:'Ordinary',text:'Edited',revision:normal.revision},ui);
 assert.equal((await app.knowledge.read(normal.id)).content,'Edited');
});

test('file browsing is scoped and paginated, while point lookup does not enumerate every file',async t=>{
 const app=await setup(t);const file=join(app.runtime,'source.txt');await writeFile(file,'one');const original=await app.files.import('local',file);
 (app.files as any).records=()=>{throw Error('Full enumeration is forbidden in point lookup');};
 assert.equal((await app.files.record(original.id))?.hash,original.hash);
 const db=await app.files.database('local');db.transaction(()=>{for(let n=0;n<230;n++)db.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run('file-'+n,`file-${String(n).padStart(3,'0')}.txt`,'derived',original.hash,null,new Date().toISOString(),1);});
 const page=await app.registry.call('files.list',{vaultId:'local',kind:'derived',offset:200,limit:20},ui);
 assert.equal(page.total,230);assert.equal(page.items.length,20);assert.equal(page.items[0].name,'file-200.txt');
 const sources=await app.registry.call('files.list',{vaultId:'local'},ui);assert.equal(sources.total,1);
});
