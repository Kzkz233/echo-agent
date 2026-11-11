import type { Store } from './store.ts';
import type { Events } from './events.ts';
import type { Plugin } from './registry.ts';

/** Versioned API for explicitly installed, fully trusted Node modules.
 * Process extensions keep their existing RPC API and sandboxed pages.
 * Services are selected from declared dependencies; modules cannot become core components.
 */
export type ExtensionHost = {
  apiVersion: 1;
  directory: string;
  dataDirectory: string;
  store: Store;
  events: Events;
  /** Explicit, versioned dependency APIs (like extension exports). Prefer registered
   * operations/capabilities for ordinary cross-plugin calls. No implicit dependencies. */
  dependency<T extends object = Record<string, unknown>>(pluginId: string, apiVersion: number): T;
};
export type ModuleExtension = { createPlugin(host: ExtensionHost): Plugin | Promise<Plugin> };
