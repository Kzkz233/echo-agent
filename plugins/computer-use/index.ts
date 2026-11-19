import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { z } from 'zod';
import { invariant } from '../../packages/contracts/index.ts';
import type { Store } from '../../packages/kernel/store.ts';
import { defineManifest, type Caller, type Plugin } from '../../packages/kernel/registry.ts';
import { StdioRpc } from '../../packages/backends/rpc.ts';
import { operations } from '../shared.ts';
import manifest from './echo-plugin.json' with { type: 'json' };

const config = z.object({ applications: z.string().default('') });
export function approvedApplications(applications: string) {
  return [
    ...new Set(
      applications
        .split(/\r?\n/)
        .map((p) => p.trim().toLowerCase())
        .filter(
          (p) =>
            /^[a-z]:\\/.test(p) &&
            win32.normalize(p) === p &&
            p.endsWith('.exe') &&
            !/(?:^|\\)(?:powershell(?:_ise)?|pwsh|cmd|windowsterminal|conhost|regedit|wscript|cscript|mshta|mmc|consent|credentialuibroker|securityhealthsystray|systemsettings)\.exe$/i.test(
              p,
            ),
        ),
    ),
  ];
}
type Driver=Pick<StdioRpc,'call'|'close'>;
export function computerPlugin(store: Store, nativePath: string, runtime: string, connect:()=>Driver=()=>new StdioRpc(nativePath,[],runtime)): Plugin {
  type Session = { rpc: Driver; generation?: string; timer?: NodeJS.Timeout; busy: boolean };
  const sessions = new Map<string, Session>();
  async function close(id: string) {
    const s = sessions.get(id);
    if (s) {
      sessions.delete(id);
      clearTimeout(s.timer);
      await s.rpc.close();
    }
  }
  async function run(
    c: Caller,
    signal: AbortSignal,
    method: string,
    params: Record<string, unknown>,
  ) {
    const id = c.conversationId;
    invariant(id, 'computer_session', '操作需要绑定到一个会话。');
    const allowed = approvedApplications(
      config.parse(store.get('computer-use.config', {})).applications,
    );
    invariant(
      process.platform === 'win32' && allowed.length,
      'computer_setup',
      '请先选择允许操作的 Windows 应用。',
    );
    let s = sessions.get(id);
    if (!s) {
      invariant(method === 'desktop.inspect', 'computer_stale', '请先观察当前前台窗口。');
      s = { rpc: connect(), busy: false };
      sessions.set(id, s);
    }
    invariant(!s.busy, 'computer_busy', '另一个窗口操作正在执行。');
    if (method === 'desktop.act')
      invariant(
        s.generation && s.generation === params.snapshot,
        'computer_stale',
        '请重新观察当前窗口。',
      );
    s.busy = true;
    clearTimeout(s.timer);
    s.generation = undefined;
    const abort = () => {
      void close(id);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const result = await s.rpc.call(method, { ...params, allowed }, 10000);
      if (method === 'desktop.inspect') {
        s.generation = randomUUID();
        return { ...result, snapshot: s.generation };
      }
      return result;
    } catch (e) {
      await close(id);
      throw e;
    } finally {
      signal.removeEventListener('abort', abort);
      s.busy = false;
      if (sessions.get(id) === s) {
        s.timer = setTimeout(() => void close(id), 60000);
        s.timer.unref();
      }
    }
  }
  return {
    manifest: defineManifest(manifest),
    config: {
      schema: config,
      toolSettingReady: (_key, value) => typeof value === 'string' && approvedApplications(value).length > 0,
    },
    activate(ctx) {
      const op = operations(ctx, 'computer-use');
      op(
        'inspect',
        '读取获准的前台窗口和可访问控件',
        z.object({}),
        'computer-use.read',
        (_v, s, c) => run(c, s, 'desktop.inspect', {}),
      );
      op(
        'act',
        '调用或填写刚观察到的窗口控件',
        z.discriminatedUnion('action', [
          z.object({
            action: z.literal('invoke'),
            snapshot: z.uuid(),
            index: z.number().int().min(0).max(199),
          }),
          z.object({
            action: z.literal('fill'),
            snapshot: z.uuid(),
            index: z.number().int().min(0).max(199),
            text: z.string().max(8000),
          }),
        ]),
        'computer-use.interact',
        (v, s, c) => run(c, s, 'desktop.act', v),
      );
      ctx.dispose(async () => {
        await Promise.all([...sessions.keys()].map(close));
      });
    },
  };
}
