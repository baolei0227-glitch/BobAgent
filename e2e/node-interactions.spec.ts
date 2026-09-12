import { test, expect } from '@playwright/test';

/**
 * e2e 用例 2：节点交互安全网
 *   - 发送文件到当前节点附件（覆盖 add-attachment 链路）
 *   - （用例 4「新建便签」已随 2026-09 便签入口移除而下线）
 */
const TEST_ROOT = '/Users/baolei/Desktop/BobWork/projects';

async function backupRoots(request: import('@playwright/test').APIRequestContext): Promise<string[]> {
  const resp = await request.get('/api/local-files?action=roots');
  const data = await resp.json();
  return data.success ? data.roots : [];
}

async function restoreRoots(request: import('@playwright/test').APIRequestContext, roots: string[]) {
  for (const r of roots) {
    await request.get(`/api/local-files?action=add_root&path=${encodeURIComponent(r)}`).catch(() => {});
  }
}

test.describe('节点交互', () => {
  test('发送文件到当前节点附件', async ({ page, request }) => {
    const originalRoots = await backupRoots(request);
    try {
      for (const r of originalRoots) {
        await request.get(`/api/local-files?action=remove_root&path=${encodeURIComponent(r)}`).catch(() => {});
      }
      await request.get(`/api/local-files?action=add_root&path=${encodeURIComponent(TEST_ROOT)}`);

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // 1. 激活节点（点击 AI Chat 节点）
      await page.getByText('AI Chat', { exact: true }).first().click();
      await page.waitForTimeout(500);

      // 2. 展开电脑目录（本地文件侧栏）
      await page.getByTitle('展开电脑目录').click();
      await page.waitForSelector('text=本地文件', { timeout: 10000 });

      // 3. 搜索 README.md → hover 结果行 → 点击 "+"（发送到当前节点）
      const searchBox = page.getByPlaceholder('搜索授权目录内文件...');
      await expect(searchBox).toBeVisible({ timeout: 10000 });
      await searchBox.fill('README');
      await page.getByText('README.md', { exact: true }).first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);

      const row = page.getByText('README.md', { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"group")]');
      await row.hover({ timeout: 10000 });
      const addBtn = row.locator('button[title="添加到当前节点附件"]').or(row.locator('button[title="发送到当前节点"]'));
      await addBtn.click({ timeout: 10000 });

      // 4. 附件添加成功：节点附件区出现 README.md（CustomEvent 通知节点刷新）
      await expect(
        page.locator('.react-flow__node').getByText('README.md', { exact: false }).first(),
      ).toBeVisible({ timeout: 10000 });

      await page.screenshot({ path: 'e2e/artifacts/attach-file.png' }).catch(() => {});
    } finally {
      await restoreRoots(request, originalRoots);
    }
  });
});
