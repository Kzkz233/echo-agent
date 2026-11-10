import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { FrameGate, hsvDifference, mosaic } from '../plugins/observation/index.ts';
import {
  observationConfigSchema,
  observationSilence,
  EchoError,
} from '../packages/contracts/index.ts';
import { setup, conversation, FakeBackend, until } from './helpers.ts';
import type { StdioRpc } from '../packages/backends/rpc.ts';
import { localTimestamp } from '../packages/kernel/time.ts';

test('a capture denied after probe pauses status and later capture clears it', async (t) => {
  const app = await setup(t);
  let blocked = true;
  t.mock.method(app.observations, 'sample', async (work: (native: StdioRpc) => Promise<void>) => {
    await work({
      call: async (method: string) =>
        method === 'probe'
          ? { allowed: true, signature: 'AAAA', proof: 'fixture', sources: [] }
          : blocked
            ? { allowed: false, reason: 'Overlay appeared' }
            : { allowed: true, jpeg: 'AAAA', timestamp: new Date().toISOString() },
    } as unknown as StdioRpc);
  });
  app.observations.configure(
    observationConfigSchema.parse({
      enabled: true,
      allowlist: [{ id: 'fixture', type: 'process', value: 'fixture.exe' }],
    }),
  );
  await until(() => app.observations.status().samplingReason === 'Overlay appeared');
  assert.equal(app.observations.status().allowed, false);
  assert.equal(app.observations.status().failures, 0);
  assert.equal(app.observations.status().selected, 0);
  blocked = false;
  await until(() => app.observations.status().selected === 1, 8000);
  assert.equal(app.observations.status().allowed, true);
  assert.equal(app.observations.status().samplingReason, '');
});

test('occlusion exclusions are user-owned and legacy defaults are disabled once', async (t) => {
  const app = await setup(t);
  assert.deepEqual(observationConfigSchema.parse({}).occlusionAllowlist, []);
  const config = observationConfigSchema.parse({
    id: 'task',
    occlusionAllowlist: [
      { id: 'echo-avatar-overlay', value: 'echo-avatar.exe' },
      { id: 'nvidia-performance-overlay', value: 'nvidia overlay.exe' },
      { id: 'user-overlay', value: 'my-overlay.exe', title: 'Overlay' },
    ],
  });
  app.store.set('observation.tasks', [config]);
  app.store.set('observation.userOwnedOcclusionRules.v1', false);
  const migrate = (app.observations as unknown as { migrate: () => void }).migrate;
  migrate.call(app.observations);

  const rules = app.observations
    .configurations()
    .find((task) => task.id === 'task')!.occlusionAllowlist;
  assert.deepEqual(
    rules.map(({ id, enabled }) => [id, enabled]),
    [
      ['echo-avatar-overlay', false],
      ['nvidia-performance-overlay', false],
      ['user-overlay', true],
    ],
  );

  app.observations.configure(
    observationConfigSchema.parse({
      ...config,
      occlusionAllowlist: rules.map((rule) => ({ ...rule, enabled: true })),
    }),
  );
  migrate.call(app.observations);
  assert(
    app.observations
      .configurations()
      .find((task) => task.id === 'task')!
      .occlusionAllowlist.every((rule) => rule.enabled),
  );
});

test('window rule migration adds editable defaults without replacing custom rules', async (t) => {
  const app = await setup(t);
  const config = observationConfigSchema.parse({
    id: 'task',
    occlusionAllowlist: [{ id: 'my-window', value: 'custom.exe', enabled: false }],
  });
  const { browserAllowlist: _browsers, ...legacyConfig } = config;
  app.store.set('observation.tasks', [legacyConfig]);
  app.store.set('observation.userOwnedOcclusionRules.v1', true);
  app.store.set('observation.defaultWindowRules.v1', false);
  const migrate = (app.observations as unknown as { migrate: () => void }).migrate;
  migrate.call(app.observations);

  const saved = app.observations.configurations().find((task) => task.id === 'task')!;
  assert.deepEqual(
    saved.occlusionAllowlist.map(({ id, value, enabled }) => [id, value, enabled]),
    [
      ['my-window', 'custom.exe', false],
      ['echo-avatar-overlay', 'echo-avatar.exe', true],
      ['nvidia-performance-overlay', 'NVIDIA Overlay.exe', true],
    ],
  );
  assert.deepEqual(
    saved.browserAllowlist.map(({ name, value }) => [name, value]),
    [
      ['Google Chrome', 'chrome.exe'],
      ['Microsoft Edge', 'msedge.exe'],
      ['Brave', 'brave.exe'],
      ['Firefox', 'firefox.exe'],
    ],
  );
});

