import { describe, it, expect } from 'vitest';
import {
  ORB_SIZE,
  ORB_EDGE_GAP,
  ORB_MIN_MARGIN,
  ORB_WINDOW_PAD,
  ORB_WINDOW_SIZE,
  PANEL_DEFAULT_SIZE,
  PANEL_MIN_SIZE,
  clamp,
  clampOrbPoint,
  clampOrbPointInRect,
  orbPointFromOffset,
  orbOffsetFromPoint,
  orbPointAtRectBottomLeft,
  orbWindowBounds,
  canHostOrb,
  panelBoundsForOrb,
  orbPointFromPanel,
} from './orb-geometry';

describe('clamp', () => {
  it('夹在区间内并处理上界小于下界的情形', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    // 视口比球还窄时 min > max：取 min（贴住左上角而不是产生 NaN / 负坐标）
    expect(clamp(3, 8, -20)).toBe(8);
  });

  it('NaN 视为下界，避免一次坏测量把球钉死在 NaN', () => {
    expect(clamp(Number.NaN, 8, 100)).toBe(8);
    expect(clamp(Number.POSITIVE_INFINITY, 8, 100)).toBe(100);
  });
});

describe('中栏锚点：偏移 ↔ 落点', () => {
  const anchor = { left: 260, bottom: 900 };

  it('偏移 (0,0) 落在锚点左下角，内缩 ORB_EDGE_GAP', () => {
    expect(orbPointFromOffset(anchor, { x: 0, y: 0 })).toEqual({
      x: 260 + ORB_EDGE_GAP,
      y: 900 - ORB_SIZE - ORB_EDGE_GAP,
    });
  });

  it('偏移与落点可互相还原（拖拽落盘后再读回不漂移）', () => {
    for (const offset of [{ x: 0, y: 0 }, { x: 137, y: -220 }, { x: -260 + ORB_MIN_MARGIN, y: 40 }]) {
      const point = orbPointFromOffset(anchor, offset);
      expect(orbOffsetFromPoint(point, anchor)).toEqual(offset);
    }
  });

  it('中栏左边缘变化（侧栏折叠）时，同一个偏移跟着锚点平移', () => {
    const offset = { x: 0, y: 0 };
    const expanded = orbPointFromOffset({ left: 260, bottom: 900 }, offset);
    const collapsed = orbPointFromOffset({ left: 56, bottom: 900 }, offset);
    expect(collapsed.x).toBe(expanded.x - 204);
    expect(collapsed.y).toBe(expanded.y);
  });
});

describe('clampOrbPoint：视口内不丢球', () => {
  const viewport = { width: 1440, height: 900 };

  it('拖出右/下边界时贴边保留 ORB_MIN_MARGIN', () => {
    expect(clampOrbPoint({ x: 9999, y: 9999 }, viewport)).toEqual({
      x: 1440 - ORB_SIZE - ORB_MIN_MARGIN,
      y: 900 - ORB_SIZE - ORB_MIN_MARGIN,
    });
    expect(clampOrbPoint({ x: -50, y: -50 }, viewport)).toEqual({ x: ORB_MIN_MARGIN, y: ORB_MIN_MARGIN });
  });
});

describe('主进程锚点：主窗内容区 / 屏幕 workArea', () => {
  it('主窗内容区（含标题栏偏移）左下角', () => {
    // titleBarStyle: hiddenInset → 内容区从 y=0 起，高度即窗口高度
    expect(orbPointAtRectBottomLeft({ x: 120, y: 40, width: 1000, height: 800 })).toEqual({
      x: 120 + ORB_EDGE_GAP,
      y: 40 + 800 - ORB_SIZE - ORB_EDGE_GAP,
    });
  });

  it('屏幕 workArea：Dock 在底部时贴 Dock 上沿（workArea 已排除 Dock）', () => {
    // 主屏 1512x982、菜单栏 33、Dock 约 76 → workArea { y: 33, height: 982-33-76 }
    const workArea = { x: 0, y: 33, width: 1512, height: 873 };
    expect(orbPointAtRectBottomLeft(workArea)).toEqual({
      x: ORB_EDGE_GAP,
      y: 33 + 873 - ORB_SIZE - ORB_EDGE_GAP,
    });
  });

  it('多屏：副屏 workArea 带正偏移时，球落在副屏自己的左下角', () => {
    const secondary = { x: 1512, y: 0, width: 1280, height: 800 };
    const point = orbPointAtRectBottomLeft(secondary);
    expect(point.x).toBe(1512 + ORB_EDGE_GAP);
    expect(point.y).toBe(800 - ORB_SIZE - ORB_EDGE_GAP);
  });

  it('独立态拖动后在 workArea 内钳制，不会拖到屏幕外找不回来', () => {
    const workArea = { x: 0, y: 33, width: 1512, height: 873 };
    expect(clampOrbPointInRect({ x: 9999, y: 9999 }, workArea)).toEqual({
      x: 1512 - ORB_SIZE - ORB_MIN_MARGIN,
      y: 33 + 873 - ORB_SIZE - ORB_MIN_MARGIN,
    });
  });
});

