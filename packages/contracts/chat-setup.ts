import { z } from 'zod';
import { generationProtocol } from './index.ts';

export const chatServicePresets = {
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', protocol: 'openai-completions' },
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', protocol: 'openai-responses' },
  anthropic: { name: 'Anthropic', endpoint: 'https://api.anthropic.com', protocol: 'anthropic-messages' },
  ollama: { name: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1', protocol: 'openai-completions' },
} as const;
export const chatSetup = z.object({
  provider: z.enum(['deepseek', 'openai', 'anthropic', 'ollama', 'custom']),
  endpoint: z.string().url().optional(),
  protocol: generationProtocol.optional(),
  secret: z.string().max(8192).default(''),
});
export const localChatModel = 'qwen3:4b';
