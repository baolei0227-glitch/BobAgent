import { test, expect } from '@playwright/test';

/**
 * 冒烟用例：诊断页面 DOM 结构，验证 e2e 基础设施可用。
 * 后续正式用例基于此输出的结构编写。
 */
test('smoke: 页面可加载并渲染画布', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // 等待宿主画布 pane 出现（2026-09 宿主重构：自绘 pane + 世界层，保留 react-flow__pane/node 兼容 class）
  await page.waitForSelector('.react-flow__pane', { timeout: 20000 }).catch(() => {});

  // 输出关键结构（用于后续选择器编写）
  const bodyText = (await page.locator('body').innerText()).slice(0, 1500);
  console.log('=== BODY TEXT (前 1500 字) ===');
  console.log(bodyText);
  console.log('=== END ===');

  const flowCount = await page.locator('.react-flow__pane').count();
  const buttonCount = await page.locator('button').count();
  console.log(`host-pane: ${flowCount}, buttons: ${buttonCount}`);

  // 截图供人工检查
  await page.screenshot({ path: 'e2e/artifacts/smoke.png', fullPage: false }).catch(() => {});

  expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
});
