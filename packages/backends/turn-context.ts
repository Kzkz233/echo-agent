import type { ModelInput } from '../contracts/index.ts';

export const isStableContext = (message: ModelInput) =>
  message.role === 'system' && !message.id && !message.context;

export function textWithTurnContext(current: ModelInput, context: ModelInput[]) {
  if (!context.length) return current.text;
  return '<echo_turn_context>\n' +
    '以下约定仅适用于本轮。历史中的同类本轮约定不再生效。\n' +
    context.map((message) => message.text).join('\n\n') +
    '\n</echo_turn_context>\n\n' + current.text;
}
