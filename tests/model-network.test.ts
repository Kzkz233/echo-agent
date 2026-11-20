import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { networkSettings, type NetworkSettings } from '../packages/contracts/network-settings.ts';
import { createModelNetwork, windowsModelFetch } from '../packages/backends/model-network.ts';

test('concurrent model and summary requests share the Windows route without exposing their paths or keys', async () => {
  let lookups = 0;
  const fetcher = windowsModelFetch(async destination => {
    assert.equal(destination, 'https://provider.example/');
    lookups++;
    return 'http://127.0.0.1:9988';
  }, async (_input, init) => {
    assert.ok(init && 'dispatcher' in init);
    return new Response('ok');
  });
  await Promise.all(['/models', '/responses?key=fixture'].map(path => fetcher('https://provider.example' + path)));
  assert.equal(lookups, 1);
});

test('direct, bypass and failed PAC decisions remain distinct, and cancellation does not send a request', async () => {
  let calls = 0, lookups = 0;
  let ready!: () => void;
  const fetcher = windowsModelFetch(async target => {
    lookups++;
    if (target.includes('wait.example')) await new Promise<void>(resolve => {ready = resolve;});
    if (target.includes('retry.example') && lookups === 2) throw Error('fixture resolution failed');
    return undefined;
  }, async (_input, init) => {
    assert.ok(!init || !('dispatcher' in init));
    calls++;
    return new Response();
  });
  for (const target of ['http://localhost', 'http://127.0.0.2', 'http://[::1]']) await fetcher(target);
  assert.equal(lookups, 0);
  await fetcher('https://direct.example');
  await assert.rejects(fetcher('https://retry.example'), /fixture resolution failed/);
  await fetcher('https://retry.example');
  const controller = new AbortController();
  const cancelled = fetcher('https://wait.example', { method: 'POST', body: 'fixture', signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  ready();
  await fetcher('https://wait.example');
  assert.equal(calls, 6);
  assert.equal(lookups, 4);
});

test('model traffic reaches a mock upstream only through the system-selected HTTP proxy', async t => {
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture');
    res.end('fixture response');
  });
  const proxy = createServer();
  let tunnels = 0;
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as {port:number}).port;
  proxy.on('connect', (req, socket, head) => {
    assert.equal(req.url, 'model-fixture.invalid:80');
    tunnels++;
    const remote = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
    socket.on('close', () => remote.destroy());
    remote.on('error', () => socket.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const fetcher = windowsModelFetch(async () => 'http://127.0.0.1:' + (proxy.address() as {port:number}).port);
  const response = await fetcher('http://model-fixture.invalid/v1/responses', {
    method: 'POST', headers: {authorization:'Bearer fixture', connection:'close'}, body:'synthetic summary', redirect:'error',
  });
  assert.equal(await response.text(), 'fixture response');
  assert.equal(tunnels, 1);

  const address = 'http://127.0.0.1:' + (proxy.address() as {port:number}).port;
  let config: NetworkSettings = {mode:'manual', proxy:address};
  const network = createModelNetwork(() => config);
  t.after(() => network.close());
  const headers = {authorization:'Bearer fixture', connection:'close'};
  assert.equal(await (await network.fetch('http://model-fixture.invalid/models', {headers})).text(), 'fixture response');
  assert.equal(await (await network.fetch('http://127.0.0.1:' + port + '/models', {headers})).text(), 'fixture response');
  assert.equal(tunnels, 2);
  config = {mode:'direct'};
  await assert.rejects(network.fetch('http://model-fixture.invalid/models', {headers,signal:AbortSignal.timeout(8000)}));
  assert.equal(tunnels, 2);
});

test('manual model proxy settings validate host, protocol, and port without storing credentials', () => {
  for (const proxy of ['https://proxy.example:8443/', 'http://127.0.0.1:7890']) {
    assert.deepEqual(networkSettings.parse({mode:'manual',proxy}), {mode:'manual',proxy:new URL(proxy).origin});
  }
  for (const proxy of ['file:///tmp/test','not a proxy','http://user:password@proxy.example','http://server:0','http://server/path','https://server/?secret=x']) {
    assert.equal(networkSettings.safeParse({mode:'manual',proxy}).success,false);
  }
});

test('the next user request rechecks a changed PAC route after a network failure without replaying the original', async () => {
  let lookups = 0, sent = 0;
  const fetcher = windowsModelFetch(async () => ++lookups === 1 ? undefined : 'http://127.0.0.1:12345',
    async (_url, init) => {
      sent++;
      if (!init || !('dispatcher' in init)) throw new TypeError('fixture network down');
      return new Response('ok');
    });
  await assert.rejects(fetcher('https://fixture.example/v1/responses', {method:'POST'}));
  assert.equal(sent, 1);
  assert.equal(await (await fetcher('https://fixture.example/v1/models')).text(), 'ok');
  assert.equal(lookups, 2);
});
