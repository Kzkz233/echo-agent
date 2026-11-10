import { z } from 'zod';

const defaultThreshold = 256_000;
export const contextCompaction = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || 'keepRecentPercent' in value) return value;
  if (!('keepRecentTokens' in value) || typeof value.keepRecentTokens !== 'number') return value;
  const threshold = 'triggerTokens' in value && typeof value.triggerTokens === 'number'
    ? value.triggerTokens : defaultThreshold;
  const percent = Math.round(value.keepRecentTokens / threshold * 1000) / 10;
  return { ...value, keepRecentPercent: Math.max(0.1, Math.min(99.9, percent)) };
}, z.object({
  triggerTokens: z.number().int().min(1024).max(2_000_000).default(defaultThreshold),
  keepRecentPercent: z.number().min(0.1).max(99.9).default(8),
}));
export type ContextCompaction = z.infer<typeof contextCompaction>;
