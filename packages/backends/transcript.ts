import {
  getCurrentTools,
  getSystemMessageText,
  type TranscriptContext,
} from '@earendil-works/pi-ai';

/** Anthropic's 2023 Messages protocol has no in-transcript system role.
 * Keep application events at their chronological position in marked transport
 * envelopes, rather than hoisting them ahead of the user request. The canonical
 * Echo message remains a system event; this is only the protocol representation. */
export function protocolTranscript(
  context: TranscriptContext,
  protocol: string,
): TranscriptContext {
  if (
    protocol !== 'anthropic-messages' ||
    !context.messages.some((message, index) => index > 0 && message.role === 'system')
  )
    return context;
  const initial = context.messages[0]?.role === 'system' ? context.messages[0] : undefined;
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
      ...context.messages.slice(initial ? 1 : 0).map((message) =>
        message.role !== 'system'
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
