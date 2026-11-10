import { z } from 'zod';
import { buildSchema } from './build.ts';

// Portable paths are deliberately narrower than host paths. Windows aliases and ADS
// must not give two archive entries the same destination.
export const updatePath = z
  .string()
  .max(300)
  .refine(
    (path) =>
      path
        .split('/')
        .every(
          (part) =>
            /^[\w@().+ -]+$/.test(part) &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
        ) &&
      !path.startsWith('/') &&
      !path.includes('\\'),
    'Invalid update package path',
  );
export const updateManifestSchema = z
  .object({
    format: z.literal('echo-update-v1'),
    platform: z.literal('win32-x64'),
    build: buildSchema,
    files: z
      .array(
        z
          .object({
            path: updatePath,
            bytes: z
              .number()
              .int()
              .min(0)
              .max(2 ** 31),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(4)
      .max(50000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = value.files.map((file) => file.path.toLowerCase());
    if (
      new Set(names).size !== names.length ||
      value.files.reduce((sum, file) => sum + file.bytes, 0) > 4 * 2 ** 30
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid update file inventory' });
    for (const required of [
      'Echo.exe',
      'runtime/node.exe',
      'runtime/dist/server.mjs',
      'runtime/dist/build-info.json',
    ])
      if (!value.files.some((file) => file.path === required))
        ctx.addIssue({ code: 'custom', message: 'Incomplete update package' });
  });
export type UpdateManifest = z.infer<typeof updateManifestSchema>;
export type UpdateJournal = {
  id: string;
  phase:
    'waiting' | 'old-moved' | 'installed' | 'verifying' | 'complete' | 'rolled-back' | 'failed';
  before: z.infer<typeof buildSchema>;
  after: z.infer<typeof buildSchema>;
  at: string;
  issue?: string;
  helperPid?: number;
};
export function newerVersion(candidate: string, current: string) {
  const a = buildSchema.shape.version.parse(candidate).split('.').map(Number);
  const b = buildSchema.shape.version.parse(current).split('.').map(Number);
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}
