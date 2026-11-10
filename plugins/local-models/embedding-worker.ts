import { parentPort } from 'node:worker_threads';
import { configureNetwork } from '../../packages/kernel/network.ts';
configureNetwork();
let pipelineInstance: any,
  fingerprint = '';
parentPort!.on('message', async ({ id, config, texts }) => {
  try {
    const packageName = '@huggingface/transformers';
    const { pipeline, env } = await import(packageName);
    env.allowRemoteModels = config.allowDownload === true;
    if (config.downloadBaseUrl) {
      if (!config.downloadBaseUrl.startsWith('https://')) throw Error('模型下载地址需要 HTTPS。');
      env.remoteHost = config.downloadBaseUrl.replace(/\/?$/, '/');
    }
    if (config.cacheDir) env.cacheDir = config.cacheDir;
    const next = JSON.stringify([config.model, config.modelPath, config.weightsFile]);
    if (fingerprint !== next) {
      await pipelineInstance?.dispose();
      pipelineInstance = await pipeline('feature-extraction', config.modelPath ?? config.model, {
        dtype: 'fp32',
        model_file_name: config.weightsFile.replace(/\.onnx$/, ''),
        device: 'cpu',
        local_files_only: !config.allowDownload,
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
      });
      fingerprint = next;
    }
    const tensor = await pipelineInstance(texts, { pooling: 'mean', normalize: true });
    parentPort!.postMessage({ id, vectors: tensor.tolist() });
  } catch (e) {
    parentPort!.postMessage({ id, error: e instanceof Error ? e.message : '本地向量模型失败。' });
  }
});
