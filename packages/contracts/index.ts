import { outputTargets } from './delivery.ts';
import { z } from 'zod';
import { conversationPermissions, type HostAnswer, type HostInteraction } from './interaction.ts';
import { contextCompaction } from './compaction.ts';
import type { ContextDetail, GenerationMetrics } from './generation-metrics.ts';
import type { ExecutionUpdate, SessionCapabilities, SteerRequest } from './execution.ts';
import {
  reasoning,
  reasoningStyle,
  reasoningSupportSchema,
  type ModelListing,
} from './reasoning.ts';
export { reasoning } from './reasoning.ts';
export const preferencesSchema = z.object({
  language: z.enum(['zh-CN', 'en']).default('zh-CN'),
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default('#5969c9'),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\w][\w.-]*$/);
export type Reasoning = z.infer<typeof reasoning>;
export const generationProtocol = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']);
export type GenerationProtocol = z.infer<typeof generationProtocol>;
export const profileSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  connectionId: id.optional(),
  adapterId: id.optional(),
  kind: id,
  endpoint: z.string().default(''),
  model: z.string().default(''),
  apiKeyRef: z.string().default(''),
  reasoning: reasoning.default('inherit'),
  reasoningStyle: reasoningStyle.default('auto'),
  reasoningSupport: reasoningSupportSchema.optional(),
  reasoningLevels: z
    .array(z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
    .min(1)
    .max(7)
    .optional(),
  maxOutputTokens: z.number().int().min(64).max(131072).default(65536),
  contextChars: z.number().int().min(4000).max(4000000).default(120000),
  command: z.string().default('codex'),
  args: z.array(z.string()).default(['app-server']),
  cwd: z.string().default(''),
  provider: z.string().default('openai'),
  protocol: generationProtocol.default('openai-completions'),
  api: z
    .enum(['openai-completions', 'openai-responses', 'anthropic-messages'])
    .default('openai-responses'),
  vision: z.boolean().default(false),
  modelOptions: z.record(z.string(), z.unknown()).default({}),
  embeddingDimensions: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
});
export type Profile = z.infer<typeof profileSchema>;
export type Task = string;
export const conversationSchema = z.object({
  title: z.string().min(1).max(160),
  personaId: id.default('companion'),
  injection: z.boolean().default(false),
  review: z.boolean().default(false),
  permissions: conversationPermissions.optional(),
  compaction: contextCompaction.optional(),
  kind: z.enum(['main', 'chat', 'group-member', 'worker']).optional(),
  groupId: id.optional(),
  contextProviders: z.array(id).optional(),
  reasoning: reasoning.optional(),
});
export type Message = {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  source:
    | 'human'
    | 'chat'
    | 'observation'
    | 'care'
    | 'trigger'
    | 'review'
    | 'import'
    | 'tool'
    | 'notification'
    | 'delegation'
    | 'group'
    | 'handoff';
  text: string;
  createdAt: string;
  runId?: string;
  meta: Record<string, unknown>;
};
export type Conversation = z.infer<typeof conversationSchema> & { id: string; createdAt: string };
export const messageSchema = z.object({
  id,
  conversationId: id,
  seq: z.number().int().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  source: z.enum([
    'human',
    'chat',
    'observation',
    'care',
    'trigger',
    'review',
    'import',
    'tool',
    'notification',
    'delegation',
    'group',
    'handoff',
  ]),
  text: z.string(),
  createdAt: z.string(),
  runId: id.optional(),
  meta: z.record(z.string(), z.unknown()),
});
export type Binding = {
  conversationId: string;
  profileId: string;
  epoch: number;
  sessionId?: string;
  state: 'active' | 'switching' | 'unknown';
};
export type Run = {
  id: string;
  requestId: string;
  conversationId: string;
  profileId: string;
  epoch: number;
  state: 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  input: string;
  source: Message['source'];
  result?: string;
  error?: string;
  createdAt: string;
  nativeRunId?: string;
  meta: Record<string, unknown>;
};
export type ImageInput = { data: string; mimeType: 'image/jpeg' | 'image/png' };
export type ModelInput = {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  images?: ImageInput[];
  context?: 'turn';
  messageContext?: import('./message-context.ts').MessageContext;
};
export type AgentPrincipal = {
  conversationId: string;
  personaId: string;
};
export type GenerateRequest = {
  profile: Profile;
  messages: ModelInput[];
  contextDetails?: ContextDetail[];
  sessionId?: string;
  requestId: string;
  reasoning?: Reasoning;
  permissions?: Conversation['permissions'];
  principal?: AgentPrincipal;
  toolPolicy?: 'none' | 'scoped';
  onInteraction?: (request: HostInteraction, signal: AbortSignal) => Promise<HostAnswer>;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
  onNativeRun?: (id: string) => void;
  onItem?: (item: ExecutionUpdate) => void;
  respond?: (input: import('./delivery.ts').ReplySubmission) => { accepted: true };
  replyTargets?: string[];
};
export type GenerateResult = {
  text: string;
  sessionId?: string;
  usage?: Record<string, number>;
  metrics?: GenerationMetrics;
  nativeRunId?: string;
  execution?: { model?: string; requested?: string; effort?: string };
};
export interface Backend {
  kind: Profile['kind'];
  capabilities?: (profile: Profile) => SessionCapabilities;
  listModels?: (profile: Profile) => Promise<ModelListing[]>;
  checkConnection?: (profile: Profile) => Promise<Record<string, unknown>>;
  toolCatalog?: (
    request: Pick<GenerateRequest, 'principal' | 'permissions' | 'toolPolicy'>,
  ) =>
    | Promise<{ name: string; description: string; access: string }[]>
    | { name: string; description: string; access: string }[];
  steer?: (request: SteerRequest) => Promise<void>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  createSession?(profile: Profile, history: ModelInput[], signal: AbortSignal): Promise<string>;
  archiveSession?(profile: Profile, sessionId: string): Promise<void>;
  inspect?(
    profile: Profile,
    sessionId: string,
    runId?: string,
  ): Promise<{
    state: 'running' | 'succeeded' | 'failed' | 'unknown';
    text?: string;
    error?: string;
  }>;
  close?(): Promise<void>;
  releaseConnection?(connectionId: string): Promise<void>;
  authenticate?(
    profile: Profile,
    action: 'status' | 'login' | 'cancel',
    loginId?: string,
  ): Promise<Record<string, unknown>>;
}
export class EchoError extends Error {
  constructor(
    public code: string,
    message: string,
    public uncertain = false,
  ) {
    super(message);
    this.name = 'EchoError';
  }
}
/** A provider explicitly declares that continuing at a future scheduled slot is safe.
 * This never authorizes immediate replay of the current execution. */
