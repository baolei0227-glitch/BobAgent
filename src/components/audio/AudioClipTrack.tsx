'use client';

/**
 * AudioClipTrack —— 双轨编辑器下方的**片段轨**：把已导出的片段，按它们"相对源音频的区间"
 * 摆在**与上轨同一条时间轴**上（同一时间窗、同一播放头）。
 *
 * 为什么是"块"而不是"第二条波形"：片段的内容本来**就是源音频的一个子区间**
 * （`AudioClipRef` 只有 `start/end`，没有独立内容）⇒ 它在源时间轴上天然就是一段区间，
 * 不需要第二份波形/峰值/解码。再摆一条真波形既要多解一份 PCM，也难与上轨的同一个时间轴对齐。
 *
 * 与上轨的分工（2026-10-17 视觉双轨；2026-10-17 晚改为"区间标注"）：
 *   - 上轨（`AudioMarkTrack`）承载打点 / 选区 / 创建片段，是"从源里圈一段"的那只手；
 *   - 本轨负责**把片段作为主音频上的区间摆出来 + 调区间两端** —— 它是标注带，不是第二条音轨。
 *     区间是片段的唯一真源：拖两端只改 `start/end`（父级只写清单），**不在这里重切/覆写文件**；
 *     文件是导出时才现渲染的产物（见 `AudioViewer.exportClip`）。
 *
 * 交互（第二步，2026-10-17）：
 *   - 点块 = 选中（父级据此高亮 + 给出该片段的改名/下载/删除），点空白 = 跳到那一刻 **并退出选中**；
 *   - **选中的块两端各出一个手柄**：拖左手柄改 `start`、拖右手柄改 `end` —— 在**源时间轴**上
 *     把这段区间拉长/收紧。松手提交（`onRangeChange`），父级据此**只更新清单里的区间**
 *     （`update_clip_range`：不跑 ffmpeg、不覆写文件，片段身份/名字不变）。
 *   - 拖拽期间用**本地草稿区间**绘制（不回调、不落盘）：手感跟手，且只在松手时才花一次 ffmpeg。
 *
 * 分层（lane，2026-10-17）：
 *   片段在源时间轴上**本来就可以互相重叠**（把 A 的右端拉过 B 的起点就是这样），而块原先全铺在
 *   同一条 40px 轨道上 ⇒ 后渲染的（起点更靠后的那个）会**盖住**先切的那块：被压住的一段既看不见、
 *   也点不到，连它那一端的手柄都够不着。改成**分层错位**后，重叠的片段各自占一层、互不遮挡。
 *   注意：分层只是为了**看得见/点得到**重叠区间，不表示它们是并行的音频层。
 *   **拖拽期间不换层**：层是按 `clips`（已提交的区间）算的，拖中的块因此停在原来那层，不会因为
 *   越过邻居而突然跳层；松手重切完、`clips` 更新后才重排（这也是"不实时重算"的落点）。
 *
 * 时间窗来自父级（`view`，与上轨同源：`null` = 整段），播放头来自父级的 `playhead`；
 * 两者都是**绝对秒** ⇒ 两轨天然对齐。本组件不持有任何时间状态（拖拽草稿是唯一的例外，
 * 且只活在一次手势内），也不认识 API —— 与 `AudioMarkTrack` 同一分工：父级给什么就画什么。
 */
import { Fragment, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AudioClipRef } from '@/lib/audio/marks';
import { mmss } from '@/lib/audio/timeline';

/** 拖两端时的最短跨度（秒）：与服务端 `MIN_CLIP_SPAN_SEC`(0.1) 同向，留一点手感余量 */
const MIN_SPAN_SEC = 0.2;

/** 每层高度（块 32 + 上下各 4 留白）⇒ **1 层时轨道正好 40px**，与分层之前逐像素一致 */
const LANE_H = 40;
/** 块高（拖两端时也是手柄的高度，让手柄与块同高） */
const BLOCK_H = 32;
/** 层与层之间的间隙 */
const LANE_GAP = 4;

/** 第 `lane` 层的块上沿（px） */
const laneTop = (lane: number) => lane * (LANE_H + LANE_GAP) + (LANE_H - BLOCK_H) / 2;

/** 轨道总高（px）：`laneCount` 层 + 层间间隙。空轨按 1 层算，高度与原来一致 */
const laneTrackHeight = (laneCount: number) => {
  const n = Math.max(1, laneCount);
  return n * LANE_H + (n - 1) * LANE_GAP;
};

