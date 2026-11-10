import { z } from 'zod';
import { version } from './version.ts';

export const buildSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  edition: z.enum(['public', 'private', 'development']),
  buildId: z.string().min(1).max(100),
  builtAt: z.string().datetime(),
  dataVersion: z.literal(1),
});
export type BuildInfo = z.infer<typeof buildSchema>;
declare const __ECHO_BUILD__: BuildInfo | undefined;
export const buildInfo: BuildInfo =
  typeof __ECHO_BUILD__ === 'undefined'
    ? {
        version,
        edition: 'development',
        buildId: 'development',
        builtAt: '1970-01-01T00:00:00.000Z',
        dataVersion: 1,
      }
    : buildSchema.parse(__ECHO_BUILD__);
