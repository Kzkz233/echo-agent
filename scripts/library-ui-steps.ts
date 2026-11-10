import assert from 'node:assert/strict';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Page } from '@playwright/test';
import type { Application } from '../apps/server/application.ts';
import { sections } from '../apps/workbench/src/navigation.ts';
export async function libraryWorkflows(page: Page, app: Application, runtime: string) {
  const checkAssetCard = async () => {
    const overflow = await page.locator('.avatar-preview').evaluate((card) => {
      const bounds = card.getBoundingClientRect();
      return [...card.querySelectorAll('img,button,input,select')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 && r.height > 0 && (r.top < bounds.top || r.bottom > bounds.bottom + 1)
          );
        })
        .map((el) => el.tagName);
    });
    assert.deepEqual(overflow, [], 'Asset preview and import controls stay inside their card');
  };
  const go = async (id: string) => {
    const section = sections.find((s) => s.views.some((v) => v.id === id))!;
    await page.locator(`nav [data-section="${section.id}"]`).click();
    if (section.id === 'personas' && id !== 'personas')
      await page.locator('.role-tile').first().click();
    const tab = page.locator(`[data-view="${id}"]`);
    if (await tab.count()) await tab.click();
    await page.locator(`#view-${id}`).waitFor();
  };
  await app.files.register({
    id: 'second-test',
    name: 'Second test library',
    path: join(runtime, 'Second'),
  });
  await app.knowledge.save('local', 'Folder fixture', 'Synthetic local content', {
    path: 'Work/Notes/local.md',
  });
  await app.knowledge.save('second-test', 'Second fixture', 'Synthetic second content', {
    path: 'Personal/Reading/second.md',
  });
  await go('knowledge');
  const picker = page.getByLabel('当前知识库', { exact: true });
  await picker.selectOption('local');
  const tree = page.getByRole('tree');
  await tree.getByRole('button', { name: 'Work', exact: true }).waitFor();
  assert.equal(await tree.getByRole('button', { name: 'Notes', exact: true }).count(), 0);
  await tree.getByRole('button', { name: '展开目录 Work', exact: true }).click();
  await tree.getByRole('button', { name: 'Notes', exact: true }).waitFor();
  await page.getByRole('button', { name: '全部收起', exact: true }).click();
  assert.equal(await tree.getByRole('button', { name: 'Notes', exact: true }).count(), 0);
  await picker.selectOption('second-test');
  await tree.getByRole('button', { name: 'Personal', exact: true }).waitFor();
  assert.equal(await tree.getByRole('button', { name: 'Work', exact: true }).count(), 0);
  await page.getByRole('button', { name: '高级搜索', exact: true }).click();
  const strategy = page.getByLabel('检索策略', { exact: true });
  await strategy.selectOption('semantic');
  assert.equal(await strategy.inputValue(), 'semantic');
  await strategy.selectOption('hybrid');
  await app.registry.call(
    'plugins.enable',
    { id: 'semantic', enabled: false },
    {
      kind: 'ui',
      permissions: new Set(['*']),
    },
  );
  await page.waitForFunction(() => {
    const field = document.querySelector('[aria-label="检索策略"]') as HTMLSelectElement;
    return (
      field?.value === 'keyword' &&
      field.querySelector<HTMLOptionElement>('option[value="semantic"]')?.disabled
    );
  });
  assert.equal(
    await strategy
      .locator('option[value="semantic"]')
      .evaluate((el) => (el as HTMLOptionElement).disabled),
    true,
  );
  await app.registry.call(
    'plugins.enable',
    { id: 'semantic', enabled: true },
    {
      kind: 'ui',
      permissions: new Set(['*']),
    },
  );
  await page.waitForFunction(
    () =>
      !(
        document.querySelector(
          '[aria-label="检索策略"] option[value="semantic"]',
        ) as HTMLOptionElement
      )?.disabled,
  );
  await strategy.selectOption('keyword');
  await page.getByRole('button', { name: '向量索引', exact: true }).click();
  await page.getByRole('button', { name: '建立向量索引', exact: true }).waitFor();
  assert.equal(
    app.store.documents('vectors').length,
    0,
    'Merely viewing index status never calls embeddings',
  );
  await picker.selectOption('managed-memory');
  await page.locator('.managed-library-note').waitFor();
  assert.ok(await page.getByRole('button', { name: '导入原件', exact: true }).isDisabled());
  await picker.selectOption('local');
  await page.screenshot({ path: 'test-results/product/library-advanced.png' });
  await go('avatar');
  const renderer = page.getByLabel('Character renderer', { exact: true });
  await renderer.selectOption('frames');
  await page.getByRole('button', { name: '导入帧动画素材', exact: true }).click();
  const image = join(runtime, 'import-preview.png');
  await sharp({ create: { width: 32, height: 40, channels: 4, background: '#eeaaff' } })
    .png()
    .toFile(image);
  await page.getByLabel('桌宠素材来源', { exact: true }).fill(image);
  await page.getByLabel('素材名称', { exact: true }).fill('Imported fixture');
  await checkAssetCard();
  await page.getByRole('button', { name: '导入素材', exact: true }).click();
  await page
    .getByRole('option', { name: 'Imported fixture', exact: true })
    .waitFor({ state: 'attached' });
  assert.equal(app.store.documents('avatar-assets').length, 1);
  assert.equal(app.store.get<any>('avatar.config', {}).assetDirectory ?? '', '');
  await page.getByRole('img', { name: 'Imported fixture', exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/product/avatar-import.png' });
  await go('diagnostics');
  const options = page.locator('.mcp-permission-options');
  await options.waitFor({ state: 'visible' });
  const gap = await options.evaluate(
    (element) =>
      element.nextElementSibling!.getBoundingClientRect().top -
      element.getBoundingClientRect().bottom,
  );
  assert.ok(gap >= 20, 'MCP save action has separate spacing: ' + gap);
  return {
    treeScopeAndCollapse: true,
    searchStrategies: true,
    explicitIndex: true,
    managedLibraryReadOnly: true,
    avatarImport: true,
    mcpSpacing: true,
  };
}
