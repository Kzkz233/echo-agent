import { z } from 'zod';
import { replyImageSchema } from '../contracts/index.ts';
import type { Capabilities } from './capabilities.ts';

type Scope = ReturnType<Capabilities['forOwner']>;
export const maxReplyImageBytes = 2 * 1024 * 1024;
export const replyImageBase64 = z.string().max(Math.ceil(maxReplyImageBytes / 3) * 4);

export function defineReplyImages(scope: Scope) {
  scope.define({
    id: 'core.reply-image@1',
    description: 'Read a stored image attached to a canonical assistant reply',
    input: replyImageSchema,
    output: replyImageBase64,
    providePermission: 'reply-image.provide',
    consumePermission: 'reply-image.read',
    cardinality: 'one',
  });
}

export async function readReplyImage(scope: Scope, value: unknown, signal?: AbortSignal) {
  const image = replyImageSchema.safeParse(value);
  if (!image.success) return;
  try {
    return replyImageBase64.parse(await scope.invoke('core.reply-image@1', 'files.reply-image', image.data, signal));
  } catch {
    // Optional media may disappear while plugins are unloading. Text remains deliverable.
  }
}
