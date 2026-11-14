import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { setup } from './helpers.ts';
import { Mineru } from '../plugins/documents/mineru.ts';
import { documentTitle } from '../plugins/knowledge/title.ts';
import { internal } from '../packages/kernel/registry.ts';

test('document connection readiness exposes no credential and creates no remote task', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('documents');
  const status = () => app.registry.call('documents.status', {}, internal);
  assert.equal((await status()).api.configured, false);
  await app.secrets.set('parser-fixture', 'private-fixture-token');
  app.store.set('documents.config', { apiKeyRef: 'parser-fixture', command: 'mineru-kit' });
  const result = await status();
  assert.equal(result.api.configured, true);
  assert.equal(result.local.configured, true);
  assert(!JSON.stringify(result).includes('private-fixture-token'));
  assert.equal(app.store.documents('document-tasks').length, 0);
});
const zip = zipSync({
  'full.md': strToU8('# Parsed title\n\n![chart](images/a.png)\n\n$x=1$'),
  'images/a.png': Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWH8AAAAASUVORK5CYII=',
    'base64',
  ),
});
test('MinerU resumes the reserved remote task, never leaks its token to signed upload/download, and imports media', async (t) => {
  const app = await setup(t);
  await app.plugins.enable('documents');
  let submitted = 0,
    uploaded = 0,
    polls = 0;
  const controller = new AbortController();
  let base = '';
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v4/file-urls/batch') {
      assert.equal(req.headers.authorization, 'Bearer synthetic-token');
      submitted++;
      res.end(
        JSON.stringify({ code: 0, data: { batch_id: 'batch', file_urls: [base + '/upload'] } }),
      );
    } else if (req.url === '/upload') {
      assert.equal(req.headers.authorization, undefined);
      uploaded++;
      res.end('{}');
    } else if (req.url?.startsWith('/api/v4/extract-results')) {
      polls++;
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            extract_result: [
              polls === 1
                ? { state: 'running' }
                : { state: 'done', full_zip_url: base + '/result' },
            ],
          },
        }),
      );
      if (polls === 1) controller.abort();
    } else {
      assert.equal(req.headers.authorization, undefined);
      res.setHeader('Content-Type', 'application/zip');
      res.end(zip);
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  await app.secrets.set('mineru-test', 'synthetic-token');
  app.store.set('documents.config', {
    endpoint: base,
    apiKeyRef: 'mineru-test',
    timeoutSeconds: 10,
  });
  const client = new Mineru(app.project, app.store, app.secrets),
    input = {
      data: Buffer.from('fake pdf').toString('base64'),
      extension: '.pdf',
      name: 'test.pdf',
      requestId: 'same-job',
    };
  await assert.rejects(client.parse(input, controller.signal));
  assert.equal(submitted, 1);
  assert.equal(uploaded, 1);
  const parsed = await client.parse(input, new AbortController().signal);
  assert.equal(submitted, 1);
  assert.equal(uploaded, 1);
  assert.equal(parsed.assets!.length, 1);
  const text = await app.knowledge.materializeParsed('local', parsed, new AbortController().signal);
  assert.match(text, /echo-asset:[a-f0-9]{64}/);
  assert.match(text, /\$x=1\$/);
  await client.parse(input, new AbortController().signal);
  assert.equal(polls, 2, 'completed result is read locally');
  const {unlink}=await import('node:fs/promises');
  const receipt=app.store.documents<any>('document-tasks')[0];
  await unlink(join(app.runtime,'documents',receipt.id,'result.zip'));
  const recovered=await client.parse(input,new AbortController().signal);
  assert.equal(recovered.assets!.length,1);assert.equal(submitted,1);assert.equal(uploaded,1);assert.equal(polls,3);
});
test('an uncertain remote submission is never automatically submitted again', async (t) => {
  const app = await setup(t);
  let submitted = 0;
  const server = createServer((_req, res) => {
    submitted++;
    res.destroy();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  await app.secrets.set('mineru-test', 'synthetic-token');
  app.store.set('documents.config', {
    endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
    apiKeyRef: 'mineru-test',
  });
  const client = new Mineru(app.project, app.store, app.secrets),
    v = { data: 'YQ==', name: 'a.pdf', extension: '.pdf', requestId: 'unknown' };
  await assert.rejects(client.parse(v, new AbortController().signal));
  await assert.rejects(client.parse(v, new AbortController().signal), /结果未知/);
  assert.equal(submitted, 1);
});
test('explicit local MinerU uses complete stateless exports and owns its child lifecycle', async (t) => {
  const app = await setup(t),
    script = join(app.runtime, 'mineru.mjs');
  await writeFile(
    script,
    `import fs from'node:fs';const a=process.argv.slice(2);if(!a.includes('--pages')||a[a.indexOf('--pages')+1]!=='all')process.exit(2);fs.writeFileSync(a[a.indexOf('-o')+1],Buffer.from(${JSON.stringify(Buffer.from(zip).toString('base64'))},'base64'));`,
  );
  app.store.set('documents.config', { command: process.execPath, args: [script] });
  const client = new Mineru(app.project, app.store, app.secrets);
  const parsed = await client.parse(
    { data: 'YQ==', name: 'a.pdf', extension: '.pdf' },
    new AbortController().signal,
    true,
  );
  assert.match(parsed.text, /Parsed title/);
  assert.equal(parsed.assets!.length, 1);
});
test('package filenames use meaningful headings or logical parent names while normal titles stay unchanged', () => {
  assert.equal(documentTitle('content.md', '# Actual title\nbody'), 'Actual title');
  assert.equal(
    documentTitle('content.md', '# content\nbody', 'Science/Plant cells/content.md'),
    'Plant cells',
  );
  assert.equal(documentTitle('Report.pdf', '# Different heading'), 'Report.pdf');
});
