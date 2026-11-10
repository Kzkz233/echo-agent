import { z } from 'zod';
export const parsedDocument = z.object({
  text: z.string().max(16000000),
  assets: z
    .array(
      z.object({
        name: z.string().max(1000),
        mimeType: z.string(),
        data: z.string().max(22000000),
      }),
    )
    .max(1000)
    .optional(),
});
export type ParsedDocument = z.infer<typeof parsedDocument>;