export class SafeTaskFailure extends EchoError {
  constructor(code: string, message: string) {
    super(code, message, false);
    this.name = 'SafeTaskFailure';
  }
}
export function invariant(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new EchoError(code, message);
}
export const personaSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  prompt: z.string().max(30000),
  portrait:z.string().max(400000).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/).optional(),
  expression: z
    .object({
      external: z.string().trim().max(600).optional(),
      chat: z.string().trim().max(600).optional(),
      channels: z.record(id, z.string().trim().max(600)).optional(),
      bubble: z.string().trim().max(600).optional(),
      stickers: z.string().trim().max(600).optional(),
    })
    .optional(),
});
export type Persona = z.infer<typeof personaSchema>;
export const observationSilence = '[ECHO_SKIP]';
export const replyImageSchema = z.object({
  provider: id,
  vaultId: id,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().max(160),
});
export type ReplyImage = z.infer<typeof replyImageSchema>;
export const observationPromptsSchema = z.object({
  observationPrompt: z
    .string()
    .max(10000)
    .default('描述可见内容、正在进行的活动和有趣的变化。简洁，不猜测画面外的情况。'),
  interactionPrompt: z
    .string()
    .max(10000)
    .default('结合近期观察自然聊聊，表达自己的感受或提出简短问题。'),
});
export const memorySchema = z.object({
  id: id.optional(),
  personaId: id,
  title: z.string().min(1).max(160),
  text: z.string().min(1).max(30000),
  core: z.boolean().default(false),
  tags: z.array(z.string().max(80)).max(30).default([]),
  sources: z.array(z.string()).default([]),
  perspective: z.enum(['objective', 'subjective', 'mixed']).optional(),
  confirmation: z.enum(['user-confirmed', 'observed', 'reported', 'inferred']).optional(),
});
export type Memory = z.infer<typeof memorySchema> & {
  id: string;
  version: string;
  updatedAt: string;
};
export const allowRuleSchema = z.object({
  id,
  type: z.enum(['website', 'process']),
  value: z.string().min(1).max(256),
  title: z.string().max(256).default(''),
  prompt: z.string().max(3000).default(''),
  enabled: z.boolean().default(true),
});
export const occlusionRuleSchema = z.object({
  id,
  type: z.literal('process').default('process'),
  value: z.string().min(1).max(256),
  title: z.string().max(256).default(''),
  prompt: z.string().max(3000).default(''),
  enabled: z.boolean().default(true),
});
export const browserAllowRuleSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  readerId: id.default('observation.uia-document'),
  type: z.literal('process').default('process'),
  value: z.string().min(1).max(256),
  title: z.string().max(256).default(''),
  enabled: z.boolean().default(true),
});
export const observationConfigSchema = z.object({
  outputTargets: outputTargets.optional(),
  id: id.default('default'),
  name: z.string().trim().min(1).max(80).default('桌面观察'),
  ...observationPromptsSchema.shape,
  enabled: z.boolean().default(false),
  conversationId: z.string().default(''),
  personaId: id.default('companion'),
  intervalSeconds: z.literal(5).default(5),
  frameCount: z.preprocess(
    (value) => typeof value === 'string' && /^(1|4|9)$/.test(value) ? Number(value) : value,
    z.union([z.literal(1), z.literal(4), z.literal(9)]),
  ).default(4),
  batchTimeoutSeconds: z.number().int().min(10).max(3600).default(120),
  historyRounds: z.number().int().min(0).max(10).default(2),
  visionReasoning: reasoning.default('inherit'),
  visionProfileId: id.optional(),
  interactionReasoning: reasoning.default('off'),
  width: z.number().int().min(280).max(1600).default(840),
  quality: z.number().int().min(35).max(95).default(75),
  minBubbleSeconds: z.number().int().min(30).max(86400).default(300),
  changedFraction: z.number().min(0).max(1).default(0.035),
  maxStillSeconds: z.number().int().min(5).max(3600).default(120),
  allowlist: z.array(allowRuleSchema).max(100).default([]),
  browserAllowlist: z.array(browserAllowRuleSchema).max(32).default([]),
  occlusionAllowlist: z.array(occlusionRuleSchema).max(50).default([]),
}).refine((config) => config.frameCount === 1 || config.batchTimeoutSeconds >= config.frameCount * 5, {
  path: ['batchTimeoutSeconds'],
  message: '组图超时过短：需至少为选定张数 × 5 秒。',
});
export type ObservationConfig = z.infer<typeof observationConfigSchema>;
export type FrameVisibility = {
  visiblePercent: number;
  litPercent: number;
  contentPercent?: number;
  sampledPercent?: number;
};
export type Frame = {
  timestamp: string;
  source: string;
  title: string;
  ruleId: string;
  sourceHints?: string[];
  visibility?: FrameVisibility;
  captureBackend?: 'gdi' | 'dxgi' | 'printwindow';
  jpeg: Buffer;
  signature: Uint8Array;
  generation: number;
};
export type Observation = {
  id: string;
  taskId?: string;
  personaId: string;
  conversationId: string;
  timestamp: string;
  frameTimes: string[];
  sources: string[];
  summary: string;
  interesting: boolean;
  attention?: string;
  latestFrame?: {
    source: string;
    title: string;
    hints?: string[];
    visibility?: FrameVisibility;
    captureBackend?: 'gdi' | 'dxgi' | 'printwindow';
  };
};
export const reviewConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['daily', 'turns', 'both']).default('daily'),
  hour: z.number().int().min(0).max(23).default(7),
  minute: z.number().int().min(0).max(59).default(0),
  timezone: z.string().default('Asia/Shanghai'),
  rounds: z.number().int().min(2).max(1000).default(30),
  packetChars: z.number().int().min(2000).max(12000).default(5000),
  autoApply: z.boolean().default(false),
  sourceIds: z.array(id).max(100).default([]),
  targetIds: z.array(id).max(30).default([]),
  reportConversationId: z.string().default(''),
  fallbackMinutes: z.number().int().min(1).max(1439).default(45),
  prompt: z.string().max(20000).default(''),
});
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
