import { test, expect } from '@playwright/test';

/**
 * e2e 用例 3：选中文字生成批注（DocEditor 内 AiEditBubble → mark.annotation 写回）。
 *
 * 覆盖：Tiptap 选区 → BubbleMenu → 批注模式 → 保存批注 → 编辑器内出现 <mark class="annotation">。
 * 说明：批注是纯前端 + 节点 API，不依赖 AI 服务。
 * 流程：API 创建带内容节点 → 打开节点文档 → 选中文字 → 添加批注 → 验证 → 删除节点。
 */
const TEST_TITLE = 'E2E批注测试';
const TEST_ANSWER = '这是一段用于批注测试的文本内容，包含足够多的中文文字，方便在编辑器里通过鼠标拖拽选中。';

test.describe('文字批注', () => {
  test('选中节点文档文字并添加批注', async ({ page, request }) => {
    // 0. 准备：创建带内容的节点
    const createResp = await request.post('/api/nodes', {
      data: { action: 'create', title: TEST_TITLE },
    });
    const createData = await createResp.json();
    expect(createData.success).toBeTruthy();
    const nodeId = createData.node_id as string;

    try {
      // 1. append 对话，让节点有可编辑的文档内容
      const appendResp = await request.post('/api/nodes', {
        data: {
          action: 'append',
          node_id: nodeId,
          question: '请写一段测试文本',
          answer: TEST_ANSWER,
        },
      });
      const appendData = await appendResp.json();
      expect(appendData.success).toBeTruthy();

      // 2. 打开页面，找到新节点并打开文档
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // 节点标题按钮形如 "E2E批注测试.md"（仅在节点有内容时渲染）
      const docButton = page.getByText(`${TEST_TITLE}.md`, { exact: false }).first();
      await expect(docButton).toBeVisible({ timeout: 15000 });
      await docButton.click();
      await page.waitForTimeout(1200);

      // 3. reader 打开 → 可编辑编辑器出现
      const prose = page.locator('[data-reader-content] [contenteditable="true"]').first();
      await expect(prose).toBeVisible({ timeout: 10000 });

      // 4. 聚焦编辑器并选中文字（点击定位光标 → Shift+End 选中至行尾）
      const textEl = prose.getByText('批注测试', { exact: false }).first();
      await textEl.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await textEl.click({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(300);
      await page.keyboard.press('Shift+End');
      await page.waitForTimeout(800);

      // 5. BubbleMenu 出现 → 点击"批注"（BubbleMenu 被正文遮挡，用 DOM click 绕过）
      const bubble = page.locator('.ai-edit-bubble').first();
      await expect(bubble).toBeVisible({ timeout: 10000 });
      await bubble.getByTitle('批注').evaluate((el) => (el as HTMLElement).click());
      await page.waitForTimeout(500);

      // 6. 输入批注内容并保存
      const noteInput = page.locator('.ai-edit-bubble textarea').first();
      await expect(noteInput).toBeVisible({ timeout: 10000 });
      await noteInput.fill('E2E 自动化批注');
      await page.getByText('保存批注', { exact: true }).evaluate((el) => (el as HTMLElement).click());
      await page.waitForTimeout(1500);

      // 7. 验证编辑器内出现 annotation mark（选区含多段文字，可能生成多个，断言 ≥1）
      await expect(prose.locator('mark.annotation').first()).toBeVisible({ timeout: 10000 });

      await page.screenshot({ path: 'e2e/artifacts/add-annotation.png' }).catch(() => {});
    } finally {
      // 8. 清理：删除测试节点
      await request.post('/api/nodes', {
        data: { action: 'delete', node_id: nodeId },
      }).catch(() => {});
    }
  });
});
