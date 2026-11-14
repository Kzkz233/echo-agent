import { z } from 'zod';
import { profileSchema } from './index.ts';
/** Normalized short audio segments; large originals never cross inference IPC as Base64. */
export const transcriptionInput = z.object({
  profile: profileSchema,
  audio: z.string().min(1).max(4000000).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0, 'Audio must be Base64'),
  language: z.string().max(80).default(''),
  context: z.string().max(4000).default(''),
});
export const transcriptionOutput = z.object({
  text: z.string().max(200000),
  language: z.string().optional(),
});
export const mediaExtensions = [
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.wma',
  '.mp4',
  '.mkv',
  '.webm',
  '.mov',
  '.avi',
  '.m4v',
];
