import clockManifest from './components/clock.json' with { type: 'json' };
import storageManifest from './components/storage.json' with { type: 'json' };
import modelsManifest from './components/models.json' with { type: 'json' };
import { z } from 'zod';
import { dirname } from 'node:path';
import { defineManifest, type Plugin, type PluginManager } from './registry.ts';
import type { Store } from './store.ts';
import type { Clock } from './clock.ts';
import { localTimestamp, configuredTimezone } from './time.ts';
import {
  planStorageMigration,
  requestStorageMigration,
  storageMigrationStatus,
  cancelStorageMigration,
} from './storage.ts';
export const clockConfig = z.object({
  timezone: z
    .string()
    .default('system')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value === 'system' ? undefined : value });
        return true;
      } catch {
        return false;
      }
    }, '请填写有效的 IANA 时区，或 system 跟随系统'),
});
export function modelServicesComponent(store: Store, schema: z.ZodType): Plugin {
  return {
    manifest: defineManifest(modelsManifest),
    config: { schema },
    activate: () => {
      if (!store.get('models.config', null))
        store.set('models.config', schema.parse(store.get('local-models.config', {})));
    },
  };
}
export function clockComponent(store: Store, clock: Clock): Plugin {
  return {
    manifest: defineManifest(clockManifest),
    config: { schema: clockConfig },
    activate: ({ registry }) => {
      const legacy = store.get<Record<string, unknown>>('agenda.config', {});
      if (!store.get('clock.config', undefined) && typeof legacy.timezone === 'string') {
        store.set('clock.config', clockConfig.parse({ timezone: legacy.timezone }));
        const { timezone: _timezone, ...rest } = legacy;
        store.set('agenda.config', rest);
      }

      registry.register({
        name: 'clock.status',
        description: '读取时钟状态',
        owner: 'clock',
        permission: 'system.read',
        input: z.object({}),
        output: z.any(),
        mcp: false,
        run: () => ({
          timezone: configuredTimezone(store),
          local: localTimestamp(new Date(), configuredTimezone(store)),
          utc: new Date().toISOString(),
          pending: clock.pending,
        }),
      });
    },
  };
}
export function storageComponent(store: Store, plugins: PluginManager): Plugin {
  return {
    manifest: defineManifest(storageManifest),
    activate: ({ registry }) => {
      const root = dirname(store.path);
      registry.register({
        name: 'storage.status',
        description: '读取应用存储位置',
        owner: 'storage',
        permission: 'system.read',
        input: z.object({}),
        output: z.any(),
        mcp: false,
        run: async () => ({
          root,
          migration: await storageMigrationStatus(root),
          database: store.path,
          credentials: root + '/credentials',
          externalLibraries: store.documents<any>('vaults').map(({ id, path }) => ({ id, path })),
        }),
      });
      registry.register({
        name: 'storage.cancel',
        description: '取消尚未执行的数据迁移',
        owner: 'storage',
        permission: 'system.write',
        input: z.object({}),
        output: z.any(),
        mcp: false,
        run: () => cancelStorageMigration(root),
      });
      registry.register({
        name: 'storage.plan',
        description: '检查数据迁移目标与空间',
        owner: 'storage',
        permission: 'system.write',
        input: z.object({ destination: z.string().min(1) }),
        output: z.any(),
        mcp: false,
        run: (v) => planStorageMigration(root, v.destination),
      });
      registry.register({
        name: 'storage.migrate',
        description: '登记下次完整重启时执行的数据迁移',
        owner: 'storage',
        permission: 'system.write',
        input: z.object({ destination: z.string().min(1), confirmed: z.literal(true) }),
        output: z.any(),
        mcp: false,
        run: (v) =>
          requestStorageMigration(
            root,
            v.destination,
            [...plugins.plugins.values()].flatMap((plugin) => plugin.manifest.storagePaths ?? []),
          ),
      });
    },
  };
}
