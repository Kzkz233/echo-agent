/** Transport metadata only. Never retain payloads, headers, prompts or tool outputs. */
export function requestShape(payload: any) {
  const messages = payload.input ?? payload.messages;
  return {
    bytes: Buffer.byteLength(JSON.stringify(payload)),
    inputItems: Array.isArray(messages) ? messages.length : undefined,
    toolDefinitions: Array.isArray(payload.tools) ? payload.tools.length : 0,
    maxOutputTokens: payload.max_output_tokens ?? payload.max_tokens ?? payload.max_completion_tokens,
    reasoningEffort: ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      .includes(payload.reasoning?.effort) ? payload.reasoning.effort : undefined,
  };
}

const code = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)
  ? value : undefined;

export function providerFailure(event: any) {
  if (event?.type === 'response.failed') return { terminalEvent: 'response.failed',
    errorCode: code(event.response?.error?.code), responseStatus: code(event.response?.status) };
  if (event?.type === 'error') return { terminalEvent: 'error', errorCode: code(event.error?.type ?? event.error?.code ?? event.code) };
  return undefined;
}

export function transportHeaders(headers: Headers) {
  return Object.fromEntries(['x-request-id', 'request-id', 'x-correlation-id', 'cf-ray']
    .flatMap(name => {
      const value = headers.get(name);
      return value && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? [[name, value]] : [];
    }));
}
