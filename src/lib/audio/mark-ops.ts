/**
 * 打点的**纯操作**（只吃纯数据、只吐纯数据；无 `node:fs` ⇒ 客户端组件可值引入）。
 *
 * 与 `marks.ts` 的分工（照 `naming.ts` 头注释那套取舍）：
 *   - `marks.ts`  = `AudioMark` 类型 + **持久化**（含 `node:fs` 动态导入，服务端专属）；
 *   - 本文件      = 打点的**运算**：从建议区间落点 / 吸附 / 清除自动点 / 按打点切区间。
 *
 * 这里全部是纯函数，唯一的消费者是客户端组件（`AudioMarkTrack` / `AudioViewer`），
 * 但放在 lib 层是为了能**单测**（仓库无 jsdom，组件测不了）。
 */
import type { AudioMark } from './marks';
import type { HighlightSuggestion, TranscriptSegment } from './transcript';

/**
 * 自动生成点与已有点的**去重阈值**（秒）：距离小于它即视为"同一个点"，跳过。
 *
 * 为什么不是 0：转写段起点与用户手打点天然不会分毫不差对齐（用户听着停顿按下的那一瞬间
 * 与引擎切的段边界通常差 0.1~0.4s）。阈值取 0.5s 使「先手打几个点、再从转写补齐」
 * 不会在同一处堆两个几乎重合的点；同时 0.5s 远小于正常句长，不会把相邻句误判成重复。
 */
export const AUTO_MARK_MIN_GAP_SEC = 0.5;

/** 自动生成点的标签长度上限（按码点计；超出加省略号）。24 字 ≈ 窄面板 chip 的可读上限 */
export const AUTO_MARK_LABEL_MAX = 24;

/** 选区吸附阈值（秒）：拖选收尾 / 起止输入提交时，距最近打点不超过它即吸上去 */
export const SNAP_TOLERANCE_SEC = 0.3;

