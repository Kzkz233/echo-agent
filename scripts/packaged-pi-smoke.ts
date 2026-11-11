import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const stage = resolve(process.argv[2] ?? 'dist'), runtime = join(stage, 'runtime');
const temporary = await mkdtemp(join(tmpdir(), 'Echo-packaged-pi-')),
  data = join(temporary, 'data'), project = join(temporary, 'project');
await mkdir(data); await mkdir(project);
await writeFile(join(project, 'README.txt'), 'PACKAGED_PI_NATIVE_OK');
let calls = 0;
const model = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
  let raw = ''; for await (const part of req) raw += part;
  const input = JSON.parse(raw); calls++;
  res.setHeader('Content-Type', 'text/event-stream');
  const frame = (delta: object, finish: string) => res.write('data: ' + JSON.stringify({
    id: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
  if (!input.messages.some((message: any) => message.role === 'tool')) {
    const user = input.messages.find((message: any) => message.role === 'user');
    assert.match(JSON.stringify(user), /\[time: /);
    assert.match(JSON.stringify(user), /sender: user/);
    assert.match(JSON.stringify(user), /current_time: /);
    assert(input.tools.some((tool: any) => tool.function.name === 'read'));
    frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'native-read', type: 'function',
      function: { name: 'read', arguments: '{"path":"README.txt"}' } }] }, 'tool_calls');
  } else {
    assert(JSON.stringify(input.messages).includes('PACKAGED_PI_NATIVE_OK'));
    assert(input.tools.some((tool: any) => tool.function.name === 'echo_respond'));
    frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-final', type: 'function',
      function: { name: 'echo_respond', arguments: JSON.stringify({ targetId: 'core.chat', phase: 'final',
        messages: ['Packaged Pi read successful.'] }) } }] }, 'tool_calls');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
const child = spawn(join(runtime, 'node.exe'), [join(runtime, 'dist/server.mjs')], {
  cwd: runtime, windowsHide: true, env: { ...process.env, ECHO_DATA_DIR: data, ECHO_PROJECT_ROOT: runtime,
  ECHO_WEB_ROOT: join(runtime, 'dist/web'), ECHO_PORT: '0', ECHO_PLUGINS: '' }, stdio: ['ignore', 'ignore', 'pipe'],
});
let hostErrors = '';
child.stderr?.on('data', (value) => { hostErrors = (hostErrors + value.toString()).slice(-4000); });
let connection: any;
const rpc = async (method: string, params: object = {}) => {
  const response = await fetch(connection.url + '/rpc', { method: 'POST', headers: {
    Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).catch((error) => {
      throw Error(method + ': ' + error.message + '\n' + hostErrors, { cause: error }); });
  const value = await response.json() as any; if (value.error) throw Error(value.error.message); return value.result;
};
try {
  for (let i = 0; i < 150 && !connection; i++) {
    connection = await readFile(join(data, 'connection.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    if (child.exitCode !== null) throw Error('Packaged core exited before readiness');
    if (!connection) await new Promise((done) => setTimeout(done, 100));
  }
  assert(connection);
  await rpc('connections.save', { id: 'fixture', name: 'Packaged fixture', adapterId: 'core.pi', config: {
    endpoint: `http://127.0.0.1:${(model.address() as any).port}/v1` } });
  await rpc('profiles.save', { id: 'fixture', name: 'Packaged fixture', connectionId: 'fixture', model: 'fixture', reasoningStyle: 'none' });
  const role = await rpc('persona.character.commit', { requestId: 'create-fixture', draft: {
    persona: { id: 'fixture', name: 'Fixture', prompt: 'Synthetic acceptance' }, profileId: 'fixture',
    permissions: { projectDirectory: project, pi: { tools: 'read' } } } });
  const catalog = await rpc('conversations.toolCatalog', { id: role.mainConversationId });
  assert.equal(catalog.runtime, 'pi'); assert(catalog.tools.some((tool: any) => tool.name === 'read'));
  await rpc('conversations.send', { conversationId: role.mainConversationId, text: 'Read the project fixture', requestId: 'packaged-read' });
  let history: any;
  for (let i = 0; i < 200; i++) {
    history = await rpc('conversations.messages', { id: role.mainConversationId });
    if (history.messages.some((m: any) => m.role === 'assistant')) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert(history.messages.some((message: any) => message.text === 'Packaged Pi read successful.'));
  assert.equal(calls, 2);
  await rpc('plugins.enable',{id:'local-models',enabled:true});
  await rpc('connections.save',{id:'offline',name:'Offline fixture',adapterId:'local-models.onnx',deployment:'local',config:{}});
  await rpc('profiles.save',{id:'offline',name:'Offline fixture',connectionId:'offline',model:'Xenova/bge-small-zh-v1.5',generation:{enabled:false,inputs:['text']},embedding:{enabled:true,inputs:['text'],dimensions:512},options:{allowDownload:false}});
  const embedding=await rpc('embeddings.encode',{modelId:'offline',inputs:[{content:[{type:'text',text:'离线语义检索测试'}]}]});
  assert.equal(embedding.vectors[0].length,512);assert(embedding.vectors[0].every(Number.isFinite));
  console.log(JSON.stringify({ packagedNode: true, bundledPi: true, nativeRead: true, sharedConversation: true, bundledOfflineEmbedding:true, realProviderCalls: 0 }));
} finally {
  const exited = once(child, 'exit');
  if (connection) await rpc('system.shutdown').catch(() => {});
  if (child.exitCode === null) await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
  if (child.exitCode === null) { child.kill(); await exited; }
  model.closeAllConnections(); await new Promise<void>((done) => model.close(() => done()));
  assert(temporary.startsWith(join(tmpdir(), 'Echo-packaged-pi-')));
  await rm(temporary, { recursive: true, force: true });
}
