import { z } from 'zod';

export const executionUpdate = z.object({
  id: z.string().min(1).max(240),
  kind: z.enum([
    'message',
    'thinking',
    'plan',
    'tool',
    'command',
    'files',
    'usage',
    'subagent',
    'status',
  ]),
  title: z.string().max(300).optional(),
  state: z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']).optional(),
  text: z.string().optional(),
  delta: z.string().optional(),
  detail: z.string().optional(),
  parentId: z.string().max(240).optional(),
});
export type ExecutionUpdate = z.infer<typeof executionUpdate>;
export type ExecutionItem = Omit<ExecutionUpdate, 'delta'> & {
  runId: string;
  conversationId: string;
  sequence: number;
  updatedAt: string;
  truncated?: boolean;
};
export type SessionCapabilities = {
  contextManagement?: 'echo' | 'host';
  outputLimit?: boolean;
  events: boolean;
  steer: boolean;
  images: boolean;
  projectTools: boolean;
};
export type SteerRequest = {
  requestId: string;
  text: string;
  images?: { data: string; mimeType: 'image/png' | 'image/jpeg' }[];
};
export const attachmentInput = z.object({
  conversationId: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  mediaType: z.string().max(100),
  data: z.string().min(1).max(11000000),
});
export type Attachment = {
  id: string;
  conversationId: string;
  name: string;
  mediaType: string;
  bytes: number;
  kind: 'image' | 'text';
  createdAt: string;
};
