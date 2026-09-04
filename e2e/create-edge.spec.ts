import { test, expect } from '@playwright/test';

/**
 * e2e 用例 5：节点连线 — 从节点 A 的 source handle 拖到节点 B 的 target handle 创建边。
 *
 * 覆盖：React Flow onConnect 链路（拖拽 → /api/edges 持久化 → addEdge 渲染 FloatingEdge）。
 * 说明：连线是纯前端 + 边持久化，不依赖 AI 服务。
 * 注意：基于前端实际渲染的边数做前后对比，避免历史断线边干扰；清理用 hard_delete 不留残留。
 */
test.describe('节点连线', () => {
  test('拖拽 handle 在两个节点之间创建边', async ({ page, request }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 1. 等待节点渲染（应为基础画布的 2 个 AI Chat 节点）
    const nodes = page.locator('.react-flow__node');
    await expect(nodes).toHaveCount(2, { timeout: 15000 });

    const nodeIds: string[] = [];
    for (let i = 0; i < await nodes.count(); i++) {
      const id = await nodes.nth(i).getAttribute('data-id');
      if (id) nodeIds.push(id);
    }
    expect(nodeIds).toHaveLength(2);

    // 前端当前渲染的边数（含历史断线边）
    const edgeCountBefore = await page.locator('.react-flow__edge').count();

    try {
      // 2. 从 nodeA 底部 source handle 拖到 nodeB 顶部 target handle
      const srcHandle = nodes.nth(0).locator('.react-flow__handle[data-handleid="bottom"]');
      const tgtHandle = nodes.nth(1).locator('.react-flow__handle[data-handleid="top-target"]');
      await expect(srcHandle).toBeVisible({ timeout: 10000 });
      await expect(tgtHandle).toBeVisible({ timeout: 10000 });

      const srcBox = await srcHandle.boundingBox();
      const tgtBox = await tgtHandle.boundingBox();
      if (!srcBox || !tgtBox) throw new Error('handle 不可见');

      await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(tgtBox.x + tgtBox.width / 2, tgtBox.y + tgtBox.height / 2, { steps: 25 });
      await page.mouse.up();

      // 3. 前端边数 +1（比拖拽前多 1 条）
      await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCountBefore + 1, { timeout: 10000 });

      await page.screenshot({ path: 'e2e/artifacts/create-edge.png' }).catch(() => {});
    } finally {
      // 4. 清理：查活跃边中 from/to 匹配的 edge_id 并硬删除
      const edgesResp = await request.get('/api/edges');
      const edgesData = await edgesResp.json();
      if (edgesData.success) {
        const target = edgesData.edges.find(
          (e: { from: string; to: string; edge_id: string }) => e.from === nodeIds[0] && e.to === nodeIds[1],
        );
        if (target) {
          await request.post('/api/edges', {
            data: { action: 'hard_delete', edge_id: target.edge_id },
          }).catch(() => {});
        }
      }
    }
  });
});
