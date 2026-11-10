import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Capabilities, type CapabilityOwner } from '../packages/kernel/capabilities.ts';
import { Registry, PluginManager } from '../packages/kernel/registry.ts';
const owner = (id: string, permissions = ['*']): CapabilityOwner => ({
  id,
  permissions: new Set(permissions),
  signal: new AbortController().signal,
});
const contract = {
  id: 'weather.forecasts@1',
  description: 'A plugin-defined contract, unrelated to built-in sources',
  input: z.object({ city: z.string() }),
  output: z.object({ degrees: z.number() }),
  providePermission: 'weather.contribute',
  consumePermission: 'weather.read',
};
test('arbitrary plugin contracts support providers arriving before their definition', async () => {
  const caps = new Capabilities();
  caps.provide(
    owner('forecast', ['weather.contribute']),
    contract.id,
    'forecast.local',
    'Local',
    () => ({ degrees: 23 }),
  );
  assert.equal(caps.list()[0].state, 'pending');
  const off = caps.define(owner('weather'), contract);
  assert.equal(caps.list()[0].state, 'active');
  assert.deepEqual(
    await caps.invoke(owner('consumer', ['weather.read']), contract.id, 'forecast.local', {
      city: 'Test',
    }),
    { degrees: 23 },
  );
  await assert.rejects(
    caps.invoke(owner('denied', []), contract.id, 'forecast.local', { city: 'Test' }),
    /权限/,
  );
  await assert.rejects(caps.invoke(owner('consumer'), contract.id, 'forecast.local', { city: 23 }));
  off();
  assert.equal(caps.list()[0].state, 'pending');
  caps.define(owner('weather'), contract);
  assert.equal(caps.list()[0].state, 'active');
});
test('contracts reject namespace spoofing and same-version schema changes', () => {
  const caps = new Capabilities();
  assert.throws(() => caps.define(owner('other'), contract), /命名空间/);
  const off = caps.define(owner('weather'), contract);
  off();
  assert.throws(
    () => caps.define(owner('weather'), { ...contract, output: z.string() }),
    /增加版本/,
  );
  caps.define(owner('weather'), { ...contract, id: 'weather.forecasts@2', output: z.string() });
});
test('unregister cancels an in-flight capability, rejects its stale result and validates output', async () => {
  const caps = new Capabilities();
  caps.define(owner('weather'), contract);
  let finish!: (v: unknown) => void;
  let called!: () => void;
  const started = new Promise<void>((r) => (called = r));
  let signal!: AbortSignal;
  const off = caps.provide(owner('forecast'), contract.id, 'forecast.local', 'Local', (_v, s) => {
    signal = s;
    called();
    return new Promise((r) => (finish = r));
  });
  const result = caps.invoke(owner('consumer'), contract.id, 'forecast.local', { city: 'Test' });
  await started;
  off();
  assert.equal(signal.aborted, true);
  finish({ degrees: 23 });
  await assert.rejects(result);
  caps.provide(owner('forecast'), contract.id, 'forecast.local', 'Local', () => ({
    degrees: 'invalid',
  }));
  await assert.rejects(
    caps.invoke(owner('consumer'), contract.id, 'forecast.local', { city: 'Test' }),
  );
});
test('failed activation retracts all contributed contracts and providers', async () => {
  const caps = new Capabilities(),
    plugins = new PluginManager(new Registry(), caps);
  plugins.add({
    manifest: {
      id: 'weather',
      name: 'Fixture',
      description: 'Fixture',
      version: '1',
      dependencies: [],
      permissions: ['*'],
      settings: [],
    },
    activate: ({ capabilities }) => {
      capabilities.define(contract);
      capabilities.provide(contract.id, 'weather.bad', 'Bad', () => ({ degrees: 1 }));
      throw Error('fixture failure');
    },
  });
  await assert.rejects(plugins.enable('weather'));
  assert.equal(caps.points().length, 0);
  assert.equal(caps.list().length, 0);
  await plugins.close();
});
