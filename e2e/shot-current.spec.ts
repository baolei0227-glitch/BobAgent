import { test } from '@playwright/test';

test('open local files dock member, measure conversation width', async ({ page }) => {
  page.setDefaultTimeout(150000);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('http://localhost:5232');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(9000);

  const m = () =>
    page.evaluate(() => {
      const w = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().width) : null);
      return {
        inner: window.innerWidth,
        navW: w(document.querySelector('aside')),
        rf: w(document.querySelector('div.react-flow__pane')),
        chat: w(document.querySelector('.ai-node-wrapper')),
        rw: w(document.querySelector('[data-reader-panel-wrapper]')),
        explorer: w(document.querySelector('[data-local-explorer-wrapper]')),
      };
    });
  console.log('BASE:', JSON.stringify(await m()));

  const localFilesBtn = page.locator('aside button[title="Local files"]').first();
  console.log('local files btn:', await localFilesBtn.count());
  if ((await localFilesBtn.count()) > 0) {
    await localFilesBtn.click();
    await page.waitForTimeout(2500);
  }
  console.log('AFTER_LOCAL_FILES:', JSON.stringify(await m()));
  await page.screenshot({ path: 'e2e/artifacts/layout-explorer.png' });
});
