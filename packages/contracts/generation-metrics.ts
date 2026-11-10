export type ContextBreakdown = { system: number; tools: number; messages: number };
export type ContextDetail = {
  group: 'prefix' | 'tools' | 'history' | 'turn';
  source: string;
  tokens: number;
};

export type GenerationMetrics = {
  context: ContextBreakdown;
  details?: ContextDetail[];
  inputTokens?: number;
  modelSteps: number;
  tokensPerSecond?: number;
  cacheHitPercent?: number;
};

export function estimateTokens(text: string) {
  let nonAscii = 0;
  for (let index = 0; index < text.length; index++)
    if (text.charCodeAt(index) > 127) nonAscii++;
  return nonAscii + Math.ceil((text.length - nonAscii) / 3.5);
}
