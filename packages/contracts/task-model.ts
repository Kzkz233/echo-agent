/** Resolve the visible task setting without consulting a hidden role route. */
export function taskModelChoice(explicit?: string, main?: string) {
  return { profileId: explicit || main, source: explicit ? 'task' as const : 'main' as const };
}

export type TaskModelReceipt = {
  profileId: string;
  model: string;
  source: 'task' | 'main' | 'resume' | 'legacy';
};
