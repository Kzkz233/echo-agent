import { z } from 'zod';
import { invariant } from '../contracts/index.ts';
import { frontendPageSchema, type FrontendPageEntry } from '../contracts/frontend.ts';
import type { Capabilities, CapabilityOwner } from './capabilities.ts';
import type { PluginManager } from './registry.ts';
import type { Extensions } from './extensions.ts';
import { randomBytes } from 'node:crypto';
import { extensionDocument } from './frontend-document.ts';

/** Page discovery is an optional contribution, never arbitrary code in the
 * trusted workbench. Page actions retain their plugin's authority. */
export class FrontendCatalog {
  private mounts = new Map<string, { id: string; bridge: string; personaId?: string; expires: number; instance: string | undefined }>();
  constructor(readonly capabilities: Capabilities, readonly owner: CapabilityOwner,
    readonly plugins: PluginManager, readonly extensions: Extensions, changed: () => void) {
    capabilities.define(owner, { id: 'core.ui.pages@1', description: 'Workbench pages and sheets',
      input: z.object({}), output: frontendPageSchema, cardinality: 'many',
      providePermission: 'ui.contribute', consumePermission: 'ui.read' });
    let shape = '';
    const off = capabilities.forOwner(owner, () => {}).subscribe(() => {
      const next = JSON.stringify(capabilities.list('core.ui.pages@1'));
      if (shape === next) return;
      shape = next; changed();
    });
    owner.signal.addEventListener('abort', off, { once: true });
  }
  async pages(): Promise<FrontendPageEntry[]> {
    const providers = this.capabilities.list('core.ui.pages@1').filter((item) => item.state === 'active');
    const rows = await Promise.all(providers.map(async (provider) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const page = frontendPageSchema.parse(await Promise.race([
          this.capabilities.invoke(this.owner, provider.point, provider.id, {}, controller.signal),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('Page metadata timed out')); }, 1500); timer.unref(); }),
        ]));
        invariant(page.id === provider.id && page.id.startsWith(provider.owner + '.'), 'page_namespace', '页面编号必须属于提供它的插件。');
        const plugin = this.plugins.plugins.get(provider.owner);
        invariant(plugin && this.plugins.active.has(provider.owner), 'page_unavailable', '插件页面当前不可用。');
        return { ...page, owner: provider.owner, ownerName: plugin.manifest.name };
      } catch { return undefined; }
      finally { clearTimeout(timer); }
    }));
    return rows.filter((page): page is FrontendPageEntry => Boolean(page)).sort((a,b) => a.order - b.order || a.id.localeCompare(b.id));
  }
  async page(id: string) {
    const page = (await this.pages()).find((item) => item.id === id);
    invariant(page, 'page_unavailable', '插件页面当前不可用。');
    return page;
  }
  async content(id: string) {
    const page = await this.page(id);
    return { page, ...(page.view.type === 'webview' ? { html: await this.extensions.pageHtml(page.owner, page.view.entry) } : {}) };
  }
  async mount(id: string, bridge: string, personaId?: string) {
    const page = await this.page(id);
    invariant(page.view.type === 'webview', 'page_type', '此页面不需要独立网页。');
    invariant(page.placement !== 'character' || personaId, 'page_character', '请先选择角色。');
    for (const [key, mount] of this.mounts) if (mount.expires < Date.now()) this.mounts.delete(key);
    if (this.mounts.size >= 128) this.mounts.delete(this.mounts.keys().next().value!);
    const ticket = randomBytes(24).toString('base64url');
    this.mounts.set(ticket, { id, bridge, personaId, expires: Date.now() + 60000,
      instance: this.capabilities.instanceKey('core.ui.pages@1', id) });
    return { ticket };
  }
  async document(ticket: string) {
    const mount = this.mounts.get(ticket);
    invariant(mount && mount.expires > Date.now(), 'page_ticket', '页面凭据已过期。');
    invariant(mount.instance === this.capabilities.instanceKey('core.ui.pages@1', mount.id),
      'page_unavailable', '插件页面当前不可用。');
    const content = await this.content(mount.id);
    return extensionDocument(content.html!, mount.bridge, { pageId: mount.id, personaId: mount.personaId });
  }
  async invoke(id: string, operation: string, input: unknown, personaId?: string, signal?: AbortSignal) {
    const page = await this.page(id), view = page.view;
    invariant(page.placement !== 'character' || personaId, 'page_character', '请先选择角色。');
    const allowed = view.type === 'webview' ? view.operations : [view.load, view.save].filter(Boolean);
    invariant(allowed.includes(operation), 'page_operation', '页面未声明此操作。');
    const plugin = this.plugins.plugins.get(page.owner)!;
    invariant(!operation.startsWith('frontend.') && !operation.startsWith('plugins.'), 'page_operation', '页面不能修改插件生命周期。');
    const value = view.type === 'form' && view.personaField ? {
      ...z.record(z.string(), z.unknown()).parse(input), [view.personaField]: personaId,
    } : input;
    return this.plugins.registry.callFromOwner(page.owner, operation, value,
      new Set(plugin.manifest.permissions), signal);
  }
}
