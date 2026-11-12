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
  return (
    <div className="row wrap">
      <Button secondary onClick={() => act(
        () => rpc('review.resume', { id: run.id, confirmed: true, profileId }),
        t('已请求续跑'),
      )}>
        {t('确认续跑')}
      </Button>
    </div>
  );
}
