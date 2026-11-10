import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import type { Application } from '../apps/server/application.ts';
import { inferenceTasks } from '../packages/contracts/inference.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function inferenceWorkflows(page: Page, app: Application) {
  const ui = { kind: 'ui' as const, permissions: new Set(['*']) };
  const settle = async (fn: () => boolean) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > 5000) throw Error('Inference UI did not settle');
      await page.waitForTimeout(25);
    }
  };
  await page.locator('nav [data-section="connections"]').click();
  const sheet = page.locator('[data-view="backends"]');
  if (await sheet.count()) await sheet.click();
  await page.locator('#view-backends').waitFor();
  await page.getByRole('tab', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('Shared API fixture');
  await page.getByLabel('API Base URL', { exact: true }).fill('http://127.0.0.1:1/v1');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await settle(() =>
    app.router.inference.connections().some((c) => c.name === 'Shared API fixture'),
  );
  const shared = app.router.inference.connections().find((c) => c.name === 'Shared API fixture')!;
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型配置名称', { exact: true }).fill('Language fixture');
  await page.getByLabel('所属连接', { exact: true }).selectOption(shared.id);
  await page.getByText('手动填写模型 ID', { exact: true }).click();
  await page.getByLabel('模型 ID', { exact: true }).fill('language-fixture');
  await page.getByLabel('生成输入 · 图像', { exact: true }).check();
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await settle(() => app.router.inference.models().some((m) => m.name === 'Language fixture'));
  const language = app.router.inference.models().find((m) => m.name === 'Language fixture')!;
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型配置名称', { exact: true }).fill('Vector fixture');
  await page.getByLabel('所属连接', { exact: true }).selectOption(shared.id);
  await page.getByText('手动填写模型 ID', { exact: true }).last().click();
  await page.getByLabel('模型 ID', { exact: true }).fill('embedding-fixture');
  await page.getByLabel('文本生成', { exact: true }).uncheck();
  await page.getByLabel('向量表示（Embedding）', { exact: true }).check();
  assert(await page.getByLabel('向量输入 · 图像', { exact: true }).isDisabled());
  assert(await page.getByLabel('向量输入 · 音频', { exact: true }).isDisabled());
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await settle(() => app.router.inference.models().some((m) => m.name === 'Vector fixture'));
  const vector = app.router.inference.models().find((m) => m.name === 'Vector fixture')!;
  await page.getByRole('tab', { name: '任务路由', exact: true }).click();
  await page.getByLabel('会话生成', { exact: true }).selectOption(language.id);
  await page.getByLabel('视觉观察', { exact: true }).selectOption(language.id);
  await page.getByLabel('语义索引与召回向量', { exact: true }).selectOption(vector.id);
  await page.getByRole('button', { name: '保存任务路由', exact: true }).click();
  await settle(() => app.store.get<any>('routes', {})[inferenceTasks.embedding] === vector.id);
  assert.equal(
    await page
      .getByLabel('会话生成', { exact: true })
      .locator(`option[value="${vector.id}"]`)
      .count(),
    0,
  );
  await page.screenshot({ path: 'test-results/product/inference-routes.png' });
  await page.getByRole('tab', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('Local ONNX fixture');
  await page.getByLabel('接入方式', { exact: true }).selectOption('local');
  await page.getByRole('button', { name: '启用本地模型运行时', exact: true }).click();
  await page.getByLabel('接入器', { exact: true }).selectOption('local-models.onnx');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await settle(() =>
    app.router.inference.connections().some((c) => c.name === 'Local ONNX fixture'),
  );
  const local = app.router.inference.connections().find((c) => c.name === 'Local ONNX fixture')!;
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型配置名称', { exact: true }).fill('Local vector fixture');
  await page.getByLabel('所属连接', { exact: true }).selectOption(local.id);
  await page.getByLabel('本地 ONNX 模型路径或 ID', { exact: true }).fill('Synthetic fixture');
  assert.equal(await page.getByLabel('允许首次下载模型', { exact: true }).isChecked(), false);
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await settle(() => app.router.inference.models().some((m) => m.name === 'Local vector fixture'));
  assert.equal(app.localModels.status().loaded, 0);
  await page.screenshot({ path: 'test-results/product/inference-local.png' });
  await app.registry.call('plugins.enable', { id: 'local-models', enabled: false }, ui);
  await page
    .getByText('接入器已停用；配置仍保留，启用插件后可继续使用。', { exact: true })
    .waitFor();
  await app.registry.call('plugins.enable', { id: 'local-models', enabled: true }, ui);
  await page.getByLabel('ONNX 权重文件名', { exact: true }).waitFor();
  await app.registry.call('plugins.enable', { id: 'embeddings', enabled: false }, ui);
  await page.getByRole('tab', { name: '任务路由', exact: true }).click();
  await settle(() => !app.plugins.active.has('semantic'));
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.inference-routes label')].some((el) =>
        el.textContent?.includes('语义索引与召回向量'),
      ),
  );
  await app.registry.call('plugins.enable', { id: 'embeddings', enabled: true }, ui);
  await page.getByLabel('语义索引与召回向量', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('语义索引与召回向量', { exact: true }).inputValue(),
    vector.id,
  );
  assert.equal(app.localModels.status().loaded, 0);
  await page.getByRole('tab', { name: '文档解析', exact: true }).click();
  await page.getByLabel('解析提供方', { exact: true }).selectOption('documents.mineru-api');
  await page.getByRole('button', { name: '保存解析设置', exact: true }).click();
  await settle(
    () => app.store.get<any>('knowledge.config', {}).parserProvider === 'documents.mineru-api',
  );
  await page.getByLabel('解析提供方', { exact: true }).selectOption('documents.local');
  await page.getByRole('button', { name: '保存解析设置', exact: true }).click();
  await settle(
    () => app.store.get<any>('knowledge.config', {}).parserProvider === 'documents.local',
  );
  await page.getByRole('tab', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('GGUF fixture');
  await page.getByLabel('接入方式', { exact: true }).selectOption('local');
  await page.getByLabel('接入器', { exact: true }).selectOption('local-models.gguf');
  await page.getByLabel('llama-server 可执行文件', { exact: true }).fill(process.execPath);
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await settle(() => app.router.inference.connections().some((c) => c.name === 'GGUF fixture'));
  const gguf = app.router.inference.connections().find((c) => c.name === 'GGUF fixture')!,
    path = join(app.runtime, 'fixture.gguf');
  await writeFile(path, 'GGUF UI fixture');
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型配置名称', { exact: true }).fill('GGUF model fixture');
  await page.getByLabel('所属连接', { exact: true }).selectOption(gguf.id);
  await page.getByLabel('GGUF 模型文件', { exact: true }).fill(path);
  assert.equal(await page.getByLabel('量化', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await settle(() => app.router.inference.models().some((m) => m.name === 'GGUF model fixture'));
  assert.equal(app.localModels.status().loaded, 0);
  const projector = join(app.runtime, 'projector.gguf');
  await writeFile(projector, 'GGUF UI projector');
  await page.getByLabel('模型模板', { exact: true }).selectOption('local-models.embeddinggemma2');
  await page.getByLabel('GGUF 多模态投影文件', { exact: true }).fill(projector);
  assert(await page.getByLabel('向量输入 · 音频', { exact: true }).isChecked());
  assert(await page.getByLabel('向量输入 · 视频', { exact: true }).isChecked());
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await settle(() =>
    app.router.inference
      .models()
      .some((m) => m.name === 'EmbeddingGemma 2' && m.embedding.inputs.includes('video')),
  );
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('所属连接', { exact: true }).selectOption(local.id);
  await page.getByLabel('模型模板', { exact: true }).selectOption('local-models.bge-small-zh');
  assert.equal(
    await page.getByLabel('本地 ONNX 模型路径或 ID', { exact: true }).inputValue(),
    'Xenova/bge-small-zh-v1.5',
  );
  assert(await page.getByLabel('向量输入 · 音频', { exact: true }).isDisabled());
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await settle(() =>
    app.router.inference
      .models()
      .some((m) => m.model === 'Xenova/bge-small-zh-v1.5' && m.embedding.dimensions === 512),
  );
  assert.equal(app.localModels.status().loaded, 0);
  await page.getByRole('tab', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('Codex fixture');
  await page.getByLabel('接入方式', { exact: true }).selectOption('harness');
  await page.getByText('高级启动设置', { exact: true }).click();
  const fixture = join(app.runtime, 'codex-catalog-fixture.mjs');
  await writeFile(fixture, `import { createInterface } from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
  const req=JSON.parse(line);
  if(req.id!==undefined) console.log(JSON.stringify({id:req.id,result:req.method==='model/list'?{data:[{id:'fixture',model:'fixture',displayName:'Fixture model'}]}:{}}));
}
`);
  await page.getByLabel('可执行程序', { exact: true }).fill(process.execPath);
  const argumentsInput = page.getByLabel('启动参数（每行一个）', { exact: true });
  await argumentsInput.fill(fixture);
  await argumentsInput.press('End');
  await argumentsInput.press('Enter');
  assert.equal(await argumentsInput.inputValue(), fixture + '\n');
  await argumentsInput.pressSequentially('--example');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await settle(() => app.router.inference.connections().some((c) => c.name === 'Codex fixture'));
  assert.deepEqual(app.router.inference.connections().find((c) => c.name === 'Codex fixture')?.config.args, [fixture, '--example']);
  await page.getByRole('button', { name: '添加此连接的模型', exact: true }).click();
  await page.getByRole('option', { name: 'Fixture model', exact: true }).waitFor({ state: 'attached' });
  await page.getByLabel('Codex 模型', { exact: true }).selectOption('fixture');
  await page.getByLabel('Codex 上下文上限', { exact: true }).selectOption('128000');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await settle(() => app.router.inference.models().some((m) => m.model === 'fixture' && m.options.contextWindowTokens === 128000));
  return {
    sharedConnections: true,
    modelModalities: true,
    embeddingRouting: true,
    localRuntimeConfiguredWithoutLoading: true,
    pluginOptionsWithdrawAndRestore: true,
    ggufFileConfiguration: true,
    parserSelection: true,
    localModelPresets: true,
    audioVideoCapabilities: true,
  };
}
