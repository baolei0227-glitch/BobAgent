import { describe, expect, it } from 'vitest';
import {
  hitTestMark,
  leaderAnchorOnRect,
  markTextPos,
  rectFromDrag,
  type Mark,
} from '@/components/screen-ocr/ScreenOcrEditor';

/**
 * 矩形框标注的几何口径（2026-10-17 新增「框选」工具）
 *
 * 为什么单独测这两点：
 *  1. `rectFromDrag` 是预览与落定的**唯一**口径。反向拖拽若没归一化，会出现
 *     「预览看着从右下往左上拉，落定后整个框消失/跳到别处」这类只在反向拖拽时复现的 bug。
 *  2. `hitTestMark` 对矩形框**只命中四条边、内部不命中**。这是刻意设计（空心框要能圈住
 *     文字/下划线而不抢它们的点击）；一旦有人图省事改成「包围盒命中」，框内的标注就再也点不到，
 *     而且不会报错 —— 这条断言就是为了钉住这个语义。
 */

/** 矩形框在图像像素坐标下的最小假 ctx（hitTestMark 只用到 canvas.width / font / textBaseline） */
const fakeCtx = {
  canvas: { width: 1000, height: 800 },
  font: '',
  textBaseline: 'top',
  // 批注气泡要量文字宽度：按 10px/字 桩掉（画布宽度 1000 ⇒ 字号 16、内边距 x=5 / y=3）
  measureText: (s: string) => ({ width: s.length * 10 }),
} as unknown as CanvasRenderingContext2D;

