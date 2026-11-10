import type { Page, Locator } from '@playwright/test';
/** Hold a task's actual text, then move the pointer. No synthetic drop events. */
export async function holdAndDrag(page: Page, source: Locator, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox(),
    to = await target.boundingBox();
  if (!from || !to) throw Error('Drag endpoints are not visible');
  await page.mouse.move(from.x + Math.min(from.width / 2, 100), from.y + from.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.move(from.x + Math.min(from.width / 2, 100) + 9, from.y + from.height / 2, {
    steps: 3,
  });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 18 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}
