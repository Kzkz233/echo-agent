/** Read-only extension metadata must not hold up the UI or lifecycle manager. */
export async function providerSnapshot<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Error('Extension metadata timed out'));
        }, 1500);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
