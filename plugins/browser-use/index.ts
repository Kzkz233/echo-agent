import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Browser, BrowserContext, ElementHandle, Page, Route } from 'playwright-core';
import { invariant } from '../../packages/contracts/index.ts';
import { defineManifest, type Caller, type Plugin } from '../../packages/kernel/registry.ts';
import type { Store } from '../../packages/kernel/store.ts';
import type { Attachments } from '../../packages/kernel/attachments.ts';
import { operations } from '../shared.ts';
import manifest from './echo-plugin.json' with { type: 'json' };

const config = z.object({
  origins: z.string().default(''),
  channel: z.enum(['msedge', 'chrome']).default('msedge'),
});
export function allowedWebsite(value: string, origins: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !isIP(url.hostname) &&
      url.hostname.includes('.') &&
      !url.hostname.startsWith('[') &&
      !/\.(?:localhost|local)$/.test(url.hostname) &&
      origins.split(/\s+/).some((origin) => origin.replace(/\/$/, '') === url.origin)
    );
  } catch {
    return false;
  }
}
type Session = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  refs: Map<string, ElementHandle>;
  expiry?: NodeJS.Timeout;
  allowWrite?: boolean;
};
export function browserPlugin(store: Store, attachments: Attachments, loadResource=(route:Route)=>route.fetch({maxRedirects:0,timeout:15000})): Plugin {
  const sessions = new Map<string, Session>(),
    busy = new Set<string>();
  const settings = () => config.parse(store.get('browser-use.config', {}));
  const permitted = (url: string) => allowedWebsite(url, settings().origins);
  async function close(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.expiry);
    await session.browser.close().catch(() => {});
  }
  async function open(id: string, signal: AbortSignal) {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      channel: settings().channel,
      headless: true,
      chromiumSandbox: true,
    });
    try {
      signal.throwIfAborted();
      const context = await browser.newContext({
        serviceWorkers: 'block',
        acceptDownloads: false,
        permissions: [],
      });
      await context.routeWebSocket('**/*', (socket) => socket.close());
      await context.route('**/*', async (route) => {
        const req = route.request();
        if (!permitted(req.url())||(!['GET','HEAD','OPTIONS'].includes(req.method())&&!sessions.get(id)?.allowWrite)) return route.abort().catch(() => {});
        // Redirects are checked before Chromium receives them. An unapproved origin must not be contacted.
        try {
          const response = await loadResource(route);
          try {
            const location = response.headers()['location'];
            if (response.status() >= 300 && response.status() < 400 && location) {
              const next=new URL(location,req.url()).href;
              if(req.isNavigationRequest()&&req.method()==='GET'&&permitted(next)){
                const link=next.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
                await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<a href="'+link+'">Continue to the redirected page</a>'});
              }else await route.abort();
              return;
            }
            await route.fulfill({ response });
          } finally {
            await response.dispose();
          }
        } catch {
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      context.on('page', (other) => {
        if (other !== page) void other.close().catch(() => {});
      });
      const session: Session = { context, page, browser, refs: new Map() };
      signal.throwIfAborted();
      sessions.set(id, session);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) session.refs.clear();
      });
      return session;
    } catch (e) {
      await browser.close();
      throw e;
    }
  }
  async function run<T>(
    caller: Caller,
    signal: AbortSignal,
    create: boolean,
    fn: (s: Session) => Promise<T>,
  ) {
    invariant(caller.conversationId, 'browser_context', '操作需要绑定到一个会话。');
    const id = caller.conversationId;
    invariant(!busy.has(id), 'browser_busy', '此会话正在操作浏览器。');
    busy.add(id);
    const abort = () => {
      void close(id);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const s = sessions.get(id) ?? (create ? await open(id, signal) : undefined);
      invariant(s, 'browser_session', '请先打开授权网页。');
      clearTimeout(s.expiry);
      signal.throwIfAborted();
      return await fn(s);
    } finally {
      busy.delete(id);
      signal.removeEventListener('abort', abort);
      const session = sessions.get(id);
      if (session) {
        session.allowWrite=false;
        session.expiry = setTimeout(() => void close(id), 300000);
        session.expiry.unref();
      }
    }
  }
  async function snapshot(session: Session) {
    const { page, refs } = session;
    invariant(permitted(page.url()), 'browser_origin', '网页来源未获授权。');
    await Promise.all([...refs.values()].map((e) => e.dispose().catch(() => {})));
    refs.clear();
    const summary = [];
    const controls = page.locator(
      'a[href],button,input:not([type=password]):not([type=file]):not([type=hidden]),textarea,select,[role=button]',
    );
    const count = Math.min(await controls.count(), 120);
    for (let i = 0; i < count; i++) {
      const element = await controls
        .nth(i)
        .elementHandle({ timeout: 800 })
        .catch(() => null);
      if (!element) continue;
      if (!(await element.isVisible().catch(() => false))) {
        await element.dispose();
        continue;
      }
      const description = await element.evaluate((el) => ({
        kind: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: (
          el.getAttribute('aria-label') ||
          el.textContent ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          ''
        )
          .trim()
          .slice(0, 160),
      }));
      const ref = randomUUID();
      refs.set(ref, element);
      summary.push({ ref, ...description });
    }
    return {
      url: page.url(),
      title: await page.title(),
      text: (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 16000),
      elements: summary,
    };
  }
  return {
    manifest: defineManifest(manifest),
    config: {
      schema: config,
      toolSettingReady: (_key, value) => typeof value === 'string' &&
        value.split(/\s+/).some((origin) => allowedWebsite(origin, value)),
    },
    activate(ctx) {
      const op = operations(ctx, 'browser-use');
      op(
        'open',
        '在当前会话打开授权网站',
        z.object({ url: z.url() }),
        'browser-use.read',
        ({ url }, signal, c) => {
          invariant(permitted(url), 'browser_origin', '请先在插件设置中授权网站的 HTTPS 来源。');
          return run(c, signal, true, async (s) => {
            await s.page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' });
            return snapshot(s);
          });
        },
      );
      op('inspect', '读取网页正文与当前可操作元素', z.object({}), 'browser-use.read', (_v, s, c) =>
        run(c, s, false, snapshot),
      );
      op(
        'act',
        '对最近一次观察中的元素点击或填写文本',
        z.discriminatedUnion('action', [
          z.object({ action: z.literal('click'), ref: z.uuid() }),
          z.object({ action: z.literal('fill'), ref: z.uuid(), text: z.string().max(8000) }),
        ]),
        'browser-use.interact',
        (v, signal, c) =>
          run(c, signal, false, async (s) => {
            const element = s.refs.get(v.ref);
            invariant(element && permitted(s.page.url()), 'browser_stale', '请重新读取当前网页。');
            invariant(
              await element.evaluate(
                (el) =>
                  el instanceof Element &&
                  el.isConnected &&
                  !el.closest('input[type=password],input[type=file]'),
              ),
              'browser_stale',
              '网页元素已改变。',
            );
            s.allowWrite = true;
            if (v.action === 'click') await element.click({ timeout: 4000 });
            else await element.fill(v.text, { timeout: 4000 });
            return snapshot(s);
          }),
      );
      op(
        'saveLink',
        '将当前网页链接的附件保存到当前会话',
        z.object({ ref: z.uuid() }),
        'browser-use.interact',
        (v, signal, c) =>
          run(c, signal, false, async (s) => {
            const el = s.refs.get(v.ref);
            invariant(el && permitted(s.page.url()), 'browser_stale', '请重新观察网页');
            const url = await el.evaluate((node) =>
              node instanceof HTMLAnchorElement && node.isConnected ? node.href : '',
            );
            invariant(permitted(url), 'browser_origin', '链接来源未获授权');
            const response = await s.context.request.get(url, { maxRedirects: 0, timeout: 15000 });
            try {
              const size = Number(response.headers()['content-length']);
              invariant(
                response.ok() && Number.isSafeInteger(size) && size > 0 && size <= 8 * 1024 * 1024,
                'browser_file',
                '文件响应缺少可用长度或超过 8 MB',
              );
              const data = await response.body();
              signal.throwIfAborted();
              invariant(data.length <= 8 * 1024 * 1024, 'browser_file', '附件超过 8 MB');
              const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
              return attachments.add(
                c.conversationId!,
                name,
                response.headers()['content-type']?.split(';')[0] || 'application/octet-stream',
                data.toString('base64'),
                { original: true },
              );
            } finally {
              await response.dispose();
            }
          }),
      );
      ctx.dispose(async () => {
        await Promise.all([...sessions.keys()].map(close));
      });
    },
  };
}