/**
 * 贪心分层：把每个片段塞进**第一条还容得下它的层**（该层上一个片段的 `end ≤ 本片段 start`），
 * 都容不下才新开一层。输入按 `start` 升序时，这就是区间图的最少层数解。
 * `end === start`（紧邻而不重叠）算"容得下" —— 边界上白开一层没有好处。
 */
function assignLanes(clips: AudioClipRef[]): { laneOf: Map<string, number>; laneCount: number } {
  const laneOf = new Map<string, number>();
  /** 每层最后一个片段的 `end`（该层的"占位到哪"） */
  const laneEnds: number[] = [];
  // 父级已按 start 升序，这里再排一次：分层正确性依赖这个顺序，不靠调用方口径
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  for (const c of ordered) {
    let lane = laneEnds.findIndex((end) => end <= c.start + 1e-6);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(c.end);
    } else {
      laneEnds[lane] = c.end;
    }
    laneOf.set(c.path, lane);
  }
  return { laneOf, laneCount: Math.max(1, laneEnds.length) };
}

/**
 * 拖拽草稿：只活在一次手势内（哪个块、拖的哪端、当前草稿区间）。
 * 也是往上/往下两处共用的口径：**下轨按它画块**、**父级按它画竖虚线与主音轨的聚光区间**。
 */
export interface ClipDragReport {
  path: string;
  edge: 'start' | 'end';
  start: number;
  end: number;
}

type DragState = ClipDragReport;

interface AudioClipTrackProps {
  /** 片段清单（父级已按 start 升序；相对源音频的秒） */
  clips: AudioClipRef[];
  /** 源音频总时长（秒）；用于 `view` 为 null 时的整段兜底，同时是拖拽的上界 */
  durationSec: number;
  /** 与上轨共享的时间窗；`null` = 整段 */
  view: { start: number; sec: number } | null;
  /** 当前播放时刻（绝对秒），画播放头 */
  playhead: number;
  /** 当前选中的片段路径（null = 没有选中）；只有选中的块才出两端手柄 */
  activePath: string | null;
  /** 点中某个块 */
  onSelect: (clip: AudioClipRef) => void;
  /**
   * 点中**空白**（块与手柄之外）：与 `onSeek` 同时触发 —— 既是"跳到那一刻"，也是**退出片段选中**。
   *
   * 为什么空白点击必须兼管"取消选中"：选中入口只有"点块 / 点清单行"两处，若空白点击只做跳转，
   * `activeClipPath` 在本轨就**没有任何出口** —— 块的高亮与主音轨的聚光会一直亮着，
   * 用户点了别处却看不到任何变化（这就是"点了非选中区域，截取区域还高亮"的来源）。
   * 上轨"点波形空白退出选区"是同一口径：两轨空白点击都该"离开当前选择"。
   */
  onClearSelect?: () => void;
  /** 点中空白 = 跳到那一刻（绝对秒） */
  onSeek: (t: number) => void;
  /** 拖完两端提交新区间（父级据此**只改清单里的 start/end**，不重切文件） */
  onRangeChange: (clip: AudioClipRef, start: number, end: number) => void;
  /**
   * 拖拽期间上报**整个草稿**（没在拖 = null）。
   * 父级拿它做两件事：① 按 `edge` 取那一端画**贯穿两轨的竖虚线**；
   * ② 按 `[start,end]` 让**主音轨的聚光区间**跟着一起长大/收窄。
   * 只画自己那一半的说法见父级：上轨那半由它来画（轨共线靠的是同一套窗口映射）。
   */
  onDragGuide?: (d: ClipDragReport | null) => void;
  /** 正在导出/批量创建（置灰并禁用拖拽；区间编辑本身是瞬时的，不会置忙） */
  busy?: boolean;
}