/** 按打点切分时段的最短跨度（秒；与 `api/audio/clip` 的 0.1s 下限同口径） */
export const SPLIT_MIN_SPAN_SEC = 0.1;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 段正文 → 打点标签：压平空白 + 截断；空正文返回 undefined（不写空标签） */
export function markLabelFromText(text: string, max = AUTO_MARK_LABEL_MAX): string | undefined {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return undefined;
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

/** 转写里出现过的说话人集合（0 基簇号；未贴标签的段不计入） */
function speakerSet(segments: TranscriptSegment[]): Set<number> {
  const out = new Set<number>();
  for (const s of segments) if (s.speaker !== null && Number.isFinite(s.speaker)) out.add(s.speaker);
  return out;
}

export interface MarksFromRangesOptions {
  /** 去重阈值（秒），默认 `AUTO_MARK_MIN_GAP_SEC` */
  minGapSec?: number;
}

export interface MarksFromRangesResult {
  /** 合并后的完整打点（含原有手打点；按 t 升序） */
  marks: AudioMark[];
  /** 本次新增条数 */
  added: number;
  /** 未新增的条数（与已有点重复，或没有可用标签 / 起点非法） */
  skipped: number;
}

/**
 * **建议区间 → 打点**（把 Highlights 选中的那几段落成音轨上的点；**追加**语义）。
 *
 * 为什么不再是"按转写逐段铺点"（2026-10-18 改）：对话稿本身已是完整对话
 *（轮首即跳转、可改名/改归属、可润色），音频上再按句铺一遍同构的点只是把它摊平成噪音
 * —— 一小时的对话会打出几十上百个点，没有一个代表"哪里值得听"。
 * 现在音频上值得存在的点，只有**被挑出来的那几个区间**：挑（Highlights）→ 落点 → `Split at marks`。
 *
 * 三条硬约束（改这个函数前先读）：
 *   1. **绝不覆盖/删除手打点** —— 传入的 `existing` 原样保留（含标签），只往里面加；
 *   2. **幂等** —— 与 `existing`（以及本次已落下的）距离 < `minGapSec` 的直接跳过，
 *      所以"反复点落点"不会堆点（第二次 added=0）；手打过点的地方也不会多出一个几乎重合的点；
 *   3. 落下的一律带 `auto: true` ⇒ 可以只清这些点（`dropAutoMarks`），手打点毫发无伤。
 *
 * 返回新数组，不改 `existing`（调用方拿它整份 `save_marks`，一批一次往返）。
 */
export function marksFromRanges(
  ranges: ReadonlyArray<{ start: number; label?: string }>,
  existing: AudioMark[],
  opts: MarksFromRangesOptions = {},
): MarksFromRangesResult {
  const minGap = Number(opts.minGapSec) > 0 ? Number(opts.minGapSec) : AUTO_MARK_MIN_GAP_SEC;

  const marks: AudioMark[] = existing.map((m) => ({ ...m })).sort((a, b) => a.t - b.t);
  let added = 0;
  let skipped = 0;

  for (const r of ranges) {
    // 标签空 → 不落点：无名点在音轨上只会变成"看不出是什么的一根线"（同 markLabelFromText 的口径）
    const label = markLabelFromText(r.label ?? '');
    if (!label || !Number.isFinite(r.start) || r.start < 0) {
      skipped++;
      continue;
    }
    const at = round1(r.start);
    if (marks.some((m) => Math.abs(m.t - at) < minGap)) {
      skipped++;
      continue;
    }
    const mark: AudioMark = { t: at, label };
    mark.auto = true; // 顺序无关，但显式成行便于 grep 到"哪里标了 auto"
    marks.push(mark);
    marks.sort((a, b) => a.t - b.t);
    added++;
  }

  return { marks, added, skipped };
}

/** 只留手打点（清除全部自动生成点）。返回新数组 */
export function dropAutoMarks(marks: AudioMark[]): AudioMark[] {
  return marks.filter((m) => !m.auto);
}

/** 磁吸命中的参照点类型（用于给用户一个"吸到了什么"的视觉提示） */
export type SnapKind = 'mark' | 'playhead' | 'tick';

export interface SnapRefsOptions {
  /** 打点时刻（秒）。**优先级高于刻度**：那是用户自己锚的点，磁力更强 */
  marks?: readonly number[];
  /** 刻度格线时刻（秒），即时间线上看得见的那几条 */
  ticks?: readonly number[];
  /**
   * **播放头当前时刻**（秒）。⚠️ 调用方**只在暂停时**传它：
   * 播放中的播放头一直在动，把它当吸附目标会让指针附近"被一直拖走"（体验很怪）。
   */
  playhead?: number | null;
  /** 吸附阈值（秒，**含边界**）。调用方按像素换算（见 AudioMarkTrack 的 SNAP_PX） */
  tolSec: number;
}

/**
 * 把任意时刻**磁吸**到最近的参照点（打点 / 刻度格线）。
 *
 * 三条语义（都有单测）：
 *   1. **只在阈值内吸附**（含边界），阈值外原样返回（四舍五入到 0.1s）—— 是"磁铁"不是"网格量化"：
 *      用户仍能把播放条/选区落在任意位置，只是靠近参照点时会"粘"一下；
 *   2. **优先级：打点 > 播放头 > 刻度**（用户数据 > 刚刚定位到的地方 > 系统网格）；
 *   3. `t` 非法时原样返回，绝不把 NaN 变成某个参照点的时刻。
 *
 * ⚠️ 边界必须带 `1e-9` 容差："含边界"语义下边界两侧的数在 IEEE754 里常常只差一点点
 * （实测 `|30 − 29.7| = 0.30000000000000027 > 0.3`），不加容差会出现"恰好 0.3s 时吸、
 * 换个等价写法就不吸"的随机感（这个坑在 `snapToMark` 上已经被单测抓到过一次）。
 */
export function snapToRefs(
  t: number,
  opts: SnapRefsOptions,
): { t: number; snapped: SnapKind | null } {
  const time = Number(t);
  if (!Number.isFinite(time)) return { t, snapped: null };
  const rawTol = Number(opts.tolSec);
  const tol = Number.isFinite(rawTol) && rawTol > 0 ? rawTol : 0;

  const nearest = (cands: readonly number[] | undefined): number | null => {
    let best: number | null = null;
    let bestDist = tol;
    for (const c of cands ?? []) {
      if (!Number.isFinite(c)) continue;
      const d = Math.abs(c - time);
      if (d <= bestDist + 1e-9) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  };

  // 命中时**原样返回候选值**（不取整）：打点/刻度本身就是其自身精度，而**播放头是连续值** ——
  // 取整会让"吸到播放头"变成"吸到播放头附近的 0.1s 网格"，那正是本功能要消灭的偏差。
  // 只有"没吸上"时才按 0.1s 取整（与打点自身精度同口径）。
  const mark = nearest(opts.marks);
  if (mark !== null) return { t: mark, snapped: 'mark' };
  // 播放头排在打点之后、刻度之前：它是"用户刚刚定位到的地方"，比系统网格更该赢
  const playhead = nearest(opts.playhead == null ? undefined : [opts.playhead]);
  if (playhead !== null) return { t: playhead, snapped: 'playhead' };
  const tick = nearest(opts.ticks);
  if (tick !== null) return { t: tick, snapped: 'tick' };
  return { t: round1(time), snapped: null };
}

/**
 * 把当前时刻/输入值吸附到最近的打点（选区起止、快捷键落点用）。
 *
 * 实现**转发到 `snapToRefs`**（marks-only）：吸附规则只写一份，否则"打点优先/边界含容差"
 * 这类细节会在两处慢慢漂开。返回类型保持 `number`（既有调用方都是直接当数值用）。
 */
export function snapToMark(t: number, marks: AudioMark[], tol = SNAP_TOLERANCE_SEC): number {
  const time = Number(t);
  if (!Number.isFinite(time)) return t;
  const limit = Number(tol) >= 0 ? Number(tol) : SNAP_TOLERANCE_SEC;
  return snapToRefs(time, { marks: marks.map((m) => m.t), tolSec: limit }).t;
}

/**
 * 按打点把 `[0, duration]` 切成 N+1 段（打点即切点）。
 *
 * - 端点去重：相邻切点间距 < `minSpanSec` 的**后者丢弃**（不生成零长/碎片区间）；
 * - 首尾补齐 `0` 与 `duration`；`duration` 未知（≤0/NaN）时返回 `[]`
 *   （宁可什么都不做，也不生成一个"到 0 秒"的空片段）；
 * - 结果按 start 升序，供 `clip_many` 直接消费。
 */
export function splitRangesAtMarks(
  marks: AudioMark[],
  durationSec: number | null | undefined,
  minSpanSec = SPLIT_MIN_SPAN_SEC,
): Array<{ start: number; end: number }> {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const minSpan = Number(minSpanSec) > 0 ? Number(minSpanSec) : SPLIT_MIN_SPAN_SEC;

  const cuts: number[] = [0];
  for (const m of [...marks].sort((a, b) => a.t - b.t)) {
    if (!Number.isFinite(m.t) || m.t <= 0 || m.t >= duration) continue;
    if (m.t - cuts[cuts.length - 1] < minSpan) continue;
    cuts.push(round1(m.t));
  }
  // 尾部不足一段就并入前一段（丢掉一个 0.05s 的尾巴毫无意义）
  if (duration - cuts[cuts.length - 1] < minSpan) {
    if (cuts.length === 1) return [];
    cuts.pop();
  }
  cuts.push(round1(duration));

  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < cuts.length; i++) out.push({ start: cuts[i], end: cuts[i + 1] });
  return out;
}

/** 规则切分的目标块长（秒）：一段跨过这个长度就收块 */
export const RULE_BLOCK_TARGET_SEC = 60;
/** 规则切分的最短块长（秒）：比这短的块没有单独剪出来的价值（音频本身很短时自动放宽） */
export const RULE_BLOCK_MIN_SEC = 20;
/** 说话人轮次块的最短长度（秒）：访谈里一问一答常只有 5~10s，故比时长块的下限更短 */
export const RULE_SPEAKER_MIN_SEC = 5;
/** 规则切分的条数上限（与 AI 精选同口径） */
export const RULE_HIGHLIGHT_MAX = 8;

/**
 * **纯规则**的片段建议（不调模型）—— AI 精选的降级路径。
 *
 * 切块规则（确定性、可复现，故意做得"笨但稳"）：
 *   1. **说话人切换处必切**（仅当转写里有 ≥2 位说话人；单人录音逐段切是噪音）；
 *   2. 否则每跨过 `RULE_BLOCK_TARGET_SEC`(60s) 收一块 ⇒ 典型块长 60~90s；
 *   3. 短于 `RULE_BLOCK_MIN_SEC`(20s) 的块丢弃（**但音频本身很短时按 `total/2` 放宽**，
 *      否则 12s 的录音会一条建议都给不出 —— 那正是"降级路径反而不可用"的坑）；
 *   4. 标题取块内**首段正文**前 12 字（与 AI 路径的命名口径一致）。
 *
 * 为什么需要它：模型没配 / 超时 / 返回不可解析时用户不该被堵死 ——
 * "按内容切几段"用规则就能做得不差，而且它在**没有任何模型**时也成立。
 */
export function ruleHighlights(
  segments: TranscriptSegment[],
  durationSec: number | null | undefined,
  max = RULE_HIGHLIGHT_MAX,
): HighlightSuggestion[] {
  const segs = segments.filter((s) => s.text.trim() && Number.isFinite(s.t));
  if (segs.length === 0) return [];
  const rawTotal = Number(durationSec);
  const lastEnd = segs[segs.length - 1].end;
  const total = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : lastEnd;
  if (!(total > 0)) return [];

  const multi = speakerSet(segs).size >= 2;
  /**
   * 块长下限。**多人录音一律用更短的 `RULE_SPEAKER_MIN_SEC`**：
   * 多人场景下的块本身就是"说话人轮次"，访谈里一问一答常只有 5~10s，
   * 用 20s 会把所有轮次块丢光 ⇒ 降级路径一条建议都给不出（unit test 当场抓到的）。
   * 音频本身很短时再按 `total/2` 放宽，保证短录音也切得动。
   */
  const minSpan = multi
    ? Math.min(RULE_SPEAKER_MIN_SEC, total / 2)
    : Math.min(RULE_BLOCK_MIN_SEC, total / 2);
  const out: HighlightSuggestion[] = [];

  const flush = (fromIdx: number, toIdx: number, isLast: boolean) => {
    const first = segs[fromIdx];
    const end = isLast ? Math.max(first.end, total) : segs[toIdx].end;
    if (!(end - first.t >= minSpan)) return;
    out.push({
      start: round1(first.t),
      end: round1(Math.min(end, total)),
      title: markLabelFromText(first.text, 12)?.replace(/…$/, '') || '',
      reason: '规则切分（未用模型）：按说话人切换 / 约 60s 聚合',
    });
  };

  let blockStart = 0;
  for (let i = 1; i < segs.length; i++) {
    const speakerChanged = multi && segs[i].speaker !== segs[i - 1].speaker;
    const span = segs[i].end - segs[blockStart].t;
    if (speakerChanged || span >= RULE_BLOCK_TARGET_SEC) {
      flush(blockStart, i - 1, false);
      blockStart = i;
    }
  }
  flush(blockStart, segs.length - 1, true);

  // 🔴 兜底保证：规则再怎么切都不该"一条建议都没有"（那等于降级路径不存在）。
  // 走到这里说明所有块都被下限丢掉（典型：全是 10s 内的短句）⇒ 退化成"整段一条"。
  if (out.length === 0) {
    out.push({
      start: round1(segs[0].t),
      end: round1(total),
      title: markLabelFromText(segs[0].text, 12)?.replace(/…$/, '') || '',
      reason: '规则切分（未用模型）：整段（音频较短，未再细分）',
    });
  }
  return out.slice(0, max);
}


/**
 * **拖拽选区该钉哪一端**（纯函数，便于单测把"方向判定"钉死）。
 *
 * 语义：把**离锚点更近的那一端**改成锚点；已经钉住（差 < 1ms）就返回 null（幂等 ---- 避免
 * `setOptions` → `region-updated` 自激循环；这条守卫是本轮唯一容易写出死循环的地方）。
 * 两端都在锚点同侧（选区整体在锚点右边/左边）时，钉住靠近锚的那端，并保证**至少 `minSpan` 宽**，
 * 免得选区被压成零宽（零宽在选区插件里等于"取消选择"）。
 */
export function anchorSelectionEdge(
  sel: { start: number; end: number },
  anchor: number,
  minSpan: number,
): { edge: 'start' | 'end'; value: number } | null {
  const span = Math.max(0, Number(minSpan) || 0);
  const dStart = Math.abs(sel.start - anchor);
  const dEnd = Math.abs(sel.end - anchor);
  if (dStart < 0.001 || dEnd < 0.001) return null; // 已钉住
  if (dEnd <= dStart) {
    const value = Math.max(anchor, sel.start + span);
    if (Math.abs(value - sel.end) < 0.001) return null;
    return { edge: 'end', value };
  }
  const value = Math.min(anchor, sel.end - span);
  if (Math.abs(value - sel.start) < 0.001) return null;
  return { edge: 'start', value };
}

// ──────────────────────────────────────────────────────────────
// 打点名字的**分行**（纯几何，渲染层只负责量宽度）
// ──────────────────────────────────────────────────────────────

/** 一个名字标签的**实测水平盒**（px，相对打点带左缘；由 `getBoundingClientRect` 量出来） */
export interface MarkLabelBox {
  left: number;
  right: number;
}

export interface MarkLabelBoxes {
  /** 下标 = 打点下标；`null` = 该点这一轮不画名字（自动打点）或量不到宽度 */
  boxes: ReadonlyArray<MarkLabelBox | null>;
  /**
   * 放置优先级（**从高到低**）。调用方给：正在编辑 → 有批注 → 时间倒序（新的优先）。
   * 顺序决定"谁占第 0 行、谁被挤到后面的行、谁在行数用尽时被藏"。
   */
  order: readonly number[];
  /** 最多几行（第 0 行在打点带内，其余行往下叠） */
  maxLanes: number;
  /** 同一行内两个名字之间至少要留的空隙（px） */
  minGapPx: number;
}

export interface MarkLabelLayout {
  /** 下标 → 行号（0 = 第 0 行） */
  lanes: Map<number, number>;
  /** 行数用尽仍放不下的下标（渲染层只藏视觉，圆点/悬浮气泡照旧） */
  hidden: Set<number>;
}

/**
 * 把名字标签**按行装箱**（纯函数：只吃实测盒 + 优先级，便于单测钉死）。
 *
 * 为什么不是"碰撞就藏"（2026-10-12 十轮修的正是这个）：藏名的后果是**后打的点把先打的
 * 名字顶掉** —— 实测用户那条 57 分钟录音，三个打点（317.8s / 459.2s / 582.6s）相距 ~31px，
 * 而名字宽 120 / 80px，于是两个真名字全被藏，只剩最新那个没批注的 `09:42`；
 * 用户的原话就是"mark 下一个后，上一个就消失了"（圆点还在，但 6px 的圆点看不出是什么）。
 *
 * 现在：同一行放不下就换下一行（名字之间只吃**垂直**空间），只有行数用尽（`maxLanes`）
 * 才回到"藏视觉"。优先级保证**最新/有批注的**永远在看得见的前几行。
 *
 * 贪心装箱（按优先级依次找第一个放得下的行）对"先到先得"的这类布局是最优的：
 * 任何一个被放进第 k 行的标签，前 k 行都被更高优先级的标签占满了 —— 换任何排法都放不下。
 */
export function packMarkLabels(input: MarkLabelBoxes): MarkLabelLayout {
  const maxLanes = Math.max(1, Math.floor(Number(input.maxLanes) || 1));
  const gap = Math.max(0, Number(input.minGapPx) || 0);
  const lanes = new Map<number, number>();
  const hidden = new Set<number>();
  const keptByLane: MarkLabelBox[][] = [];
  for (const i of input.order) {
    const b = input.boxes[i];
    if (!b) continue;
    const clashes = (kept: MarkLabelBox[]) =>
      kept.some((k) => b.left < k.right + gap && b.right > k.left - gap);
    let lane = -1;
    for (let l = 0; l < maxLanes; l++) {
      const kept = keptByLane[l] ?? (keptByLane[l] = []);
      if (!clashes(kept)) {
        kept.push(b);
        lane = l;
        break;
      }
    }
    if (lane < 0) hidden.add(i);
    else lanes.set(i, lane);
  }
  return { lanes, hidden };
}
