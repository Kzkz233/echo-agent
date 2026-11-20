import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Application } from '../apps/server/application.ts';
import { serve } from '../apps/server/http.ts';
import { profileSchema } from '../packages/contracts/index.ts';
import { internal } from '../packages/kernel/registry.ts';
import { characterDraft } from '../plugins/persona/character-contracts.ts';
import { seedProfile } from './inference-fixture.ts';

const project = resolve(import.meta.dirname, '..');
const app = await Application.create({
  project,
  runtime: await mkdtemp(join(tmpdir(), 'echo-library-ui-')),
});
await app.plugins.enable('zotero');
await app.plugins.enable('memory');
seedProfile(
  app,
  profileSchema.parse({
    id: 'fixture',
    kind: 'api',
    name: 'Fixture',
    model: 'fixture',
    endpoint: 'http://127.0.0.1:1/v1',
  }),
);
await app.registry.call(
  'persona.character.commit',
  {
    requestId: 'create-fixture',
    draft: characterDraft.parse({
      persona: { id: 'fixture-role', name: 'Fixture', prompt: 'Isolated fixture' },
      profileId: 'fixture',
      features: ['memory'],
    }),
  },
  internal,
);
app.store.set('zotero.config', { serverId: 'fixture', secretRef: 'fixture' });
await app.secrets.set('fixture', 'isolated-test-only');
const linked = await app.knowledge.save('local','Fixture knowledge entry','Preserved original text.');
app.store.put('zotero-references','fixture-link',{
  serverId:'fixture',itemKey:'REFBBBBB',vaultId:'local',documentId:linked.id,sha256:'a'.repeat(64),
});
const network = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== 'http://127.0.0.1:23119') return network(input, init);
  assert.equal(init?.method ?? 'GET', 'GET');
  const record = (key: string, data: object) => ({ key, version: 1, data });
  if (url.pathname.endsWith('/collections'))
    return Response.json([record('COLLECTA', { name: 'Lab group' })]);
  if (url.searchParams.has('itemType'))
    return Response.json([
      record('FILEAAAA', {
        filename: 'example.pdf',
        contentType: 'application/pdf',
        parentItem: 'REFBBBBB',
        linkMode: 'imported_file',
      }),
    ]);
  return Response.json([
    record('REFBBBBB', {
      title: 'First paper',
      extra: 'Caption: Example short comment\nRating: 4',
      collections: ['COLLECTA'],
    }),
    record('REFCCCCC', { title: 'Second paper', collections: [] }),
  ]);
};
const http = await serve(app, { webRoot: join(project, 'dist/web') });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 850 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    `http://127.0.0.1:${http.port}/?workspace=true&page=knowledge#token=${http.token}`,
  );
  const tabs = page.getByRole('tablist', { name: '知识库', exact: true });
  await tabs.getByRole('tab', { name: '个人知识库', selected: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: '当前知识库' }).count(), 0);
  await tabs.getByRole('tab', { name: '文献库', exact: true }).click();
  const catalog = page.locator('[data-plugin-page="zotero.library"]');
  await catalog.getByRole('cell', { name: 'Example short comment' }).waitFor();
  await catalog.getByRole('cell', { name: 'example.pdf' }).waitFor();
  await catalog.getByRole('button',{name:'First paper'}).click();
  await catalog.getByRole('button',{name:'打开知识条目'}).click();
  await catalog.getByText('Preserved original text.',{exact:true}).waitFor();
  assert(await tabs.getByRole('tab',{name:'文献库',selected:true}).isVisible());
  await catalog.getByRole('button', { name: 'Lab group' }).click();
  await catalog.getByRole('button', { name: 'First paper' }).waitFor();
  await catalog.getByRole('button', { name: 'Second paper' }).waitFor({ state: 'hidden' });
  await catalog.getByRole('button', { name: 'First paper' }).waitFor();
  await page.setViewportSize({ width: 900, height: 780 });
  await catalog.getByRole('combobox', { name: '知识分组' }).selectOption('');
  await catalog.getByRole('button', { name: 'Second paper' }).waitFor();
  await catalog.getByRole('searchbox').fill('Second');
  await catalog.getByRole('button', { name: 'First paper' }).waitFor({ state: 'hidden' });
  await catalog.getByRole('button', { name: 'Second paper' }).click();
  await catalog.getByRole('heading', { name: 'Second paper' }).waitFor();
  await tabs.getByRole('tab', { name: '角色记忆' }).click();
  await page
    .locator('[data-plugin-page="memory.library"]')
    .getByRole('combobox', { name: '角色', exact: true })
    .waitFor();
  await tabs.getByRole('tab', { name: '个人知识库' }).click();
  await page.getByRole('heading', { name: '个人知识库' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Passed isolated library navigation, collection filtering, metadata, search, and memory scope.',
  );
} finally {
  globalThis.fetch = network;
  await browser.close();
  await http.close();
  await app.close();
}