test('wall-clock slots limit selection despite 1Hz detection', () => {
  const gate = new FrameGate(),
    config = observationConfigSchema.parse({});
  const signatures = [new Uint8Array([0, 255, 0]), new Uint8Array([100, 255, 255])];
  assert(gate.select(signatures[0], 1700000000000, config));
  for (let i = 1; i < 5; i++)
    assert.equal(gate.select(signatures[i % 2], 1700000000000 + i * 1000, config), false);
  assert(gate.select(signatures[1], 1700000005000, config));
});

test('a previously attempted observation cannot consume the next interaction cooldown', async (t) => {
  const app = await setup(t),
    chat = conversation(app),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  let probes = 0;
  t.mock.method(app.observations, 'sample', async (work: (native: StdioRpc) => Promise<void>) => {
    await work({
      call: async (method: string) => {
        if (method === 'probe') {
          probes++;
          return { allowed: true, signature: 'AAAA', proof: 'fixture', sources: [] };
        }
        return { allowed: true, jpeg: 'AAAA', timestamp: new Date().toISOString() };
      },
    } as unknown as StdioRpc);
  });
  const prior = new Date(Date.now() - 10_000).toISOString();
  const record = (id: string, timestamp: string) => ({
    id,
    taskId: 'default',
    personaId: 'companion',
    conversationId: chat.id,
    timestamp,
    frameTimes: [timestamp],
    sources: ['fixture'],
    summary: id,
    interesting: true,
  });
  await app.observations.record(record('prior', prior));
  app.store.createRun({
    id: 'failed-observation',
    requestId: 'observe-prior',
    conversationId: chat.id,
    profileId: 'test',
    epoch: 0,
    state: 'failed',
    input: 'Prior attempt',
    source: 'observation',
    createdAt: prior,
    meta: {},
  });
  app.observations.configure(
    observationConfigSchema.parse({
      enabled: true,
      personaId: 'companion',
      conversationId: chat.id,
      allowlist: [{ id: 'fixture', type: 'process', value: 'fixture.exe' }],
    }),
  );
  await until(() => probes >= 2, 4000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(app.store.get('observation.roleCooldown.companion', 0), 0);
  const freshTime = new Date().toISOString();
  await app.observations.record(record('fresh', freshTime));
  await until(() => { const run=app.store.run('observe-fresh'); if(run?.state==='failed') throw Error(run.error); return run?.state === 'succeeded'; }, 4000);
  assert.equal(app.store.run('observe-fresh')?.meta.triggerKind, 'observation.interesting');
  assert.equal(backend.calls.length, 1);
  const input = app.store.run('observe-fresh')!.input;
  assert(input.includes('当前本地时间：'));
  assert(input.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert(input.includes(localTimestamp(new Date(freshTime))));
  assert(!input.includes(freshTime));
  assert.equal(app.observations.recent().at(-1)!.timestamp, freshTime);
});
test('HSV detects color change with equal brightness and wraps hue circularly', () => {
  assert.equal(hsvDifference(new Uint8Array([0, 255, 128]), new Uint8Array([120, 255, 128])), 1);
  assert.equal(hsvDifference(new Uint8Array([0, 255, 128]), new Uint8Array([255, 255, 128])), 0);
});
test('still frames are eventually admitted without fabricated timestamps', () => {
  const gate = new FrameGate(),
    config = observationConfigSchema.parse({ maxStillSeconds: 60 }),
    signature = new Uint8Array([50, 50, 50]);
  assert(gate.select(signature, 100000, config));
  assert.equal(gate.select(signature, 105000, config), false);
  assert(gate.select(signature, 160000, config));
});
for (const count of [1, 4, 9]) test(`${count} actual frames become a row-major labeled mosaic with unchanged per-frame resolution`, async () => {
  const colors = Array.from({length:count},(_,i)=>({r:30+i*20,g:50+i*12,b:100-i*8}));
  const frames = await Promise.all(colors.map(async (color, i) => ({
    timestamp: `2026-11-05T00:00:${String(i * 5).padStart(2, '0')}.000Z`,
    source: 'synthetic',
    title: 'test',
    ruleId: 'test',
    jpeg: await sharp({create:{width:320,height:180,channels:3,background:color}}).jpeg().toBuffer(),
    signature: new Uint8Array(),
    generation: 1,
  })));
  const result = await mosaic(frames, 560, 75);
  const metadata = await sharp(result).metadata();
  const columns=Math.sqrt(count);
  assert.equal(metadata.width, 560*columns);
  assert.equal(metadata.height, 341*columns);
  for(const [index,color] of colors.entries()){
    const pixel=await sharp(result).extract({left:(index%columns)*560+20,top:Math.floor(index/columns)*341+50,width:1,height:1}).raw().toBuffer();
    assert(Math.abs(pixel[0]-color.r)<8 && Math.abs(pixel[1]-color.g)<8 && Math.abs(pixel[2]-color.b)<8);
  }
});

test('frame-count choices validate form values and reject impossible batch deadlines', () => {
  for(const n of [1,4,9])assert.equal(observationConfigSchema.parse({frameCount:String(n)}).frameCount,n);
  for(const n of [0,2,3,16,true,''])assert.equal(observationConfigSchema.safeParse({frameCount:n}).success,false);
  assert.equal(observationConfigSchema.safeParse({frameCount:9,batchTimeoutSeconds:30}).success,false);
  assert.equal(observationConfigSchema.parse({frameCount:9,batchTimeoutSeconds:45}).batchTimeoutSeconds,45);
});

test('partial batches expire while unauthorized and restart without stale images or extra inference', async (t) => {
  const app=await setup(t),backend=new FakeBackend();
  app.router.backends.set('api',backend);
  backend.responder=async()=>({text:'{"summary":"Synthetic scene","attention":""}'});
  const jpeg=await sharp({create:{width:32,height:18,channels:3,background:'blue'}}).jpeg().toBuffer();
  const base=Math.ceil(Date.now()/5000)*5000;
  let now=base,allowed=true,signature='AAAA';
  t.mock.method(app.observations,'sample',async(work:(native:StdioRpc)=>Promise<void>)=>work({call:async(method:string)=>method==='probe'
    ? {allowed,reason:allowed?'':'No authorized content',signature,proof:'fixture',sources:[{source:'fixture',title:'Frame '+now,ruleId:'fixture'}]}
    : {allowed:true,jpeg:jpeg.toString('base64'),timestamp:new Date(now).toISOString()}} as unknown as StdioRpc));
  app.store.set('observation.tasks',[observationConfigSchema.parse({enabled:true,frameCount:4,batchTimeoutSeconds:30,maxStillSeconds:3600})]);
  const task=(app.observations as any).task('default');task.start();
  const tick=async(seconds:number)=>{now=base+seconds*1000;await task.tick(now);};
  await tick(0);await tick(5);assert.equal(task.status().bufferedFrames,2);
  allowed=false;await tick(31);
  assert.equal(task.status().bufferedFrames,0);assert.equal(task.status().expiredFrames,2);
  assert.equal(task.status().expiredBatches,1);assert.equal(task.status().failures,0);assert.equal(backend.calls.length,0);
  allowed=true;for(const at of [35,40,45,50])await tick(at);
  await until(()=>task.status().batches===1&&!task.status().inferenceBusy);
  assert.deepEqual(app.observations.recent().at(-1)!.frameTimes,[35,40,45,50].map(s=>new Date(base+s*1000).toISOString()));
  assert.equal(backend.calls.length,1);
  signature='/4D/';await tick(60);assert.equal(task.status().bufferedFrames,1);
  allowed=false;await tick(91);assert.equal(task.status().expiredBatches,2);
  allowed=true;await tick(95);await tick(100);
  assert.equal(task.status().bufferedFrames,1,'timeout allows a fresh first frame but does not force repeated static frames');
  assert.equal(backend.calls.length,1);
  task.stop();assert.equal(task.status().bufferedFrames,0);assert.equal(task.status().bufferExpiresAt,undefined);
});

for (const count of [1,9]) test(`${count}-frame tasks invoke vision once with matching layout and real timestamps`, async(t)=>{
  const app=await setup(t),backend=new FakeBackend();app.router.backends.set('api',backend);
  app.store.set('observation.tasks',[observationConfigSchema.parse({frameCount:count})]);
  const jpeg=await sharp({create:{width:32,height:18,channels:3,background:'green'}}).jpeg().toBuffer();
  const frames=Array.from({length:count},(_,i)=>({timestamp:new Date(Date.now()+i*5000).toISOString(),source:'fixture',title:'Frame '+i,ruleId:'fixture',jpeg,signature:new Uint8Array(),generation:0}));
  backend.responder=async(request)=>{
    assert(request.messages[0].text.includes(`${Math.sqrt(count)}×${Math.sqrt(count)}`));
    const payload=JSON.parse(request.messages.at(-1)!.text);assert.equal(payload.frames.length,count);
    assert.deepEqual(payload.frames.map((f:any)=>f.window),frames.map(f=>f.title));
    return {text:'{"summary":"Synthetic frames","attention":""}'};
  };
  await app.observations.process(frames,0);
  assert.equal(app.observations.status().lastError,'');assert.equal(backend.calls.length,1);
  assert.deepEqual(app.observations.recent().at(-1)?.frameTimes,frames.map(f=>f.timestamp));
});

test('legacy observation settings gain read defaults without rewriting user data',async(t)=>{
  const app=await setup(t);const {frameCount,batchTimeoutSeconds,...legacy}=observationConfigSchema.parse({width:600,quality:65});
  app.store.set('observation.tasks',[legacy]);
  assert.equal(app.observations.config().frameCount,4);assert.equal(app.observations.config().batchTimeoutSeconds,120);
  assert.equal(app.observations.config().width,600);assert.deepEqual(app.store.get('observation.tasks',[]),[legacy]);
});
test('a batch with no legible authorized pixels retains only its source and does not call vision', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const frames = Array.from({ length: 4 }, (_, i) => ({
    timestamp: new Date(Date.now() + i).toISOString(),
    source: 'fixture.example',
    title: 'Fixture',
    ruleId: 'fixture',
    jpeg: Buffer.alloc(0),
    signature: new Uint8Array(),
    generation: 0,
    visibility: { visiblePercent: 70, litPercent: 0 },
  }));
  await app.observations.process(frames, 0);
  const latest = app.observations.recent().at(-1);
  assert.match(latest!.summary, /fixture.example.*暂无法辨认/);
  assert.equal(latest?.interesting, false);
  assert.equal(latest?.attention, undefined);
  assert.equal(app.observations.status().uploadedBytes, 0);
  assert.equal(backend.calls.length, 0);
});
test('paused generation cannot publish a completed stale image result', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  let finish!: (v: any) => void;
  backend.responder = () => new Promise((resolve) => (finish = resolve));
  const jpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: 'black' } })
    .jpeg()
    .toBuffer();
  const frames = Array.from({ length: 4 }, (_, i) => ({
    timestamp: `2026-11-05T00:00:${i}0.000Z`,
    source: 'test',
    title: '',
    ruleId: '',
    jpeg,
    signature: new Uint8Array(),
    generation: 0,
  }));
  const task = app.observations.process(frames, 0);
  while (!finish) await new Promise((r) => setTimeout(r, 10));
  await app.observations.stop();
  finish({ text: '{"summary":"stale","interesting":true}' });
  await task;
  assert.equal(app.observations.recent().length, 0);
});

