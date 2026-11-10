import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {setup,temporary,until} from './helpers.ts';
const ui={kind:'ui' as const,permissions:new Set(['*'])};
test('knowledge maintenance is atomic, revision checked, scoped, and keeps managed originals after deletion',async t=>{
 const app=await setup(t),root=await temporary(t);await app.plugins.enable('knowledge');
 const source=join(root,'Original.md');await writeFile(source,'Unique nebula source');const one=await app.knowledge.import('local',source);
 const two=await app.knowledge.save('local','Other','Unique nebula other',{path:'Other/note.md'});
 await assert.rejects(()=>app.registry.call('knowledge.maintain',{vaultId:'local',items:[{id:one.id,revision:one.revision},{id:two.id,revision:999}],action:'move',folder:'Work',confirmed:true},ui),/已变化/);
 assert.equal((await app.knowledge.read(one.id)).logicalPath,undefined);
 await app.registry.call('knowledge.maintain',{vaultId:'local',items:[{id:one.id,revision:one.revision}],action:'move',folder:'Work',confirmed:true},ui);
 const hits=await app.registry.call('knowledge.search',{query:'nebula',folder:'Work',vaultId:'local'},ui);assert.equal(hits.length,1);assert.equal(hits[0].documentId,one.id);assert.equal(hits[0].vaultId,'local');
 const current=await app.knowledge.read(one.id);await app.registry.call('knowledge.maintain',{vaultId:'local',items:[{id:one.id,revision:current.revision}],action:'archive',confirmed:true},ui);
 assert.equal((await app.knowledge.search('nebula',new AbortController().signal)).length,1);
 const archived=await app.knowledge.read(one.id);await app.registry.call('knowledge.maintain',{vaultId:'local',items:[{id:one.id,revision:archived.revision}],action:'delete',confirmed:true},ui);assert.equal((await app.files.records()).length,1);
});
test('durable parsing captures originals, recovers from failure, repairs moved sources and protects producer-owned content',async t=>{
 const app=await setup(t),root=await temporary(t);await app.plugins.enable('knowledge');const source=join(root,'Sample.md');await writeFile(source,'Original content');
 const job=await app.registry.call('knowledge.import-job',{vaultId:'local',source,requestId:'capture'},ui);await until(()=>app.store.document<any>('knowledge-jobs',job.id)?.state==='completed');const doc=await app.knowledge.read(job.documentId);
 assert.equal((await app.registry.call('knowledge.import-job',{vaultId:'local',source,requestId:'capture'},ui)).id,job.id);
 const moved=join(root,'Moved.md');await rename(source,moved);assert.equal((await app.registry.call('knowledge.source',{vaultId:'local',id:doc.id},ui)).state,'missing');
 await app.registry.call('knowledge.rebind',{vaultId:'local',id:doc.id,revision:doc.revision,source:moved},ui);assert.equal((await app.registry.call('knowledge.source',{vaultId:'local',id:doc.id},ui)).state,'current');
 const owned=await app.knowledge.save('local','Generated','Generated',{metadata:{producer:'fixture-producer'}});
 await assert.rejects(()=>app.registry.call('knowledge.save',{vaultId:'local',id:owned.id,title:'Changed',text:'No',revision:owned.revision},ui),/来源页面/);
});
