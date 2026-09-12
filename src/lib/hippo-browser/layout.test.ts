/**
 * Hippo Browser 布局纯逻辑单测（src/lib/hippo-browser/layout.ts）
 *
 * 覆盖浏览器嵌入到预览面板（方案 A）的布局契约，纯函数、不依赖 electron：
 *  1. isHippoAnchor：锚点合法性与边界；
 *  2. computeHippoBounds：嵌入模式占满锚点区 / 侧边栏模式（占窗口 65%，min 480 max 900、
 *     工具栏下方、隐藏滑出右侧）/ 嵌入优先级最高；
 *  3. computeHippoSlotWidth：槽宽档位。
 */
import { describe, expect, it } from 'vitest';
import {
  HIPPO_TOOLBAR_HEIGHT,
  computeHippoBounds,
  computeHippoSlotWidth,
  isHippoAnchor,
} from './layout';

describe('isHippoAnchor', () => {
  it('接受合法锚点矩形', () => {
    expect(isHippoAnchor({ x: 10, y: 20, width: 800, height: 600 })).toBe(true);
    expect(isHippoAnchor({ x: 0, y: 0, width: 480, height: 48 })).toBe(true);
    expect(isHippoAnchor({ x: 100.4, y: 50.6, width: 100.9, height: 99.1 })).toBe(true);
  });

  it('拒绝 null / 非对象 / 含非法字段', () => {
    expect(isHippoAnchor(null)).toBe(false);
    expect(isHippoAnchor(undefined)).toBe(false);
    expect(isHippoAnchor(42)).toBe(false);
    expect(isHippoAnchor('rect')).toBe(false);
    expect(isHippoAnchor({})).toBe(false);
  });

  it('拒绝非数字或非有限数字字段', () => {
    expect(isHippoAnchor({ x: '10', y: 20, width: 800, height: 600 })).toBe(false);
    expect(isHippoAnchor({ x: Number.NaN, y: 20, width: 800, height: 600 })).toBe(false);
    expect(isHippoAnchor({ x: Infinity, y: 20, width: 800, height: 600 })).toBe(false);
    expect(isHippoAnchor({ x: 10, y: 20, width: 800 })).toBe(false); // 缺 height
  });

  it('拒绝宽或高非正数', () => {
    expect(isHippoAnchor({ x: 10, y: 20, width: 0, height: 600 })).toBe(false);
    expect(isHippoAnchor({ x: 10, y: 20, width: 800, height: 0 })).toBe(false);
    expect(isHippoAnchor({ x: 10, y: 20, width: -5, height: 600 })).toBe(false);
  });
});

describe('computeHippoBounds — 嵌入模式（方案 A：浏览器占满预览面板）', () => {
  it('锚点非空时对齐锚点矩形，y 从面板内容区开始，且优先级高于侧边栏槽', () => {
    // 即使 visible 为 false，锚点仍强制嵌入（锚点存在即代表"浏览器 Tab 激活"）
    const b = computeHippoBounds(1440, 900, { x: 1100, y: 56, width: 340, height: 800 }, false);
    expect(b).toEqual({ x: 1100, y: 56, width: 340, height: 800 });
  });

  it('浮点锚点做四舍五入取整', () => {
    const b = computeHippoBounds(1440, 900, { x: 1100.4, y: 55.6, width: 339.6, height: 800.4 }, true);
    expect(b).toEqual({ x: 1100, y: 56, width: 340, height: 800 });
  });

  it('锚点宽/高异常（接近 0 或负数）时兜底为 1，避免 WebContentsView 报非法 bounds', () => {
    const b = computeHippoBounds(1440, 900, { x: 10, y: 20, width: 0.4, height: -3 }, true);
    expect(b.width).toBe(1);
    expect(b.height).toBe(1);
  });
});

describe('computeHippoBounds — 侧边栏模式（未嵌入）', () => {
  it('可见时：右侧覆盖槽，宽度为主窗口 65%，y=工具栏高度下方，高度扣除工具栏', () => {
    const b = computeHippoBounds(1000, 700, null, true);
    expect(b).toEqual({
      x: 1000 - Math.round(1000 * 0.65),
      y: HIPPO_TOOLBAR_HEIGHT,
      width: Math.round(1000 * 0.65),
      height: 700 - HIPPO_TOOLBAR_HEIGHT,
    });
    expect(b.x).toBeGreaterThanOrEqual(300);
    expect(b.y).toBe(HIPPO_TOOLBAR_HEIGHT);
  });

  it('隐藏时：x=窗口宽（滑出屏幕右侧），仍保留高度与宽度', () => {
    const b = computeHippoBounds(1000, 700, null, false);
    expect(b.x).toBe(1000); // 滑出
    expect(b.width).toBe(Math.round(1000 * 0.65));
    expect(b.height).toBe(700 - HIPPO_TOOLBAR_HEIGHT);
  });

  it('宽度档位：min 480，max 900', () => {
    // 窗口过窄（65%<480）→ 兜底 480
    expect(computeHippoBounds(700, 500, null, true).width).toBe(480);
    // 窗口超宽（65%>900）→ 封顶 900
    expect(computeHippoBounds(2000, 900, null, true).width).toBe(900);
    expect(computeHippoBounds(1440, 900, null, true).width).toBe(900); // 1440*0.65=936>900
    // 中间档位 = 窗口 65%（在区间内）
    expect(computeHippoBounds(800, 900, null, true).width).toBe(520);
  });

  it('窗口过矮时高度不为负（扣除工具栏后兜底 0）', () => {
    const b = computeHippoBounds(1000, HIPPO_TOOLBAR_HEIGHT - 10, null, true);
    expect(b.height).toBe(0);
  });
});

describe('computeHippoSlotWidth', () => {
  it('与 computeHippoBounds 的侧边栏槽宽一致（min 480 / max 900 / 窗口 65%）', () => {
    // 窗口过窄（65% < 480）→ 兜底 480
    expect(computeHippoSlotWidth(700)).toBe(480);
    // 窗口超宽（65% > 900）→ 封顶 900
    expect(computeHippoSlotWidth(2000)).toBe(900);
    expect(computeHippoSlotWidth(1440)).toBe(900); // 1440*0.65=936 > 900
    // 中间档位 = 窗口 65%（在区间内）
    expect(computeHippoSlotWidth(800)).toBe(520);
    expect(computeHippoSlotWidth(1000)).toBe(computeHippoBounds(1000, 700, null, true).width);
  });
});