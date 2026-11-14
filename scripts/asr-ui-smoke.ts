import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
const project = resolve(import.meta.dirname, '..'), base = join(tmpdir(), 'EchoTests');
await mkdir(base, { recursive: true });
const runtime = await mkdtemp(join(base, 'asr-ui-'));
const app = await Application.create({ runtime, project, plugins: ['asr'] });
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(12000);
const go = (query: string) => page.goto(`http://127.0.0.1:${http.port}/?${query}#token=${http.token}`);
try {
  await go('window=settings&page=backends');
  await page.getByRole('tab', { name: '语音识别模型', exact: true }).click();
  await page.getByRole('button', { name: '添加服务', exact: true }).click();
  await page.locator('.inference-editor').getByRole('textbox').first().fill('Synthetic ASR service');
  await page.getByLabel('llama-server 可执行文件', { exact: true }).fill(process.execPath);
  await page.getByRole('button', { name: '保存服务', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
  await page.getByRole('button', { name: '添加模型', exact: true }).last().click();
  const model = join(runtime, 'synthetic.gguf'), encoder = join(runtime, 'encoder.gguf');
  await writeFile(model, 'GGUF synthetic model'); await writeFile(encoder, 'GGUF synthetic encoder');
  await page.getByLabel('GGUF 模型文件', { exact: true }).fill(model);
  await page.getByLabel('语音编码器文件', { exact: true }).fill(encoder);
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.waitForTimeout(300);
  const saved = app.router.inference.models().find((model) => model.transcription?.enabled);
  assert(saved, 'UI did not save a transcription model');
  assert.equal(saved.generation.enabled, false); assert.equal(saved.embedding.enabled, false);
  await page.screenshot({ path: 'test-results/asr-models-ui.png' });
  await page.getByRole('tab', { name: '语言与视觉模型', exact: true }).click();
  assert.equal(await page.getByText('Synthetic ASR service', { exact: true }).count(), 0);
  await go('window=settings&page=plugins');
  await page.locator('[data-plugin="asr"]').click();
  await page.getByLabel('知识库音视频转录', { exact: true }).selectOption(saved.id);
  await page.getByRole('button', { name: '保存任务路由', exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(app.store.get<any>('routes', {})['asr.transcribe'], saved.id);
  await page.screenshot({ path: 'test-results/asr-settings-ui.png' });
  const source = join(runtime, 'silent.wav'), wav = Buffer.alloc(44 + 16000 * 2 * 5);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40); await writeFile(source, wav);
  const original = await app.files.import('local', source);
  await app.knowledge.save('local', 'Synthetic audio', `# Synthetic audio\n\n## [00:00:01](echo-asset:${original.hash}#t=1)\n\nA reference transcript.`, {
    source, sourceHash: original.hash, sourceFileId: original.id,
  });
  await go('page=knowledge');
  await page.getByText('Synthetic audio', { exact: true }).click();
  await page.getByRole('button', { name: '00:00:01', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((audio) => audio.currentTime >= 0.9));
  await page.screenshot({ path: 'test-results/asr-timestamp-ui.png' });
  // Archived reparsing is available even if the original external file is gone.
  await unlink(source);
  await page.getByRole('button',{name:'来源与版本',exact:true}).click();
  await page.getByText('重新解析归档原件',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'重新解析',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'从来源更新',exact:true}).count(),0);
  assert.equal(await page.getByRole('option',{name:'本地音视频转录',exact:true}).count(),1);
  assert.equal(await page.getByRole('option',{name:'本地文档正文',exact:true}).count(),0);
  await page.screenshot({path:'test-results/asr-reparse-ui.png'});

  assert.deepEqual(errors, []);
  await writeFile('test-results/asr-ui.json', JSON.stringify({ modelPage: true, purposeScoped: true, parserRoute: true, pageErrors: errors.length, modelCalls: 0 }));
  console.log('ASR model configuration, purpose filtering, parser routing and timestamp playback verified; no inference calls.');
} catch (error) {
  await page.screenshot({ path: 'test-results/asr-ui-failure.png' });
  console.error((await page.locator('body').innerText()).slice(-3000)); throw error;
} finally { await browser.close(); await http.close(); await app.close(); await rm(runtime, { recursive: true, force: true }); }
