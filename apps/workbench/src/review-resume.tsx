import { useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button } from './ui.tsx';
import { ModelChoice } from './model-choice.tsx';
import { inferenceTasks } from '../../../packages/contracts/inference.ts';
import type { TaskModelReceipt } from '../../../packages/contracts/task-model.ts';

export function ReviewResume({ run, act }: {
  run: { id: string; personaId: string; runtimeVersion?: number; agentFinished?: boolean; resumeModel?: TaskModelReceipt };
  act: (run: () => Promise<unknown>, message?: string) => unknown;
}) {
  const [profileId, setProfileId] = useState('');
  if (run.runtimeVersion === 2 && run.agentFinished)
    return <Button secondary onClick={() => act(
      () => rpc('review.resume', { id: run.id, confirmed: true }),
      t('已请求续跑'),
    )}>{t('确认续跑')}</Button>;
  const expectedProfileId = profileId || run.resumeModel?.profileId;
  return (
    <div className="row wrap">
      <ModelChoice label="续跑模型" taskId={inferenceTasks.review} personaId={run.personaId}
        value={profileId} onChange={setProfileId} inheritLabel="沿用任务模型"
        inheritValue={run.resumeModel?.profileId ?? ''} showInheritedModel />
      <Button secondary disabled={!expectedProfileId} onClick={() => act(
        () => rpc('review.resume', { id: run.id, confirmed: true, profileId: profileId || undefined, expectedProfileId }),
        t('已请求续跑'),
      )}>
        {t('确认续跑')}
      </Button>
    </div>
  );
}
