import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
import {
  replyToNative,
  snapshotNative,
  draftToNative,
  snapshotNativeComposer,
} from './native-controls.ts';
import { showFixture } from './windows-fixture.ts';
export async function validateNativeDesktop(c: any) {
  const { project, runtime, child, debugPort, rpc, pause, fake, getCounts } = c;
  let browser: any, fixtureBrowser: any;
  const wait = async (predicate: () => Promise<boolean>, timeout = 10000) => {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > timeout) throw Error('Native desktop acceptance timed out');
      await pause(100);
    }
  };
  function usage() {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `$all=Get-CimInstance Win32_Process;$memory=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process;$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${child.pid});do{$added=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)-and-not $ids.Contains([int]$p.ProcessId)){[void]$ids.Add([int]$p.ProcessId);$added=$true}}}while($added);@($ids|ForEach-Object{$p=Get-Process -Id $_ -ErrorAction SilentlyContinue;if($p){$m=$memory|Where-Object IDProcess -eq $p.Id;[pscustomobject]@{Id=$p.Id;name=$p.ProcessName;CPU=$p.CPU;workingSet=$p.WorkingSet64;privateCommitted=$p.PrivateMemorySize64;privateWorkingSet=$m.WorkingSetPrivate}}})|ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0) throw Error(result.stderr);
    const values = JSON.parse(result.stdout);
    return Array.isArray(values) ? values : [values];
  }
  async function measure(label: string) {
    if (process.env.ECHO_FAST_DESKTOP === '1') return { label, skipped: true };
    const before = usage(),
      start = performance.now();
    await pause(15000);
    const after = usage(),
      seconds = (performance.now() - start) / 1000,
      cpu = after.reduce(
        (n: number, p: any) =>
          n + Math.max(0, p.CPU - (before.find((q: any) => q.Id === p.Id)?.CPU ?? p.CPU)),
        0,
      );
    return {
      label,
      seconds,
      processes: after.length,
      rssMB: after.reduce((n: number, p: any) => n + p.workingSet, 0) / 1048576,
      privateWorkingSetMB:
        after.reduce((n: number, p: any) => n + Number(p.privateWorkingSet ?? 0), 0) / 1048576,
      privateCommittedMB: after.reduce((n: number, p: any) => n + p.privateCommitted, 0) / 1048576,
      cpuCorePercent: (cpu / seconds) * 100,
      cpuMachinePercent: (cpu / seconds / availableParallelism()) * 100,
      groups: after.map((p: any) => ({ ...p, rssMB: p.workingSet / 1048576 })),
    };
  }
  try {
    for (let i = 0; i < 100 && !browser; i++)
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 500 });
      } catch {
        await pause(100);
      }
    if (!browser) throw Error('Manager not ready');
    const pages = browser.contexts().flatMap((ctx: any) => ctx.pages()),
      main = pages[0];
    if (pages.length !== 1) throw Error('Unexpected additional WebView');
    await main.locator('nav').waitFor();
    const errors: string[] = [];
    main.on('pageerror', (e: any) => errors.push(e.message));
    await wait(async () => Boolean((await rpc('avatar.status')).visible));
    const initial = await rpc('avatar.status');
    await pause(400);
    const animated = await rpc('avatar.status');
    if (animated.paints <= initial.paints + 1) throw Error('Native frame sequence did not advance');
    await rpc('conversations.send', {
      conversationId: 'desktop-fixture',
      text: 'A synthetic desktop message',
      requestId: 'desktop-one',
      bubble: true,
    });
    await wait(
      async () =>
        (await rpc('avatar.status')).text ===
        'Echo desktop test: a shared conversation and a visible bubble.',
    );
    await mkdir(join(project, 'docs/screenshots'), { recursive: true });
    snapshotNative(initial.pid, join(project, 'docs/screenshots/native-bubble.png'));
    draftToNative(initial.pid, 'Reply through the same conversation');
    snapshotNativeComposer(initial.pid, join(project, 'docs/screenshots/native-input.png'));
    const other = await rpc('conversations.create', {
      title: 'Other synthetic conversation',
      personaId: 'companion',
    });
    await rpc('conversations.send', {
      conversationId: other.id,
      text: 'A different conversation bubble',
      requestId: 'other-bubble',
      bubble: true,
    });
    await wait(async () => (await rpc('avatar.status')).conversationId === other.id);
    replyToNative(initial.pid, 'Reply through the same conversation');
    await wait(async () => getCounts().calls === 3);
    const history = await rpc('conversations.messages', { id: 'desktop-fixture' });
    if (
      !history.messages.some(
        (m: any) => m.source === 'human' && m.text === 'Reply through the same conversation',
      )
    )
      throw Error('Native reply did not retain human authorship');
    const withManager = await measure('manager-and-native-avatar');
    await main
      .evaluate(async () => {
        await (window as any).__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' });
      })
      .catch((e: any) => {
        if (!main.isClosed()) throw e;
      });
    await pause(1500);
    if (!main.isClosed()) throw Error('Manager did not close');
    await browser.close().catch(() => {});
    browser = undefined;
    const avatarOnly = await measure('native-avatar-only');
    if (!('skipped' in withManager))
      await writeFile(
        join(project, 'test-results/native-resources.json'),
        JSON.stringify({ measurements: [withManager, avatarOnly] }, null, 2),
      );
    const corePid = JSON.parse(await readFile(join(runtime, 'connection.json'), 'utf8')).pid;
    const duplicate = spawn(child.spawnfile, [], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ECHO_DATA_DIR: runtime },
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        duplicate.kill();
        reject(Error('Duplicate desktop instance did not release'));
      }, 15000);
      duplicate.once('error', (error) => { clearTimeout(timeout); reject(error); });
      duplicate.once('exit', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve() : reject(Error('Duplicate instance failed: ' + code));
      });
    });
    await wait(async () => {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 500 });
        return browser.contexts().some((context: any) => context.pages().length === 1);
      } catch { return false; }
    });
    const reopened = browser.contexts().flatMap((context: any) => context.pages());
    if (reopened.length !== 1) throw Error('Reopening desktop created duplicate managers');
    await reopened[0].locator('nav').waitFor();
    if (JSON.parse(await readFile(join(runtime, 'connection.json'), 'utf8')).pid !== corePid ||
        (await rpc('avatar.status')).pid !== initial.pid)
      throw Error('Reopening desktop replaced the running core or avatar');
    await reopened[0].evaluate(async () => {
      await (window as any).__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' });
    }).catch((error: any) => { if (!reopened[0].isClosed()) throw error; });
    await browser.close().catch(() => {});
    browser = undefined;
    fixtureBrowser = await chromium.launch({
      channel: 'msedge',
      headless: false,
      args: ['--window-position=50,50', '--window-size=1100,800', '--force-renderer-accessibility'],
    });
    const fixture = await fixtureBrowser.newPage({ viewport: null });
    await fixture.goto(`http://127.0.0.1:${fake.address().port}/allowed`);
    const fixtureCDP = await fixture.context().newCDPSession(fixture);
    const fixtureWindow = await fixtureCDP.send('Browser.getWindowForTarget');
    await fixtureCDP.send('Browser.setWindowBounds', {
      windowId: fixtureWindow.windowId,
      bounds: { left: 50, top: 50, width: 1100, height: 800 },
    });
    await fixture.bringToFront();
    await showFixture(fixtureBrowser, 'Allowed Echo entertainment fixture');
    const config = {
      enabled: true,
      personaId: 'companion',
      conversationId: 'desktop-fixture',
      minBubbleSeconds: 300,
      maxStillSeconds: 5,
      interactionPrompt: 'SYNTHETIC_OBSERVATION_INTERACTION',
      allowlist: [
        {
          id: 'fixture',
          type: 'website',
          value: '127.0.0.1',
          enabled: true,
          prompt: 'Synthetic entertainment page used only for acceptance.',
        },
      ],
      browserAllowlist: [
        { id: 'edge', name: 'Microsoft Edge', type: 'process', value: 'msedge.exe', enabled: true },
      ],
      occlusionAllowlist: [
        { id: 'echo-avatar-overlay', type: 'process', value: 'echo-avatar.exe', enabled: true },
        {
          id: 'nvidia-performance-overlay',
          type: 'process',
          value: 'NVIDIA Overlay.exe',
          enabled: true,
        },
      ],
    };
    await rpc('observation.configure', config);
    await wait(async () => getCounts().observationReplies === 1, 45000);
    await wait(
      async () =>
        (await rpc('avatar.status')).text ===
        'Observation acceptance: the visible entertainment page reached this same conversation.',
      15000,
    );
    await rpc('observation.configure', { ...config, enabled: false });
    const records = (
      await Promise.all(
        (await readdir(join(runtime, 'observations')))
          .filter((f: string) => f.endsWith('.jsonl'))
          .map((f: string) => readFile(join(runtime, 'observations', f), 'utf8')),
      )
    ).flatMap((t) =>
      t
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s)),
    );
    if (!records.some((r) => r.frameTimes.length === 4 && new Set(r.frameTimes).size === 4))
      throw Error('Native observation did not retain four actual frame times');
    const h = await rpc('conversations.messages', { id: 'desktop-fixture' });
    if (
      !h.messages.some((m: any) => m.role === 'system' && m.source === 'observation') ||
      !h.messages.some((m: any) => m.role === 'assistant' && m.source === 'observation')
    )
      throw Error('Observation authorship missing');
    const counts = getCounts();
    if (counts.visionCalls !== 1 || counts.observationReplies !== 1)
      throw Error('Unexpected observation replay');
    await rpc('plugins.enable', { id: 'avatar', enabled: false });
    await wait(async () => {
      try {
        process.kill(initial.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    const report = {
      nativeDesktop: true,
      renderer: 'win32',
      animatedFrames: true,
      bubbleShown: true,
      sharedConversationReply: true,
      managerRendererReleased: true,
      singleInstanceReopenedManager: true,
      nativeFourFrameObservation: true,
      pluginDisableReleasedAvatar: true,
      visionCalls: counts.visionCalls,
      observationReplies: counts.observationReplies,
      paidCalls: 0,
      browserErrors: errors,
      measurements: [withManager, avatarOnly],
    };
    if (errors.length) throw Error(errors.join('\n'));
    await writeFile(
      join(project, 'test-results/desktop-native.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await fixtureBrowser?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
