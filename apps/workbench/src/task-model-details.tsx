import type { TaskModelReceipt } from '../../../packages/contracts/task-model.ts';
import { t } from './i18n.ts';

const sources = {
  main: '使用主会话模型',
  task: '任务指定',
  resume: '本次续跑指定',
  legacy: '旧版默认',
};

export function TaskModelDetails({ model }: { model: TaskModelReceipt }) {
  return <small className="muted">{t('执行模型')}：{model.model} · {t(sources[model.source])}</small>;
}
