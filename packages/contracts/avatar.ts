import { z } from 'zod';
export function avatarStateClip(state:{id:string;clip:string},config:{renderer?:string;stateRules?:Record<string,{clip?:string}>;animationClips?:Record<string,string>}) {
  return config.stateRules?.[state.id]?.clip ??
    config.animationClips?.[state.id.replace('avatar.', '')] ??
    state.clip;
}
const identity = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  directory: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const preview = z.object({
  preview: z.string().startsWith('data:image/png;base64,').max(1000000),
  width: z.number().int().min(8).max(1536),
  height: z.number().int().min(8).max(1536),
});
export const frameMaterialSchema = identity.extend({
  ...preview.shape,
  kind: z.literal('frames'),
  format: z.literal('frame-atlas-v1'),
  frames: z.number().int().min(1).max(120),
  fps: z.number().int().min(1).max(30),
  author: z.string().optional(),
  license: z.string().optional(),
});
