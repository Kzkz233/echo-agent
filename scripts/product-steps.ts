import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Application } from '../apps/server/application.ts';
import { sections } from '../apps/workbench/src/navigation.ts';
import { internal } from '../packages/kernel/registry.ts';

/** Filled product workflows. Only synthetic records in e2e's isolated temporary runtime. */
export async function productWorkflows(page: Page, app: Application) {
  const go = async (id: string) => {
    const section = sections.find((s) => s.views.some((v) => v.id === id))!;
    await page.locator(`nav [data-section="${section.id}"]`).click();
    if (section.id === 'personas' && id !== 'personas')
      await page.locator('.role-tile').first().click();
    const tab = page.locator(`[data-view="${id}"]`);
    if (await tab.count()) await tab.click();
    await page.locator(`#view-${id}`).waitFor();
  };
  const settle = async (fn: () => boolean) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > 7000) throw Error('Product workflow did not settle');
      await page.waitForTimeout(25);
    }
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mkdir('test-results/product', { recursive: true });
  await go('memory');
  await page.locator('.memory-tabs [data-memory-kind="core"]').click();
  await page.locator('.memory-card').first().waitFor();
  assert.equal(await page.locator('.memory-card').count(), 1);
  assert((await page.locator('.memory-card').textContent())?.includes('合成核心设定'));
  await page.locator('.memory-tabs [data-memory-kind="other"]').click();
  assert((await page.locator('.memory-card').textContent())?.includes('傍晚散步'));
  assert(!(await page.locator('.memory-card').textContent())?.includes('合成核心设定'));
  await page.screenshot({ path: 'test-results/product/memory-groups.png' });
  await page.locator('.memory-tabs [data-memory-kind="concerns"]').click();
  await page.getByRole('button', { name: '添加关注', exact: true }).click();
  const editor = page.locator('dialog[open]');
  await editor.getByLabel('标题', { exact: true }).fill('一起看待日常的小变化');
  await editor
    .getByLabel('在意的内容')
    .fill('我想多留意日常中让人放松的小事，也好奇今天的故事会怎样发展。');
  await editor.getByLabel('想接着关注').fill('自然地接着最近的话题聊，不必每次提问。');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await settle(() => app.store.documents('reflections').length === 1);
  await page.getByRole('heading', { name: '一起看待日常的小变化' }).waitFor();
  await page.screenshot({ path: 'test-results/product/reflections.png' });
  await app.registry.call(
    'mail.configure',
    {
      id: 'product-mail',
      name: '示例个人邮箱',
      user: 'reader@example.invalid',
      from: 'reader@example.invalid',
      provider: 'custom',
      passwordRef: 'unused',
      imap: { host: 'example.invalid', port: 993 },
      smtp: { host: 'example.invalid', port: 465 },
    },
    internal,
  );
  app.store.put('mail-folders', 'product-mail', {
    id: 'product-mail',
    items: [
      { path: 'INBOX', name: '收件箱' },
      { path: 'Sent', name: '已发送', specialUse: '\\Sent' },
      { path: 'Archive', name: '归档', specialUse: '\\Archive' },
    ],
  });
  for (let n = 0; n < 6; n++)
    app.store.put('mail', 'product-mail-' + n, {
      id: 'product-mail-' + n,
      accountId: 'product-mail',
      personaId: 'companion',
      mailbox: 'INBOX',
      uid: n + 1,
      validity: '1',
      subject: [
        '本周阅读清单',
        '项目进度回顾',
        '会议资料已更新',
        '新的文献推荐',
        '周末活动安排',
        '订阅更新',
      ][n],
      from: 'Example Team <team@example.invalid>',
      to: 'reader@example.invalid',
      date: new Date(Date.now() - n * 3600000).toISOString(),
      seenAt: new Date().toISOString(),
      size: 100,
      text: '这是一封用于界面验收的示例邮件，没有连接外部邮箱。\n\n所有内容均为合成资料。',
      flags: n > 1 ? ['\\Seen'] : [],
    });
  await go('mail');
  await page.getByRole('button').filter({ hasText: '本周阅读清单' }).click();
  await page
    .getByText('这是一封用于界面验收的示例邮件，没有连接外部邮箱。', { exact: false })
    .waitFor();
  await page.screenshot({ path: 'test-results/product/mail.png' });
  await page.getByRole('tab', { name: '账户设置', exact: true }).click();
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByLabel('邮箱类型').selectOption('gmail');
  await page
    .locator('.account-editor select')
    .filter({ has: page.locator('option[value="environment-proxy"]') })
    .selectOption('environment-proxy');
  assert.equal(await page.getByLabel('IMAP 服务器').inputValue(), 'imap.gmail.com');
  await page.screenshot({ path: 'test-results/product/mail-setup.png' });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  let remoteMarks = 0;
  const connection = (app.mail as any).connect;
  (app.mail as any).connect = async () => ({
    client: {
      mailbox: { uidValidity: '1' },
      getMailboxLock: async () => ({ release() {} }),
      fetchOne: async () => ({ uid: 1, flags: new Set() }),
      messageFlagsAdd: async () => {
        remoteMarks++;
        return true;
      },
    },
    close: async () => {},
  });
  await go('mail');
  await page.getByRole('tab', { name: '收件箱', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择邮件 本周阅读清单', exact: true }).check();
  await page.getByRole('button', { name: '标为已读', exact: true }).click();
  await page.locator('.feature-list .document-row').filter({ hasText: '整理邮件' }).click();
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await page
    .locator('.confirm-dialog')
    .getByRole('button', { name: '批准执行', exact: true })
    .click();
  await page.locator('.approval-result[data-receipt-state="succeeded"]').waitFor();
  assert.equal(remoteMarks, 1);
  assert.ok(app.store.document<any>('mail', 'product-mail-0').flags.includes('\\Seen'));
  (app.mail as any).connect = connection;
  await go('care');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('目标会话').selectOption(app.store.conversations()[0].id);
  await page.getByLabel('主动交流提示词').fill('Synthetic interaction guidance.');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await settle(
    () => app.care.rules().some((rule) => rule.prompt === 'Synthetic interaction guidance.'),
  );
  await go('assets');
  assert.equal(
    await page.locator('.confirm-dialog[open]').count(),
    0,
    'Saved proactive settings must not leave a dirty draft',
  );
  await page.getByRole('button', { name: '导入素材', exact: true }).click();
  const assetDialog = page.locator('dialog[open]');
  await assetDialog
    .getByLabel('原件路径', { exact: true })
    .fill(
      join(
        app.knowledge.project,
        'apps',
        'workbench',
        'public',
        'assets',
        'cute-girl',
        'atlas.png',
      ),
    );
  await assetDialog.getByLabel('素材名称', { exact: true }).fill('Synthetic character atlas');
  await assetDialog.getByLabel('标签，逗号分隔').fill('example, animation');
  await assetDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.asset-tile img').waitFor();
  await page.getByRole('button', { name: 'Synthetic character atlas', exact: false }).click();
  await page.locator('.asset-preview-dialog[open]>img').waitFor();
  await page.screenshot({ path: 'test-results/product/assets.png' });
  await page.keyboard.press('Escape');
  await go('files');
  await page.getByRole('cell', { name: 'atlas.png', exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/product/files.png' });
  return {
    reflections: true,
    mailProviderSetup: true,
    proactiveSaveClearsDirtyState: true,
    assetGalleryAndPreview: true,
    originalFileList: true,
    mailOrganizationApprovalReceipts: true,
  };
}
