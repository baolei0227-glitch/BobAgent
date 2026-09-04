/**
 * 子节点列布局纯函数模块（拉线创建 / 连线后统一排版规则）。
 *  - layoutChildrenColumn：1 子平行 / 2+ 子纵向对齐、父节点位于子列垂直中心水平线
 *  - avoidColumnCollisionY：子列与无关节点重叠时向下碰撞避让
 *  - rectsOverlap：AABB 相交检测
 *
 * 纯函数约束：不读 DOM、不读 gateway store、无副作用，所有输入都通过参数注入。
 */

/** 子节点列布局间距：父子水平间距 / 子节点垂直间距 */
export const CHILD_H_GAP = 120;
export const CHILD_V_GAP = 120;

/** 与 AiChatNode 一致的节点宽高 */
export const CHILD_NODE_W = 400;
export const CHILD_NODE_H = 400;

/**
 * 子节点列布局：
 *  - 1 个子节点 → 与父节点同一水平线（子节点垂直中心 = 父节点垂直中心，间距 CHILD_H_GAP）
 *  - 2+ 个子节点 → 纵向对齐（同一 x 列），父节点位于子列垂直中心水平线上（间距 CHILD_V_GAP）
 * @param parent 父节点（含 position 与 measured 尺寸）
 * @param childIds 父节点的全部直接子节点 id（含新建）
 * @param dir 子列方向：1 = 右侧列，-1 = 左侧列
 * @param childSizes 子节点实际渲染尺寸（key=id；未提供/未测量时回退 CHILD_NODE_W/H）
 * @returns nodeId → 新位置（左上角世界坐标）；空列表时返回空对象
 */
export function layoutChildrenColumn(
  parent: { position: { x: number; y: number }; measured?: { width?: number; height?: number } },
  childIds: string[],
  dir: 1 | -1,
  childSizes?: Record<string, { width?: number; height?: number }>,
  gaps?: { h?: number; v?: number },
): Record<string, { x: number; y: number }> {
  if (childIds.length === 0) return {};
  // 紧凑间距：Note 便签簇使用小间距；缺省走 AI Chat 的宽松间距，行为不变
  const H_GAP = gaps?.h ?? CHILD_H_GAP;
  const V_GAP = gaps?.v ?? CHILD_V_GAP;
  const parentW = parent.measured?.width ?? CHILD_NODE_W;
  const parentH = parent.measured?.height ?? CHILD_NODE_H;
  const childH = (id: string) => childSizes?.[id]?.height ?? CHILD_NODE_H;
  // 子列参考宽度：左侧排列时子节点右边缘应对齐「父左边缘 - gap」。
  // 不能用固定 CHILD_NODE_W 假设——节点展开态宽度可达 675px（3:4 竖屏），
  // 固定 400 会让展开子节点与父节点重叠/间距错误。取任一已测量子宽度；均无测量则回退默认。
  const childRefW = (() => {
    if (!childSizes) return CHILD_NODE_W;
    for (const id of childIds) {
      const w = childSizes[id]?.width;
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) return w;
    }
    return CHILD_NODE_W;
  })();
  const colX = dir === 1
    ? parent.position.x + parentW + H_GAP
    : parent.position.x - H_GAP - childRefW;
  // 子列垂直中心 = 父节点中心水平线（1 子也居中，2+ 子整列居中）
  const parentCy = parent.position.y + parentH / 2;

  const positions: Record<string, { x: number; y: number }> = {};
  // 全部取整：半像素坐标会让节点文字在子像素位置发虚
  if (childIds.length === 1) {
    // 平行排版：单个子节点垂直中心对齐父节点中心
    positions[childIds[0]] = { x: Math.round(colX), y: Math.round(parentCy - childH(childIds[0]) / 2) };
    return positions;
  }

  // 纵向对齐：子列总高 = Σ 各子节点实际高度 + 间距，列中心对齐父节点中心
  const totalH = childIds.reduce((s, id) => s + childH(id), 0)
    + (childIds.length - 1) * V_GAP;
  const startY = parentCy - totalH / 2;
  let cy = startY;
  for (const id of childIds) {
    positions[id] = { x: Math.round(colX), y: Math.round(cy) };
    cy += childH(id) + V_GAP;
  }
  return positions;
}

/** 简单矩形相交检测（世界坐标，含边界） */
export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * 子节点列碰撞避让：列整体与「无关节点」重叠时，整体向下平移让开。
 *  - 只向下避让：向上会越过父节点水平带/上方结构，破坏父子布局预期
 *  - 迭代直到无碰撞（每次推进到重叠障碍物底部 + gap），上限保护避免死循环
 * @param col 列整体矩形（含全部子节点，x 相同 → 可直接用整列区间）
 * @param others 无关节点矩形列表（排除父节点与子节点自身）
 * @param gap 避让后与障碍物的最小间距
 * @returns 需应用到列上的 y 偏移量（≥ 0）
 */
export function avoidColumnCollisionY(
  col: { x: number; y: number; w: number; h: number },
  others: Array<{ x: number; y: number; w: number; h: number }>,
  gap: number,
): number {
  const MAX_ITER = 30;
  let dy = 0;
  for (let i = 0; i < MAX_ITER; i++) {
    const moved = { x: col.x, y: col.y + dy, w: col.w, h: col.h };
    let needDown = 0;
    for (const o of others) {
      if (rectsOverlap(moved, o)) {
        needDown = Math.max(needDown, o.y + o.h + gap - moved.y);
      }
    }
    if (needDown <= 0) return dy;
    dy += needDown;
  }
  return dy;
}
