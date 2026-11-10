import { useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button } from './ui.tsx';

export function ReviewResume({
  run,
  profileId,
  act,
}: {
  run: { id: string; policy?: { maxOutputTokens?: number } };
  profileId?: string;
  act: (run: () => Promise<unknown>, message?: string) => unknown;
}) {
  const [input, setInput] = useState('');
  const maxOutputTokens = input ? Number(input) : undefined;
  const valid = maxOutputTokens === undefined ||
    (Number.isInteger(maxOutputTokens) && maxOutputTokens >= 64 && maxOutputTokens <= 131072);
  return (
    <div className="row wrap">
      <label className="field">
        <span>{t('本次续跑输出上限（tokens）')}</span>
        <input
          type="number" min={64} max={131072} step={1}
          placeholder={run.policy?.maxOutputTokens?.toString() ?? t('沿用任务预算')}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
      </label>
      <Button secondary disabled={!valid} onClick={() => act(
        () => rpc('review.resume', { id: run.id, confirmed: true, profileId, maxOutputTokens }),
        t('已请求续跑'),
      )}>
        {t('确认续跑')}
      </Button>
    </div>
  );
}