test('content rejection preserves raw observations but excludes rejected history from the next vision request', async (t) => {
  const app = await setup(t),
    backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const now = new Date().toISOString();
  await app.observations.record({
    id: 'old-context',
    personaId: 'companion',
    conversationId: '',
    timestamp: now,
    frameTimes: [now],
    sources: ['fictional'],
    summary: 'REJECTED_CONTEXT_SENTINEL',
    interesting: true,
  });
  const jpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: 'green' } })
    .jpeg()
    .toBuffer();
  const frames = Array.from({ length: 4 }, (_, i) => ({
    timestamp: new Date(Date.now() + 1000 + i * 5000).toISOString(),
    source: 'fictional',
    title: '',
    ruleId: '',
    jpeg,
    signature: new Uint8Array(),
    generation: 0,
  }));
  backend.responder = async () => {
    throw new EchoError('provider_content_rejected', 'Synthetic rejection');
  };
  await app.observations.process(frames, 0);
  backend.responder = async (request) => {
    assert(!JSON.stringify(request.messages).includes('REJECTED_CONTEXT_SENTINEL'));
    const payload = JSON.parse(request.messages.at(-1)!.text);
    assert.equal(payload.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.match(payload.currentLocalTime, / UTC/);
    assert.equal(payload.frames[0].at, localTimestamp(new Date(frames[0].timestamp)));
    return { text: '{"summary":"A new fictional green screen."}' };
  };
  await app.observations.process(frames, 0);
  assert.equal(app.observations.recent().length, 2);
  assert.equal((await app.observations.allRaw())[0].summary, 'REJECTED_CONTEXT_SENTINEL');
  assert.equal(app.observations.recent().at(-1)?.interesting, false);
  backend.responder = async () => ({
    text: '{"summary":"The screen now shows a store.","attention":"The store sign changed."}',
  });
  await app.observations.process(
    frames.map((frame) => ({
      ...frame,
      timestamp: new Date(Date.parse(frame.timestamp) + 20000).toISOString(),
      title: 'Example store',
    })),
    0,
  );
  const latest = app.observations.recent().at(-1);
  assert.equal(latest?.interesting, true);
  assert.equal(latest?.attention, 'The store sign changed.');
  assert.deepEqual(latest?.latestFrame, { source: 'fictional', title: 'Example store' });
});