export function AudioClipTrack({
  clips,
  durationSec,
  view,
  playhead,
  activePath,
  onSelect,
  onClearSelect,
  onSeek,
  onRangeChange,
  onDragGuide,
  busy,
}: AudioClipTrackProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // 分层：按**已提交**区间（`clips`）算 —— 拖拽中的草稿不参与，所以被拖的块不会中途跳层
  const { laneOf, laneCount } = useMemo(() => assignLanes(clips), [clips]);

  /** 时间窗：窗口模式下用它，整段视图用总时长兜底 */
  const winStart = view ? view.start : 0;
  const winSec = view ? view.sec : durationSec;
  const usable = winSec > 0;
  /** 绝对秒 → 轨道内的百分比（未夹取） */
  const xOf = (t: number) => ((t - winStart) / winSec) * 100;

  const seekFromPointer = (clientX: number, el: HTMLElement) => {
    if (!usable) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSeek(winStart + ratio * winSec);
  };

  /** 指针位置 → 绝对秒（夹到轨道内） */
  const timeAtClientX = (clientX: number): number | null => {
    const el = trackRef.current;
    if (!el || !usable) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return winStart + ratio * winSec;
  };

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>, c: AudioClipRef, edge: 'start' | 'end') => {
    if (busy || !usable) return;
    // 阻止冒泡到轨道容器（否则会被当成"点空白 = 跳转"），并接管指针直到松手
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const next = { path: c.path, edge, start: c.start, end: c.end };
    setDrag(next);
    // 按下即出线：父级立刻在两轨间画共线虚线，并把主音轨的聚光切到这一段
    onDragGuide?.(next);
  };

  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const t = timeAtClientX(e.clientX);
    if (t == null) return;
    const upper = durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
    const tt = Math.min(upper, Math.max(0, t));
    // 先算出新区间（夹取规则与绘制同源），再落状态、再上报 —— 上报的值就是**画出来的那一端**
    const next =
      drag.edge === 'start'
        ? { start: Math.max(0, Math.min(tt, drag.end - MIN_SPAN_SEC)), end: drag.end } // 左手柄：夹在 [0, end − 最短跨度]
        : { start: drag.start, end: Math.min(upper, Math.max(tt, drag.start + MIN_SPAN_SEC)) }; // 右手柄：夹在 [start + 最短跨度, 源总时长]
    const draft = { ...drag, ...next };
    setDrag(draft);
    onDragGuide?.(draft);
  };

  /** 松手 / 取消：收起虚线；松手且真动过才提交重切 */
  const endDrag = (commit: boolean) => {
    const cur = drag;
    if (!cur) return;
    setDrag(null);
    onDragGuide?.(null);
    const clip = clips.find((c) => c.path === cur.path);
    // 没真的动过就不提交（避免"点一下手柄"也白写一次清单）
    if (commit && clip && (Math.abs(cur.start - clip.start) > 0.01 || Math.abs(cur.end - clip.end) > 0.01)) {
      onRangeChange(clip, cur.start, cur.end);
    }
  };

  return (
    <div
      ref={trackRef}
      data-role="clip-track"
      data-clip-count={clips.length}
      data-view={view ? `${view.start.toFixed(3)}:${view.sec.toFixed(3)}` : 'all'}
      data-drag={drag ? `${drag.edge}:${drag.path}` : 'none'}
      data-lanes={laneCount}
      // 与上轨同宽同轴：块的位置/宽度直接用百分比算，所以两轨的横向几何天然一致。
      // 高度**随层数**（1 层 = 40px，与分层前一致；每多一层 +44px）——父级是 flex 列，自然往下推内容。
      className="relative w-full select-none overflow-hidden rounded-md"
      style={{
        height: laneTrackHeight(laneCount),
        backgroundColor: 'var(--surface-muted)',
        border: '1px solid var(--line-soft)',
        opacity: busy ? 0.6 : 1,
      }}
      onPointerDown={(e) => {
        // 点在块/手柄上时由它们自己处理，空白才当"跳转"
        const el = e.target as HTMLElement;
        if (el.closest('[data-clip-block]') || el.closest('[data-clip-handle]')) return;
        // 空白 = 跳转 **+ 退出选中**：后者是本轨唯一的取消出口（见 `onClearSelect` 的说明）
        onClearSelect?.();
        seekFromPointer(e.clientX, e.currentTarget);
      }}
    >
      {usable &&
        clips.map((c) => {
          // 拖拽中的块用**草稿区间**绘制 ⇒ 手感跟手（松手才提交）
          const range = drag && drag.path === c.path ? { start: drag.start, end: drag.end } : { start: c.start, end: c.end };
          const left = Math.max(0, Math.min(100, xOf(range.start)));
          const right = Math.max(0, Math.min(100, xOf(range.end)));
          // 整段落在窗口之外 ⇒ 不画（窗口内只露一部分时，仍按夹取后的宽度画）
          if (right <= 0 || left >= 100 || right - left <= 0) return null;
          const active = c.path === activePath;
          /** 这一块落在哪一层（分层按已提交区间算 ⇒ 拖拽中它停在原来那层） */
          const lane = laneOf.get(c.path) ?? 0;
          return (
            <Fragment key={c.path}>
              <button
                type="button"
                data-clip-block={c.path}
                data-clip-lane={lane}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(c);
                }}
                aria-pressed={active}
                title={`${c.name}\n${mmss(range.start)} – ${mmss(range.end)}\nClick to select · drag the ends to adjust the range`}
                className="absolute flex items-center overflow-hidden rounded px-1.5 text-left text-10 leading-none transition-colors"
                style={{
                  left: `${left}%`,
                  width: `${right - left}%`,
                  top: laneTop(lane),
                  height: BLOCK_H,
                  // 区间标注，不是第二条音轨：只给一条顶边 + 极淡底色；
                  // 两端各一根小竖线，把"块"读成"从 A 到 B 的一段"。
                  backgroundColor: active
                    ? 'color-mix(in oklab, var(--primary-strong) 13%, transparent)'
                    : 'color-mix(in oklab, var(--ink-muted) 7%, transparent)',
                  borderTop: `2px solid ${active ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--ink-muted) 55%, transparent)'}`,
                  borderRadius: 3,
                  color: active ? 'var(--ink-strong)' : 'var(--ink-muted)',
                }}
              >
                <span
                  className="pointer-events-none absolute left-0 top-0 h-1.5 w-0.5"
                  style={{ backgroundColor: active ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}
                />
                <span
                  className="pointer-events-none absolute right-0 top-0 h-1.5 w-0.5"
                  style={{ backgroundColor: active ? 'var(--primary-strong)' : 'color-mix(in oklab, var(--ink-muted) 55%, transparent)' }}
                />
                <span className="block min-w-0 truncate">{c.name}</span>
              </button>

              {/* 两端手柄：只给**选中的块**，且重切期间不出（避免并发覆写）。
                  做成块**的兄弟节点**（不是块内部）：既避开 button 里嵌交互元素的非法结构，
                  也让"拖手柄"与"点块选中"两件事互不串味。
                  高度/位置**跟着块所在的那一层**（不是整轨）：否则分层后手柄会横跨别的层。 */}
              {active && !busy && (
                <>
                  <div
                    data-clip-handle="start"
                    data-clip-path={c.path}
                    onPointerDown={(e) => beginDrag(e, c, 'start')}
                    onPointerMove={moveDrag}
                    onPointerUp={() => endDrag(true)}
                    onPointerCancel={() => endDrag(false)}
                    title="Drag to change where this excerpt starts"
                    className="absolute z-10 flex w-3 cursor-col-resize items-center justify-center"
                    style={{ left: `${left}%`, top: laneTop(lane), height: BLOCK_H, transform: 'translateX(-50%)' }}
                  >
                    <span className="h-full w-0.5 rounded" style={{ backgroundColor: 'var(--primary-strong)' }} />
                  </div>
                  <div
                    data-clip-handle="end"
                    data-clip-path={c.path}
                    onPointerDown={(e) => beginDrag(e, c, 'end')}
                    onPointerMove={moveDrag}
                    onPointerUp={() => endDrag(true)}
                    onPointerCancel={() => endDrag(false)}
                    title="Drag to change where this excerpt ends"
                    className="absolute z-10 flex w-3 cursor-col-resize items-center justify-center"
                    style={{ left: `${right}%`, top: laneTop(lane), height: BLOCK_H, transform: 'translateX(-50%)' }}
                  >
                    <span className="h-full w-0.5 rounded" style={{ backgroundColor: 'var(--primary-strong)' }} />
                  </div>
                </>
              )}
            </Fragment>
          );
        })}

      {/* 播放头：与上轨同一条绝对时间的读数（父级 `playTime`），落在窗口内才画 */}
      {usable && playhead >= winStart && playhead <= winStart + winSec && (
        <div
          data-role="clip-playhead"
          className="pointer-events-none absolute top-0 bottom-0 w-px"
          style={{ left: `${xOf(playhead)}%`, backgroundColor: 'var(--primary-strong)' }}
        />
      )}

      {clips.length === 0 && (
        <span
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-10"
          style={{ color: 'var(--ink-faint)' }}
        >
          No excerpts yet — select a range, then Save excerpt
        </span>
      )}
    </div>
  );
}