describe('orbWindowBounds', () => {
  it('把球点换算成带内边距的窗口矩形（取整，避免 1px 抖动）', () => {
    expect(orbWindowBounds({ x: 100.4, y: 200.6 })).toEqual({
      x: Math.round(100.4 - ORB_WINDOW_PAD),
      y: Math.round(200.6 - ORB_WINDOW_PAD),
      width: ORB_WINDOW_SIZE,
      height: ORB_WINDOW_SIZE,
    });
  });

  it('内边距容得下未读角标与独立态投影（不允许投影被窗口边缘切出直边）', () => {
    expect(ORB_WINDOW_PAD).toBeGreaterThanOrEqual(6);
    expect(ORB_WINDOW_SIZE).toBe(ORB_SIZE + ORB_WINDOW_PAD * 2);
  });
});

describe('canHostOrb', () => {
  it('中栏还没铺开（0×0 / 骨架）时不算可用锚点', () => {
    expect(canHostOrb({ x: 0, y: 0, width: 0, height: 0 })).toBe(false);
    expect(canHostOrb({ x: 0, y: 0, width: 40, height: 800 })).toBe(false);
    expect(canHostOrb({ x: 0, y: 0, width: 600, height: 500 })).toBe(true);
  });
});

describe('独立 Butler 面板：展开 / 缩小的往返', () => {
  /** 主屏 1512×982、菜单栏 33、Dock 约 76 */
  const workArea = { x: 0, y: 33, width: 1512, height: 873 };
  /** 高屏（或 Dock 停侧面）：面板首尺寸 1020×880 能完整放下，用于验证「未钳制」这一档 */
  const tallWorkArea = { x: 0, y: 33, width: 1512, height: 982 };

  it('面板底边贴球的底边、左缘对齐（看起来是从球里长出来的）', () => {
    const ball = { x: 300, y: 940 };
    const panel = panelBoundsForOrb(ball, PANEL_DEFAULT_SIZE, tallWorkArea);
    expect(panel.width).toBe(PANEL_DEFAULT_SIZE.width);
    expect(panel.height).toBe(PANEL_DEFAULT_SIZE.height);
    expect(panel.x).toBe(ball.x);
    expect(panel.y + panel.height).toBe(ball.y + ORB_SIZE);
  });

  it('「缩小」把球放回展开前的位置（面板未被钳制时往返严格相等，不会越缩越偏）', () => {
    // 面板高 880、可用区上沿 33+8：球底边 ≥ 921（即 y ≥ 887）才不会被下压；x 上限 1512-1020-8 = 484
    for (const ball of [{ x: 16, y: 965 }, { x: 300, y: 920 }, { x: 484, y: 887 }]) {
      const panel = panelBoundsForOrb(ball, PANEL_DEFAULT_SIZE, tallWorkArea);
      expect(orbPointFromPanel(panel)).toEqual(ball);
    }
  });

  it('面板被可用区钳制时（本机 873 高），球跟着面板落到面板左下角——偏移量在个位数像素', () => {
    // 873 高的可用区放不下 880 的首尺寸 → 面板压到 857 并贴住上沿，其底边与球底边不再重合。
    // 此时「缩小」把球放在面板左下角（用户看到的就是面板那一块），而不是把球弹回原位——
    // 否则用户拖动过面板之后，球会跳回一个面板已不在的地方。
    const home = orbPointAtRectBottomLeft(workArea);
    const panel = panelBoundsForOrb(home, PANEL_DEFAULT_SIZE, workArea);
    expect(panel.height).toBe(workArea.height - ORB_MIN_MARGIN * 2);
    const back = orbPointFromPanel(panel);
    expect(back).toEqual({ x: panel.x, y: panel.y + panel.height - ORB_SIZE });
    expect(Math.abs(back.y - home.y)).toBeLessThanOrEqual(ORB_MIN_MARGIN * 2);
    // 仍然是一颗完整可见的球（不会被算出屏幕外）
    expect(back.y + ORB_SIZE).toBeLessThanOrEqual(workArea.y + workArea.height);
  });

  it('球在桌面左下角（默认落点）时，面板完整落在可用区内', () => {
    const home = orbPointAtRectBottomLeft(workArea);
    const panel = panelBoundsForOrb(home, PANEL_DEFAULT_SIZE, workArea);
    expect(panel.x).toBeGreaterThanOrEqual(workArea.x + ORB_MIN_MARGIN);
    expect(panel.y).toBeGreaterThanOrEqual(workArea.y + ORB_MIN_MARGIN);
    expect(panel.x + panel.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(panel.y + panel.height).toBeLessThanOrEqual(workArea.y + workArea.height);
  });

  it('球贴右边缘时面板向左回收，不会被推出屏幕', () => {
    const ball = { x: workArea.width - ORB_SIZE, y: 500 };
    const panel = panelBoundsForOrb(ball, PANEL_DEFAULT_SIZE, workArea);
    expect(panel.x + panel.width).toBeLessThanOrEqual(workArea.x + workArea.width - ORB_MIN_MARGIN);
  });

  it('可用区装不下首选尺寸：先压到最小尺寸', () => {
    const small = { x: 0, y: 0, width: 700, height: 520 };
    const panel = panelBoundsForOrb({ x: 100, y: 400 }, PANEL_DEFAULT_SIZE, small);
    expect(panel.width).toBe(Math.min(PANEL_DEFAULT_SIZE.width, small.width - ORB_MIN_MARGIN * 2));
    expect(panel.height).toBe(Math.max(PANEL_MIN_SIZE.height, small.height - ORB_MIN_MARGIN * 2));
  });

  it('连最小尺寸都装不下：退化为贴左上，不产生负坐标', () => {
    const tiny = { x: 0, y: 0, width: 300, height: 300 };
    const panel = panelBoundsForOrb({ x: 10, y: 250 }, PANEL_DEFAULT_SIZE, tiny);
    expect(panel.width).toBe(PANEL_MIN_SIZE.width);
    expect(panel.height).toBe(PANEL_MIN_SIZE.height);
    expect(panel.x).toBe(ORB_MIN_MARGIN);
    expect(panel.y).toBe(ORB_MIN_MARGIN);
  });

  it('副屏（workArea 带正偏移）时面板落在副屏内', () => {
    const secondary = { x: 1512, y: 0, width: 1280, height: 800 };
    const ball = orbPointAtRectBottomLeft(secondary);
    const panel = panelBoundsForOrb(ball, PANEL_DEFAULT_SIZE, secondary);
    expect(panel.x).toBeGreaterThanOrEqual(secondary.x);
    expect(panel.x + panel.width).toBeLessThanOrEqual(secondary.x + secondary.width);
    expect(panel.y + panel.height).toBeLessThanOrEqual(secondary.y + secondary.height);
  });

  it('首尺寸按「桌面抽屉三栏」反推：宽 ≥ 1000（低于这个宽度抽屉会切成窄窗版），高接近抽屉上限 760', () => {
    expect(PANEL_DEFAULT_SIZE.width).toBeGreaterThanOrEqual(1000);
    // 抽屉高 = min(760, 86vh)，量的就是窗口高度：880 的窗 → 757，已贴近上限
    expect(PANEL_DEFAULT_SIZE.height * 0.86).toBeGreaterThanOrEqual(750);
    expect(PANEL_MIN_SIZE.width).toBeGreaterThanOrEqual(520);
    expect(PANEL_MIN_SIZE.height).toBeGreaterThan(360);
  });
});
