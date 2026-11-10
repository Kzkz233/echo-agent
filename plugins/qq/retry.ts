export class QqFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain: boolean,
  ) {
    super(code);
  }
}
export function networkFailure(error: any) {
  const code = String(error?.cause?.code ?? error?.code ?? '');
  const certificate = /CERT|TLS|SSL|SELF_SIGNED/.test(code);
  const knownUnsent = [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ].includes(code);
  const retryable =
    !certificate &&
    (knownUnsent ||
      [
        'ETIMEDOUT',
        'ECONNRESET',
        'EPIPE',
        'UND_ERR_SOCKET',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
      ].includes(code) ||
      error?.message === 'fetch failed');
  return new QqFailure(code || 'NETWORK_FAILURE', retryable, !certificate && !knownUnsent);
}
export async function qqAttempt<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
  delay: (ms: number, signal: AbortSignal) => Promise<void>,
) {
  let uncertain = false;
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      if (signal.aborted) throw new QqFailure('CANCELLED_BEFORE_ATTEMPT', false, uncertain);
      return await run();
    } catch (error) {
      const failure = error instanceof QqFailure ? error : networkFailure(error);
      uncertain ||= failure.uncertain;
      if (attempt === 0 && failure.retryable && !signal.aborted) {
        try {
          await delay(2500, signal);
        } catch {
          throw new QqFailure('CANCELLED_DURING_BACKOFF', false, uncertain);
        }
        continue;
      }
      throw new QqFailure(failure.code, false, uncertain);
    }
  throw new QqFailure('UNEXPECTED_RETRY_END', false, true);
}
