const maxBatchWait = 2600;

/** Extra waits between already-composed conversational messages. The first is ready immediately. */
export function replyPartGaps(parts: readonly string[], surface: 'chat' | 'qq') {
  const [minimum, maximum] = surface === 'chat' ? [800, 1400] : [1000, 1800];
  const weights = parts.slice(1).map((part) => {
    let length = 0;
    for (const character of part) {
      if (!/\s/u.test(character) && ++length === 80) break;
    }
    return Math.sqrt(length / 80);
  });
  if (!weights.length) return [];
  const base = Math.min(minimum, maxBatchWait / weights.length);
  const extra = weights.reduce((sum, weight) => sum + weight, 0);
  const scale = extra
    ? Math.min(maximum - minimum, (maxBatchWait - base * weights.length) / extra)
    : 0;
  return weights.map((weight) => Math.floor(base + weight * scale));
}