test('observation silence is explicit and only a reply creates a bubble receipt', async (t) => {
  const app = await setup(t);
  const chat = conversation(app);
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  for (const [outcome, text] of [
    ['skip', observationSilence],
    ['empty', ''],
    ['reply', 'A real response'],
  ]) {
    backend.responder = async () => ({ text });
    const run = await app.router.send({
      conversationId: chat.id,
      source: 'observation',
      text: 'Synthetic observation interaction',
      requestId: 'observe-test-' + outcome,
      bubble: true,
    });
    assert.equal(run.meta.observationOutcome, outcome);
  }
  assert.deepEqual(
    app.store.pendingDeliveries().map((r) => r.text),
    ['A real response'],
  );
  assert.deepEqual(
    app.store.allMessages(chat.id).map((m) => m.role),
    ['system', 'system', 'system', 'assistant'],
  );
});

test('legacy prompts migrate to a task and concurrent tasks isolate prompts and recent summaries', async (t) => {
  const app = await setup(t);
  await app.plugins.disable('observation');
  app.store.put('personas', 'companion', {
    ...app.personas.get('companion'),
    observationPrompt: 'LEGACY_VISION_PROMPT',
    interactionPrompt: 'LEGACY_INTERACTION_PROMPT',
  });
  app.store.set('observation.config', { personaId: 'companion', enabled: false, width: 600 });
  await app.plugins.enable('observation');
  assert.equal(app.observations.config().observationPrompt, 'LEGACY_VISION_PROMPT');
  assert.equal(app.observations.config().interactionPrompt, 'LEGACY_INTERACTION_PROMPT');
  assert.equal(app.observations.config().width, 600);
  app.observations.configure(
    observationConfigSchema.parse({
      id: 'second',
      name: 'Second task',
      observationPrompt: 'SECOND_VISION_PROMPT',
    }),
  );
  const backend = new FakeBackend();
  app.router.backends.set('api', backend);
  const jpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: 'green' } })
    .jpeg()
    .toBuffer();
  const timestamp = new Date(Date.now() + 6000).toISOString();
  const frames = Array.from({ length: 4 }, () => ({
    timestamp,
    source: 'fixture',
    title: '',
    ruleId: '',
    jpeg,
    signature: new Uint8Array(),
    generation: 0,
  }));
  backend.responder = async (request) => {
    const payload = JSON.stringify(request.messages);
    assert.notEqual(
      payload.includes('LEGACY_VISION_PROMPT'),
      payload.includes('SECOND_VISION_PROMPT'),
    );
    return {
      text: JSON.stringify({
        summary: payload.includes('LEGACY_VISION_PROMPT') ? 'LEGACY_SUMMARY' : 'SECOND_SUMMARY',
        interesting: false,
      }),
    };
  };
  await Promise.all([
    app.observations.process(frames),
    app.observations.process(frames, undefined, 'second'),
  ]);
  await Promise.all([
    app.observations.process(frames),
    app.observations.process(frames, undefined, 'second'),
  ]);
  for (const request of backend.calls) {
    const payload = JSON.stringify(request.messages);
    assert(
      !payload.includes(
        payload.includes('LEGACY_VISION_PROMPT') ? 'SECOND_SUMMARY' : 'LEGACY_SUMMARY',
      ),
    );
  }
  assert.equal(app.observations.recent().filter((o) => o.taskId === 'second').length, 2);
  app.observations.remove('second');
  assert.equal(app.observations.configurations().length, 1);
  assert.equal((await app.observations.allRaw()).length, 4);
});
