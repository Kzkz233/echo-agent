import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import { internal } from '../packages/kernel/registry.ts';
import { QqFailure, qqAttempt, networkFailure } from '../plugins/qq/retry.ts';
import{QqGateway}from'../plugins/qq/gateway.ts';

test('QQ network retry is bounded and retains uncertainty from an earlier attempt', async () => {
  let calls = 0,
    waits = 0;
  const signal = new AbortController().signal;
  await assert.rejects(
    qqAttempt(
      async () => {
        calls++;
        throw calls === 1
          ? new QqFailure('RESET', true, true)
          : new QqFailure('REFUSED', true, false);
      },
      signal,
      async (ms) => {
        assert.equal(ms, 2500);
        waits++;
      },
    ),
    (e) => e instanceof QqFailure && e.uncertain,
  );
  assert.equal(calls, 2);
  assert.equal(waits, 1);
  calls = 0;
  await assert.rejects(
    qqAttempt(
      async () => {
        calls++;
        throw new QqFailure('HTTP_503', false, true);
      },
      signal,
      async () => {
        throw Error('Must not retry HTTP');
      },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(networkFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }).retryable, false);
  assert.equal(networkFailure({ cause: { code: 'ETIMEDOUT' } }).uncertain, true);
});
test('a silent QQ heartbeat link is terminated and resumed, and abort releases its timers',async()=>{
 const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const ws=new WebSocketServer({server});let connections=0,timeouts=0;const life=new AbortController();
 ws.on('connection',s=>{connections++;s.send(JSON.stringify({op:10,d:{heartbeat_interval:100}}));s.on('message',data=>{const p=JSON.parse(String(data));if(p.op===2)s.send(JSON.stringify({op:0,t:'READY',s:1,d:{session_id:'session'}}));if(p.op===6)s.send(JSON.stringify({op:0,t:'RESUMED',s:2,d:{}}));/* Deliberately no heartbeat ACK. */});});
 const gateway=new QqGateway({signal:life.signal,appId:'fixture',token:async()=> 'fixture',clearToken:()=>{},url:async()=>`ws://127.0.0.1:${(server.address()as any).port}`,ready:()=>{},disconnected:()=>{},error:e=>{if(e.message==='QQ_HEARTBEAT_ACK_TIMEOUT')timeouts++;},message:async()=>{}});const running=gateway.start();
 try{await until(()=>connections>=2,4000);assert(timeouts>=1);}finally{life.abort();await running;for(const s of ws.clients)s.terminate();await new Promise<void>(r=>ws.close(()=>r()));await new Promise<void>(r=>server.close(()=>r()));}
});

test('channel-origin input generates once, returns only to its source, and never approves an action', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('channels');
  const c = conversation(app),
    fake = new FakeBackend();
  app.router.backends.set('api', fake);
  let presented = 0;
  let scope: any;
  app.plugins.add({
    manifest: {
      id: 'chat-test',
      name: 'Chat Test',
      description: 'Synthetic channel',
      version: '0.2.0',
      dependencies: [],
      permissions: ['channels.adapter', 'channels.receive'],
      settings: [],
      views: [],
    },
    activate: (ctx) => {
      scope = ctx.registry;
      ctx.capabilities.provide('channels.send@1', 'chat-test.channel', 'Synthetic', () => {
        presented++;
        return { state: 'delivered' };
      });
    },
  });
  await app.plugins.enable('chat-test');
  await app.registry.call(
    'channels.bind',
    { adapter: 'chat-test.channel', peer: 'owner', conversationId: c.id },
    internal,
  );
  const input = {
    adapter: 'chat-test.channel',
    peer: 'owner',
    remoteMessageId: 'remote-one',
    text: 'Hello from a channel',
  };
  await Promise.all([
    scope.call('channels.receive', input, internal),
    scope.call('channels.receive', input, internal),
  ]);
  await until(() => presented === 1);
  assert.equal(fake.calls.length, 1);
  assert.equal(app.store.allMessages(c.id).filter((m) => m.role === 'user').length, 1);
  await app.router.send({ conversationId: c.id, requestId: 'web-input', text: 'Hello from web' });
  assert.equal(presented, 1);
  await app.router.send({
    conversationId: c.id,
    requestId: 'observe-input',
    source: 'observation',
    text: 'A synthetic observation',
  });
  assert.equal(presented, 1);
  await assert.rejects(
    app.registry.call(
      'channels.bind',
      { adapter: 'chat-test.channel', peer: 'owner', conversationId: c.id },
      internal,
    ),
    /already/,
  );
  await assert.rejects(app.registry.call('channels.receive', input, internal), /impersonate/);
});

