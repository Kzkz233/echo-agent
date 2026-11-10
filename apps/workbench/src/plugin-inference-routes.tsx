import { useEffect, useState } from 'react';
import { rpc } from './client.ts';
import { t } from './i18n.ts';
import { Button, sameData, useUnsavedChanges } from './ui.tsx';
import { ModelChoice } from './model-choice.tsx';

export function PluginInferenceRoutes({ pluginId, data, act }: any) {
  const tasks = data.inference.tasks.filter(
    (task: any) =>
      task.scope !== 'character' &&
      (task.owner === pluginId || (pluginId === 'semantic' && task.owner === 'embeddings')) &&
      (task.id !== 'semantic.rerank' || data.pluginSettings.semantic?.rerankMethod === 'model') &&
      (task.id !== 'semantic.rerank-language' ||
        data.pluginSettings.semantic?.rerankMethod !== 'model'),
  );
  const [routes, setRoutes] = useState<Record<string, string>>(data.routes ?? {});
  useEffect(() => setRoutes(data.routes ?? {}), [data.routes]);
  const baseline = Object.fromEntries(
    tasks.map((task: any) => [task.id, data.routes?.[task.id] ?? '']),
  );
  const current = Object.fromEntries(tasks.map((task: any) => [task.id, routes[task.id] ?? '']));
  const dirty = tasks.length > 0 && !sameData(current, baseline);
  useUnsavedChanges(dirty, '推理任务路由');
  if (!tasks.length) return null;

  return (
    <section className="plugin-inference-routes">
      <h3>{t('模块推理模型')}</h3>
      {tasks.map((task: any) => (
        <ModelChoice
          key={task.id}
          data={data}
          taskId={task.id}
          label={task.label}
          inheritLabel="未启用"
          value={routes[task.id] ?? ''}
          onChange={(value) => setRoutes({ ...routes, [task.id]: value })}
        />
      ))}
      <div className="form-actions">
        <Button
          disabled={!dirty}
          onClick={() =>
            act(async () => {
              const saved = await rpc(
                'routes.save',
                Object.fromEntries(tasks.map((task: any) => [task.id, routes[task.id] || null])),
              );
              setRoutes(saved);
            }, t('任务路由已保存'))
          }
        >
          {t('保存任务路由')}
        </Button>
      </div>
    </section>
  );
}
