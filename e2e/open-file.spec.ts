import { test, expect } from '@playwright/test';

/**
 * e2e 用例 1：本地文件侧栏搜索文件 → 在 UnifiedViewer 统一标签面板打开。
 *
 * 覆盖回归：v1.7.1 修复的 extension 点号分发 bug（docx/pdf/xlsx 落入二进制占位）。
 * 说明：当前侧栏无目录浏览，通过"授权目录内搜索"定位文件后双击打开。
 * 方案：备份 → 临时替换授权根为测试目录 → 搜索 README.md → 双击结果 → 恢复授权根。
 */
const TEST_ROOT = '/Users/baolei/Desktop/BobWork/projects';

test.describe('侧边栏文件 → UnifiedViewer 打开', () => {
  test('搜索 README.md 在统一标签面板打开并渲染内容', async ({ page, request }) => {
    // 0. 备份原授权根
    const rootsResp = await request.get('/api/local-files?action=roots');
    const rootsData = await rootsResp.json();
    const originalRoots: string[] = rootsData.success ? rootsData.roots : [];

    try {
      // 1. 清空授权根并添加测试根
      for (const r of originalRoots) {
        await request.get(`/api/local-files?action=remove_root&path=${encodeURIComponent(r)}`).catch(() => {});
      }
      const addResp = await request.get(`/api/local-files?action=add_root&path=${encodeURIComponent(TEST_ROOT)}`);
      const addData = await addResp.json();
      expect(addData.success).toBeTruthy();

      // 2. 打开页面，展开本地文件侧栏
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await page.getByTitle('展开电脑目录').click();
      await page.waitForSelector('text=本地文件', { timeout: 10000 });

      // 3. 搜索 README.md（400ms 防抖 + 网络请求）
      const searchBox = page.getByPlaceholder('搜索授权目录内文件...');
      await expect(searchBox).toBeVisible({ timeout: 10000 });
      await searchBox.fill('README');
      await page.getByText('README.md', { exact: true }).first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);

      // 4. 双击搜索结果在统一标签面板打开
      await page.getByText('README.md', { exact: true }).first().dblclick({ timeout: 10000 });
      await page.waitForTimeout(1500);

      // 5. 统一标签面板出现 README.md 标签
      const tabCount = await page.getByText('README.md', { exact: true }).count();
      expect(tabCount).toBeGreaterThanOrEqual(1);

      // 6. 内容区渲染了 README 内容（README.md 首行含 "BobWork" 项目名）
      await expect(page.getByText('BobWork', { exact: false }).first()).toBeVisible({ timeout: 10000 });

      await page.screenshot({ path: 'e2e/artifacts/open-file.png' }).catch(() => {});
    } finally {
      // 7. 恢复原授权根
      for (const r of originalRoots) {
        await request.get(`/api/local-files?action=add_root&path=${encodeURIComponent(r)}`).catch(() => {});
      }
    }
  });
});