test('official QQ gateway handles a synthetic C2C message and confirmed segments are never replayed', async (t) => {
  const app = await setup(t);
  let socket: WebSocket | undefined,
    ready = false,
    postCount = 0,
    failSecond = true,
    failImage = true,
    uploads = 0;
  const sent: { msg_seq: number; msg_id: string; content?: string; msg_type: number; media?: { file_info: string } }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/app/getAppAccessToken') {
      res.end(JSON.stringify({ access_token: 'fixture-token', expires_in: 7200 }));
      return;
    }
    if (req.url === '/gateway') {
      res.end(
        JSON.stringify({ url: `ws://127.0.0.1:${(server.address() as any).port}/gateway-ws` }),
      );
      return;
    }
    if (req.url?.endsWith('/files')) {
      uploads++;
      assert.equal(body.srv_send_msg, false);
      assert.equal(body.file_type, 1);
      assert(Buffer.from(body.file_data, 'base64').subarray(1, 4).equals(Buffer.from('PNG')));
      res.end(JSON.stringify({ file_info: 'fixture-image', ttl: 120 }));
      return;
    }
    if (req.url?.endsWith('/messages')) {
      postCount++;
      sent.push(body);
      if (body.content?.startsWith('B') && failSecond) {
        failSecond = false;
        res.statusCode = 400;
        res.end('{"code":400}');
      } else if (body.msg_type === 7 && failImage) {
        failImage = false;
        res.statusCode = 400;
        res.end('{"code":400}');
      } else {
        res.setHeader('x-tps-trace-id', 'fixture-trace');
        res.end(JSON.stringify({ id: 'fixture-message-' + postCount }));
      }
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const ws = new WebSocketServer({ server });
  ws.on('connection', (client) => {
    socket = client;
    client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    client.on('message', (bytes) => {
      const p = JSON.parse(String(bytes));
      if (p.op === 2)
        client.send(
          JSON.stringify({
            op: 0,
            t: 'READY',
            s: 1,
            d: { session_id: 'fixture-session', user: { id: 'bot' } },
          }),
        );
      if (p.op === 1) client.send(JSON.stringify({ op: 11, d: null }));
    });
  });
  t.after(async () => {
    for (const s of ws.clients) s.terminate();
    await new Promise<void>((r) => ws.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });
  await app.plugins.enable('qq');
  await app.plugins.enable('chatstick');
  const sharp = (await import('sharp')).default;
  const fixture = await sharp({create:{width:32,height:32,channels:4,background:'#6688cc'}}).png().toBuffer();
  await app.registry.call('chatstick.save', {
    personaId: 'companion', key: 'here', label: 'Fixture sticker', meaning: 'A casual greeting',
    data: fixture.toString('base64'),
  }, internal);
  await app.secrets.set('qq-fixture', 'fixture-secret');
  app.events.subscribe((e) => {
    if (e.type === 'qq.updated' && e.data.state === 'ready') ready = true;
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  await app.registry.call(
    'settings.save',
    {
      pluginId: 'qq',
      value: {
        enabled: true,
        appId: 'fixture-app',
        secretRef: 'qq-fixture',
        apiBase: base,
        tokenBase: base,
      },
    },
    internal,
  );
  try {
    await until(() => ready, 10000);
  } catch {
    throw Error(
      'Gateway not ready: ' + JSON.stringify(await app.registry.call('qq.status', {}, internal)),
    );
  }
  const c = conversation(app, { injection: true }),
    fake = new FakeBackend();
  const persona = app.store.document<any>('personas', c.personaId)!;
  app.store.put('personas', persona.id, { ...persona, expression: {
    external: 'Fixture mobile prose', bubble: 'Fixture bubble prose',
  } });
  fake.responder = async () => ({ text: 'A'.repeat(1500) + 'B'.repeat(100) + '\n[ECHO_STICKER:here]' });
  app.router.backends.set('api', fake);
  const binding = await app.registry.call(
    'channels.bind',
    { adapter: 'qq.bot', peer: 'c2c:fixture-user', conversationId: c.id },
    internal,
  );
  socket!.send(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'inbound-one',
        timestamp: new Date().toISOString(),
        content: 'Synthetic question',
        author: { id: 'fixture-user', user_openid: 'fixture-user' },
      },
    }),
  );
  await until(
    () =>
      app.store
        .documents<any>('channel-outbound')
        .some((r) => r.bindingId === binding.id && r.state === 'failed'),
    10000,
  );
  const row = app.store.documents<any>('channel-outbound').find((r) => r.bindingId === binding.id)!;
  assert.equal(fake.calls.length, 1);
  const guidance = fake.calls[0].messages.find((message) => message.context === 'turn')!.text;
  assert.match(guidance, /本轮通过消息渠道回复/);
  assert.match(guidance, /Fixture mobile prose/);
  assert.doesNotMatch(guidance, /Fixture bubble prose/);
  assert.equal(fake.calls[0].messages.at(-1)!.text, 'Synthetic question');
  assert.equal(app.store.allMessages(c.id).find((message) => message.role === 'user')?.text, 'Synthetic question');
  assert.equal(postCount, 2);
  assert.deepEqual(
    sent.map((s) => s.msg_seq),
    [1, 2],
  );
  assert(sent.every((s) => s.msg_id === 'inbound-one'));
  await app.plugins.disable('chatstick');
  await app.registry.call('channels.retry', { id: row.id, confirmed: true }, internal);
  assert.equal(postCount, 4);
  await app.registry.call('channels.retry', { id: row.id, confirmed: true }, internal);
  assert.equal(postCount, 5);
  assert.deepEqual(
    sent.map((s) => s.msg_seq),
    [1, 2, 2, 3, 3],
  );
  assert.equal(sent.filter((s) => s.content?.startsWith('A')).length, 1);
  assert.equal(uploads, 1);
  assert(sent.slice(-2).every((s) => s.media?.file_info === 'fixture-image' && s.msg_id === 'inbound-one'));
  const reply = app.store.allMessages(c.id).find((message) => message.role === 'assistant');
  assert(reply?.meta.image);
  assert.doesNotMatch(reply.text, /ECHO_STICKER/);
  const complete = app.store.documents<any>('channel-outbound').find((r) => r.id === row.id);
  assert.equal(complete.state, 'delivered');
  assert.equal(complete.receipt.parts[0].traceId, 'fixture-trace');
  await app.plugins.disable('qq');
  assert(app.plugins.active.has('channels'));
  assert.equal(
    (await app.registry.call('channels.list', {}, internal)).adapters.some(
      (a: any) => a.id === 'qq.bot',
    ),
    false,
  );
});