describe('rectFromDrag：拖拽几何归一化', () => {
  it('正向拖拽（左上 → 右下）', () => {
    expect(rectFromDrag(10, 20, 110, 80)).toEqual({ x: 10, y: 20, w: 100, h: 60 });
  });

  it('反向拖拽（右下 → 左上）归一化后与正向完全相同', () => {
    expect(rectFromDrag(110, 80, 10, 20)).toEqual({ x: 10, y: 20, w: 100, h: 60 });
  });

  it('反向拖拽（右上 → 左下 / 左下 → 右上）也不产生负宽高', () => {
    expect(rectFromDrag(110, 20, 10, 80)).toEqual({ x: 10, y: 20, w: 100, h: 60 });
    expect(rectFromDrag(10, 80, 110, 20)).toEqual({ x: 10, y: 20, w: 100, h: 60 });
  });

  it('起点越出画布左上边界 → 钳到 0，尺寸按可见部分收缩', () => {
    expect(rectFromDrag(-20, -10, 50, 40, 1000, 800)).toEqual({ x: 0, y: 0, w: 50, h: 40 });
  });

  it('终点越出画布右下边界 → 尺寸钳到画布内', () => {
    expect(rectFromDrag(90, 70, 200, 150, 100, 100)).toEqual({ x: 90, y: 70, w: 10, h: 30 });
  });

  it('整段落在画布外 → 宽高为 0（落定端会按 MIN_RECT 丢弃）', () => {
    const r = rectFromDrag(120, 120, 200, 200, 100, 100);
    expect(r).toEqual({ x: 100, y: 100, w: 0, h: 0 });
  });

  it('未拖开（起止点相同）→ 0×0', () => {
    expect(rectFromDrag(30, 30, 30, 30)).toEqual({ x: 30, y: 30, w: 0, h: 0 });
  });

  it('两端各自钳制：起点在图外时框仍对齐光标终点（不会多伸出一段）', () => {
    // 只钳左上角的写法会得到 w=15（-5 → 10 的原差值），框比用户拖出的范围更大
    expect(rectFromDrag(-5, -5, 10, 10)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('hitTestMark：矩形框只命中四条边', () => {
  const rect: Mark = { kind: 'rect', id: 1, x: 100, y: 100, w: 200, h: 100 };
  const marks: Mark[] = [rect];
  const hit = (x: number, y: number) => hitTestMark(fakeCtx, marks, x, y)?.id ?? null;

  it('四条边（含容差 8px）都命中', () => {
    expect(hit(200, 100)).toBe(1); // 上边中点
    expect(hit(300, 150)).toBe(1); // 右边中点
    expect(hit(200, 200)).toBe(1); // 下边中点
    expect(hit(100, 150)).toBe(1); // 左边中点
    expect(hit(200, 106)).toBe(1); // 上边外 6px（容差内）
  });

  it('内部不命中 —— 否则框内放文字/下划线会被判成「选中并拖动这个框」', () => {
    expect(hit(200, 150)).toBeNull();
    expect(hit(150, 120)).toBeNull();
  });

  it('外部（超出容差）不命中', () => {
    expect(hit(200, 91)).toBeNull(); // 上边外 9px
    expect(hit(309, 150)).toBeNull(); // 右边外 9px
    expect(hit(200, 209)).toBeNull(); // 下边外 9px
  });
});

describe('leaderAnchorOnRect：批注引线起点 = 框边界最近点', () => {
  // 框：左上 (100,100)，200×100 ⇒ 右边界 x=300、下边界 y=200
  const anchor = (bx: number, by: number, bw = 0, bh = 0) =>
    leaderAnchorOnRect(100, 100, 200, 100, { x: bx, y: by, w: bw, h: bh });

  it('气泡在框外正右 → 右边中点', () => {
    expect(anchor(500, 150)).toEqual({ x: 300, y: 150 });
  });

  it('气泡在框外正上 → 上边中点', () => {
    expect(anchor(200, 20)).toEqual({ x: 200, y: 100 });
  });

  it('气泡在框外对角 → 框角（矩形最近点就是角）', () => {
    expect(anchor(500, 500)).toEqual({ x: 300, y: 200 });
  });

  it('气泡中心在框内靠上 → 上边垂足（不能退化成「长度 0 的引线」）', () => {
    expect(anchor(200, 110)).toEqual({ x: 200, y: 100 });
  });

  it('气泡中心在框内靠右 → 右边垂足', () => {
    expect(anchor(280, 150)).toEqual({ x: 300, y: 150 });
  });

  it('气泡中心在框内靠下 → 下边垂足', () => {
    expect(anchor(200, 190)).toEqual({ x: 200, y: 200 });
  });

  it('气泡带尺寸时按中心判定（气泡压在框边上也算命中边界）', () => {
    // 气泡 40×20，中心 (320,150) 在框外 → 右边中点
    expect(anchor(300, 140, 40, 20)).toEqual({ x: 300, y: 150 });
  });
});

describe('批注气泡：可点中 + 可单独拖动', () => {
  // 画布 1000 宽 ⇒ 字号 16、内边距 (5,3)；框 100,100 200×100；批注「批注」= 2 字 = 20px 宽
  const rect: Mark = { kind: 'rect', id: 7, x: 100, y: 100, w: 200, h: 100, value: '批注' };

  it('缺省气泡在框下方外侧，左对齐框左边', () => {
    // below = 100+100+2+3 = 205；气泡 = { x:100-5=95, y:205-3=202, w:20+10=30, h:16+6=22 }
    expect(markTextPos(fakeCtx, rect)).toEqual({ x: 100, y: 205 });
  });

  it('点气泡本体命中该标注（离框下边 13px，已超出 8px 边容差 ⇒ 只能是气泡命中）', () => {
    expect(hitTestMark(fakeCtx, [rect], 110, 213)?.id).toBe(7);
  });

  it('气泡之外的空白不命中（框内空心区仍不拦截）', () => {
    expect(hitTestMark(fakeCtx, [rect], 110, 250)).toBeNull();
  });

  it('已设 textX/textY 时以它为锚点（拖过的位置不会被缺省值覆盖）', () => {
    expect(markTextPos(fakeCtx, { ...rect, textX: 400, textY: 600 })).toEqual({ x: 400, y: 600 });
  });

  it('无线 / 无批注的对象没有气泡（拖动退化为整体移动）', () => {
    expect(markTextPos(fakeCtx, { ...rect, value: undefined })).toBeNull();
  });
});
