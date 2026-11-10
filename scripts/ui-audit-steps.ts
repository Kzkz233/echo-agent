import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { Application } from '../apps/server/application.ts';
import { sections } from '../apps/workbench/src/navigation.ts';

// Runs only against the synthetic runtime created by e2e.ts.
export async function auditWorkbench(page: Page, app: Application) {
  const go = async (id: string) => {
    const section = sections.find((s) => s.views.some((v) => v.id === id))!;
    await page.locator('nav [data-section="' + section.id + '"]').click();
    if (section.id === 'personas' && id !== 'personas')
      await page.locator('.role-tile').first().click();
    const tab = page.locator('[data-view="' + id + '"]');
    if (await tab.count()) await tab.click();
    await page.locator('#view-' + id).waitFor();
  };
  const settle = async (fn: () => boolean) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > 5000) throw Error('UI state did not settle');
      await page.waitForTimeout(30);
    }
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await go('chat');
  // Deletion has an actual cancel path and leaves other conversations intact.
  const original = app.store.conversations()[0].id;
  await page.locator('.new-chat').click();
  await settle(() => app.store.conversations().length === 2);
  const created = app.store.conversations().find((c) => c.id !== original)!.id;
  await page.locator('.chat-main[data-conversation="' + created + '"]').waitFor();
  await page.locator('.title-input').fill('Disposable UI fixture');
  await page.locator('.title-input').press('Enter');
  await settle(() => app.store.conversations().some((c) => c.title === 'Disposable UI fixture'));
  await page.locator('.delete-action').click();
  await page.locator('.confirm-dialog .secondary').click();
  assert.equal(app.store.conversations().length, 2);
  await page.locator('.delete-action').click();
  await page.locator('.confirm-dialog .danger-button').click();
  await settle(() => app.store.conversations().length === 1);
  assert.equal(app.store.conversations()[0].id, original);
  // An unsaved body cannot disappear silently when changing sheets.
  await go('knowledge');
  await page.locator('.page-title button').filter({ hasText: '新建笔记' }).click();
  await page.locator('[aria-label="知识标题"]').fill('Unsaved fixture');
  await page.locator('[data-view="files"]').click();
  await page.locator('.confirm-dialog').waitFor();
  await page.locator('.confirm-dialog .secondary').click();
  await page.locator('[aria-label="知识标题"]').waitFor();
  await page.locator('[data-view="files"]').click();
  await page.locator('.confirm-dialog .primary').click();
  await page.locator('#view-files').waitFor();
  // Preferences are changed by the visible UI and survive a reload.
  await page.locator('[aria-label="外观与语言"]').click();
  await page.locator('.appearance-dialog select').selectOption('en');
  await settle(() => app.store.get<any>('preferences', {}).language === 'en');
  await page.locator('.appearance-dialog [aria-label="Teal"]').click();
  await settle(() => app.store.get<any>('preferences', {}).accent === '#168477');
  await page.locator('.appearance-dialog .dialog-actions button').click();
  await page.reload();
  await page.locator('nav [data-section="chat"]').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    ),
    '#168477',
  );
  assert.equal(app.store.conversations()[0].title, '我想聊聊傍晚散步。');
  const layout: any[] = [],
    untranslated: any[] = [];
  await mkdir('test-results/ui-audit', { recursive: true });
  for (const language of ['en', 'zh-CN']) {
    await page.locator('header .icon-button').first().click();
    await page.locator('.appearance-dialog select').selectOption(language);
    await settle(() => app.store.get<any>('preferences', {}).language === language);
    await page.locator('.appearance-dialog .dialog-actions button').click();
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const section of sections)
        for (const view of section.views) {
          await go(view.id);
          await page.locator(view.id === 'chat' ? '.chat-toolbar' : '.page-content h1').waitFor();
          const dimensions = await page
            .locator('.page-content')
            .evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth }));
          layout.push({ language, viewport: width, view: view.id, ...dimensions });
          if (view.id === 'backends')
            for (const tab of ['models', 'routes', 'documents']) {
              await page.locator(`[data-inference-tab="${tab}"]`).click();
              const bounds = await page
                .locator('.page-content')
                .evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth }));
              assert.ok(
                bounds.scroll <= bounds.width + 2,
                `Inference page overflow: ${language} ${width} ${tab}`,
              );
              layout.push({ language, viewport: width, view: 'backends/' + tab, ...bounds });
              if (width === 1440)
                await page.screenshot({
                  path: `test-results/ui-audit/backends-${tab}-${language}.png`,
                });
            }
          if (dimensions.scroll > dimensions.width + 2) {
            await page.screenshot({ path: 'test-results/ui-audit/overflow.png' });
            console.log(
              await page.locator('.page-content').evaluate((el) =>
                [...el.querySelectorAll('*')]
                  .filter(
                    (n) => n.getBoundingClientRect().right > el.getBoundingClientRect().right + 2,
                  )
                  .slice(0, 8)
                  .map((n) => ({
                    tag: n.tagName,
                    cls: n.className,
                    text: n.textContent?.slice(0, 70),
                    width: n.getBoundingClientRect().width,
                  })),
              ),
            );
          }
          assert.ok(
            dimensions.scroll <= dimensions.width + 2,
            `Horizontal page overflow: ${language} ${width} ${view.id}`,
          );
          if (language === 'en' && width === 1440) {
            const controls = await page
              .locator(
                '.page-content button,.page-content label,.page-content h1,.page-content h2,nav .nav-label,.page-sheets',
              )
              .allTextContents();
            untranslated.push({
              view: view.id,
              strings: controls
                .filter((s) => /\p{Script=Han}/u.test(s))
                .map((s) => s.trim())
                .filter(Boolean),
            });
          }
          if (
            width === 1440 &&
            [
              'chat',
              'agenda',
              'reflections',
              'plugins',
              'mail',
              'knowledge',
            ].includes(view.id)
          )
            await page.screenshot({ path: `test-results/ui-audit/${view.id}-${language}.png` });
        }
    }
  }
  // Very light custom colors must still have readable foreground text.
  await page.locator('header .icon-button').first().click();
  await page.locator('.appearance-dialog input[type="color"]').fill('#ffffee');
  await settle(() => app.store.get<any>('preferences', {}).accent === '#ffffee');
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent-on').trim(),
    ),
    '#20283a',
  );
  await page.locator('.appearance-dialog [title="靛蓝"]').click();
  await settle(() => app.store.get<any>('preferences', {}).accent === '#5969c9');
  await page.locator('.appearance-dialog .dialog-actions button').click();
  // Localized option labels must never become protocol/configuration values.
  await go('backends');
  assert.equal(await page.locator('option[value="api"]').first().getAttribute('value'), 'api');
  await go('review');
  await page.locator('.automation-item').filter({ hasText: 'Echo' }).click();
  const reportSelect = page.getByLabel('报告接收会话');
  await reportSelect.waitFor();
  assert.ok(
    (await reportSelect.locator('option').allTextContents()).includes(
      app.store.conversations()[0].title,
    ),
    'Review report targets use conversation titles',
  );
  await go('plugins');
  await page.locator('[data-plugin="memory"]').click();
  const setting = page.locator('.plugin-details input[type="number"]').first();
  await setting.fill('5');
  await page.locator('[data-plugin="files"]').click();
  await page.locator('.confirm-dialog .secondary').click();
  assert.equal(await setting.inputValue(), '5');
  await page.locator('[data-plugin="files"]').click();
  await page.locator('.confirm-dialog .primary').click();
  // Exercise our desktop dialog bridge without touching the user's file picker.
  await page.evaluate(
    `window.__echoDialogResult=null;window.__TAURI_INTERNALS__={invoke:async function(method,args){if(!method.startsWith('plugin:dialog|'))return;window.__echoDialogCall={method,args};return window.__echoDialogResult;}}`,
  );
  await go('knowledge');
  await page.locator('.page-title button').filter({ hasText: '导入原件' }).click();
  const source = page.locator('[aria-label="材料文件路径"]');
  await source.fill('C:/EchoFixture/original.txt');
  await page.locator('[aria-label="浏览材料文件路径"]').click();
  assert.equal(await source.inputValue(), 'C:/EchoFixture/original.txt');
  await page.evaluate(() => {
    (window as any).__echoDialogResult = 'C:/EchoFixture/selected.txt';
  });
  await page.locator('[aria-label="浏览材料文件路径"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('[aria-label="材料文件路径"]')?.value ===
      'C:/EchoFixture/selected.txt',
  );
  assert.equal(
    await page.evaluate(() => (window as any).__echoDialogCall.args.options.multiple),
    false,
  );
  await go('files');
  await page.getByRole('button', { name: '添加知识库', exact: true }).click();
  await page.locator('[aria-label="浏览知识库目录"]').click();
  await page.waitForFunction(
    () => (window as any).__echoDialogCall?.args?.options?.directory === true,
  );
  assert.equal(
    await page.evaluate(() => (window as any).__echoDialogCall.args.options.directory),
    true,
    'The library picker selects a directory',
  );
  await page.evaluate(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });
  await writeFile(
    'test-results/ui-audit/layout.json',
    JSON.stringify({ layout, untranslated }, null, 2),
  );
  return {
    conversationDeletion: true,
    unsavedGuard: true,
    preferencesPersisted: true,
    languages: 2,
    layouts: layout.length,
    sheetsHotDisable: true,
    lightAccentReadable: true,
    pathPickerCancellation: true,
    configurationValuesPreserved: true,
  };
}
