import { version } from '../packages/contracts/version.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
test('an extension calls the shared registry through permission-checked stdio', async (t) => {
  const app = await setup(t),
    directory = join(app.runtime, 'extension-call');
  await mkdir(directory);
  await writeFile(
    join(directory, 'echo-plugin.json'),
    JSON.stringify({
      apiVersion: 1,
      id: 'cross',
      name: 'Cross',
      description: 'Fixture',
      version: '0.1.0',
      dependencies: [],
      permissions: ['cross.read', 'system.read'],
      command: process.execPath,
      args: ['extension.mjs'],
    }),
  );
  await writeFile(
    join(directory, 'extension.mjs'),
    `import readline from 'node:readline';let caller;for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);const send=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));if(m.method==='echo/initialize')send(m.id,{operations:[{name:'cross.status',description:'fixture',inputSchema:{type:'object'},permission:'cross.read'}]});else if(m.method==='echo/invoke'){caller=m.id;console.log(JSON.stringify({jsonrpc:'2.0',id:'read-status',method:'echo/call',params:{name:'system.status',input:{}}}));}else if(m.id==='read-status'){send(caller,{version:m.result?.version});}}`,
  );
  await app.extensions.install(directory, true);
  await app.plugins.enable('cross');
  assert.deepEqual(await app.registry.call('cross.status', {}, internal), { version });
});
test('a third-party process contributes a typed Review source without a Review dependency', async (t) => {
  const app = await setup(t),
    directory = join(app.runtime, 'extension-source');
  await mkdir(directory);
  await writeFile(
    join(directory, 'echo-plugin.json'),
    JSON.stringify({
      apiVersion: 1,
      id: 'fixture',
      name: 'Fixture source',
      description: 'Synthetic source',
      version: '1',
      permissions: ['review.contribute'],
      command: process.execPath,
      args: ['extension.mjs'],
    }),
  );
  await writeFile(
    join(directory, 'extension.mjs'),
    `import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);let result;if(m.method==='echo/initialize')result={providers:[{point:'review.materials@1',id:'fixture.source',label:'Fixture source'}]};else if(m.method==='echo/provide')result=[{id:'synthetic-material',personaId:m.params.input.personaId,text:'Synthetic event',timestamp:'2026-01-01T00:00:00Z'}];else continue;console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));}`,
  );
  await app.extensions.install(directory, true);
  await app.plugins.enable('fixture');
  assert.equal(app.materials.entries.has('fixture.source'), true);
  assert.equal((await app.reviews.collect('companion')).length, 0);
  app.store.set('review.config', { sourceIds: ['fixture.source'] });
  assert.equal((await app.reviews.collect('companion'))[0].text, 'Synthetic event');
  await app.plugins.disable('fixture');
  assert.equal(app.materials.entries.has('fixture.source'), false);
  assert.equal(app.plugins.active.has('review'), true);
});
