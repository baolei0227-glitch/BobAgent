import { test, expect } from '@playwright/test';

/**
 * e2e 用例 5：节点连线 — 2026-09 宿主重构后连线管理迁入 NodeMap，
 * 由卡片圆点两侧的拖拽把手（data-nodemap-connect）拖到目标卡片创建边。
 *
 * 覆盖：NodeMap 把手拖拽 → edge-create-request → /api/edges 持久化。
 * 说明：连线是纯前端 + 边持久化，不依赖 AI 服务；基于活跃边做落库断言。
 * 注意：清理用 hard_delete 不留残留。
 */
test.describe('节点连线', () => {
  test('NodeMap 把手拖拽在两个节点之间创建边', async ({ page, request }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 建边若触发“锁定上游成果块”等确认框，一律接受
    page.on('dialog', async (d) => d.accept());

    // 1. 打开左下角 NodeMap（折叠态按钮 title 以 "Node Map" 开头）
    const mapBtn = page.locator('button[title^="Node Map"]').first();
    await expect(mapBtn).toBeVisible({ timeout: 15000 });
    await mapBtn.click();

    // 2. 等待圆点卡片渲染（需要 ≥2 个研究节点）
    const dots = page.locator('[data-nodemap-dot]');
    await expect(dots.first()).toBeVisible({ timeout: 15000 });
    const dotCount = await dots.count();
    expect(dotCount).toBeGreaterThanOrEqual(2);

    const dotIds: string[] = [];
    for (let i = 0; i < dotCount; i++) {
      const id = await dots.nth(i).getAttribute('data-nodemap-dot');
      if (id) dotIds.push(id);
    }
    const [sourceId, targetId] = dotIds;

    try {
      // 3. hover 源圆点使拖拽把手出现，从 east 把手拖到目标圆点松手
      const srcBox = await dots.nth(0).boundingBox();
      if (!srcBox) throw new Error('source dot 不可见');
      await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
      await page.waitForTimeout(300);

      const handle = page.locator(`[data-nodemap-connect="${sourceId}"][data-side="east"]`);
      await expect(handle).toBeVisible({ timeout: 10000 });
      const hBox = await handle.boundingBox();
      const tgtBox = await dots.nth(1).boundingBox();
      if (!hBox || !tgtBox) throw new Error('handle / target dot 不可见');

      await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(tgtBox.x + tgtBox.width / 2, tgtBox.y + tgtBox.height / 2, { steps: 20 });
      await page.mouse.up();

      // 4. 落库断言：轮询 /api/edges 出现活跃边 sourceId → targetId
      await expect
        .poll(async () => {
          const resp = await request.get('/api/edges');
          const data = await resp.json();
          if (!data.success) return false;
          return data.edges.some(
            (e: { from: string; to: string; disconnected?: boolean }) =>
              !e.disconnected && e.from === sourceId && e.to === targetId,
          );
        }, { timeout: 10000 })
        .toBe(true);

      await page.screenshot({ path: 'e2e/artifacts/create-edge.png' }).catch(() => {});
    } finally {
      // 5. 清理：匹配该连线的 edge_id 硬删除
      const edgesResp = await request.get('/api/edges');
      const edgesData = await edgesResp.json();
      if (edgesData.success) {
        const target = edgesData.edges.find(
          (e: { from: string; to: string; edge_id: string }) =>
            e.from === sourceId && e.to === targetId,
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
