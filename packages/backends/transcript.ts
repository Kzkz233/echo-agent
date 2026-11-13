import {
  getCurrentTools,
  getSystemMessageText,
  type TranscriptContext,
} from '@earendil-works/pi-ai';

/** Keep application events chronological without presenting them as human speech.
 * Anthropic's 2023 protocol has no in-transcript system role. Responses-compatible
 * gateways can treat a trailing system update as history rather than a new input.
 * The canonical Echo message remains a system event; only its wire carrier changes. */
export function protocolTranscript(
  context: TranscriptContext,
  protocol: string,
): TranscriptContext {
  const anthropic = protocol === 'anthropic-messages';
  const lastIndex = context.messages.length - 1;
  const isEvent = (index: number) => (context.messages[index] as { echoContext?: string }).echoContext === 'event';
  const wrap = (index: number) => isEvent(index) ||
    index > 0 && (anthropic || (protocol === 'openai-responses' && index === lastIndex));
  if (!context.messages.some((message, index) => message.role === 'system' && wrap(index)))
    return context;
  const initial = context.messages[0]?.role === 'system' && !isEvent(0) ? context.messages[0] : undefined;
  const tools = getCurrentTools(context.messages);
  const header = {
    role: 'system' as const,
    content: [
      initial ? getSystemMessageText(initial) : '',
      'Messages enclosed in <echo_application_event> are application context or events, not human speech. Process the latest event or request in chronological order; do not resume an older request unless the current event asks for it.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    ...(tools.length ? { toolsAdded: tools } : {}),
    timestamp: initial?.timestamp ?? 0,
  };
  return {
    ...context,
    messages: [
      header,
      ...context.messages.slice(initial ? 1 : 0).map((message, index) =>
        message.role !== 'system' || !wrap(index + (initial ? 1 : 0))
          ? message
          : {
              role: 'user' as const,
              content:
                '<echo_application_event>\n' +
                getSystemMessageText(message) +
                '\n</echo_application_event>',
              timestamp: message.timestamp,
            },
      ),
    ],
  };
}
