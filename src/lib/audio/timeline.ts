/**
 * 时间线的**纯函数**层：时间格式化 + 刻度标签布局（2026-10-11 八轮从 `AudioMarkTrack.tsx` 下沉）。
 *
 * 为什么要单独一层：这两组逻辑都有**精确到像素的判据**（标签宽 8 字符、窄面板会叠字），
 * 留在组件里就只能靠渲染探针验；抽出来之后用单测把"窄面板不叠字"钉死，回归成本从
 * "起 dev + 跑 Electron" 降到毫秒级。
 */
/**
 * 秒 → `mm:ss`（**秒级**读数：当前时刻 / 总时长 / 缩放窗口长度）。
 *
 * 与 `mmss2` 的分工：这个每帧都在变（播放读数）或只是"大概多长"（窗口长度），
 * 到秒就够；到厘秒会让读数一直抖（见 `mmss2` 的注释）。
 * 2026-10-12 从 `AudioMarkTrack.tsx` 下沉到这里：父级（`AudioViewer` 标题栏）也要用它显示窗口长度。
 */
export function mmss(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 秒 → `mm:ss.cc`（**秒后两位**，厘秒）。
 *
 * 用途只有两处，都是"需要看清落在哪一刻"的地方：
 *   - **时间刻度**（用户要求时间线显示到秒后两位）；
 *   - **悬停投影的时间标签**（Hover 插件跟随鼠标的那一刻）。
 * ⚠️ 刻意**不**用在「当前时刻 / 总时长」读数上：那个每帧都在变，两位小数会让它一直抖，
 * 读数的作用是"大概在哪"，不是"精确到厘秒"（要精确读数看选区输入框或悬停标签）。
 *
 * `toFixed(2)` 会在 59.995 上进位成 `60.00` ⇒ 显示成 `00:60.00` 这种非法写法。
 * 故先把秒**四舍五入到厘秒**再拆分（`Math.round(s*100)`），60.00 于是自然进位到 `01:00.00`。
 */
export function mmss2(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--.--';
  const totalCs = Math.round(sec * 100);
  const m = Math.floor(totalCs / 6000);
  const restCs = totalCs - m * 6000;
  const ss = Math.floor(restCs / 100);
  const cs = restCs - ss * 100;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * 刻度步长候选（长音频自动稀疏）。
 *
 * 🔴 **标签个数由标签宽度反推**（2026-10-11 四轮改）：标签格式从 `mm:ss` 换成 `mm:ss.cc` 后
 * 每个标签宽了 **1.6 倍**（5 字符 → 8 字符，等宽字体），而刻度行是 `relative` + 绝对定位、
 * 标签**左对齐锚在自己的时刻上**（末尾那个必然向右溢出，面板壳只有 `overflow:hidden`）⇒
 * 若维持原来"6–12 个标签"的目标，3401s 的音频会变成 12 × ~55px = 660px，在 272px 窄面板里糊成一片。
 * 故把目标降到 **4–6 个**：个数减半、每个宽 1.6 倍 ⇒ 总宽约为原来的 0.8 倍，比改动前更不容易溢出
 * （这不是"顺手改版式"，而是**这次加宽的必要配套**）。
 *
 * ⚠️ 原约束"**不得出现 < 1s 的步长**"的**理由**是：标签只印到秒时 0.5s 步长会把每个整秒印两遍
 * （实测 `00:00 00:00 00:01 00:01 …`）。现在标签带厘秒，该理由**已不成立** ⇒ 将来若要亚秒刻度，
 * 往 `TICK_STEPS` 加 0.5 是合法的（本文件不主动加：用户要的是"显示精度"，不是"刻度更密"）。
 */
export const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
/** 刻度行最多几个标签（由"标签宽度"反推，见上） */
export const TICK_MAX_LABELS = 6;
/**
 * 刻度标签宽度的**回落估算**（px）：`00:00.00` 共 8 字符，默认字号档实测 **48px**（= 6.0px/字符）。
 * 真实宽度优先用**实测值**传入（见 `tickLabelsForWidth` 的第二参）：标签字号跟随 `data-fontscale`，
 * 换档后估算会偏小 —— 那正是"XL 档下又叠字"的隐患，所以组件会先渲染再量、用实测值收敛。
 */
export const TICK_LABEL_FALLBACK_PX = 48;
/** 相邻标签之间至少留的空隙 */
export const TICK_LABEL_GAP_PX = 8;

/**
 * **按可用宽度**算刻度标签个数上限（2026-10-11 八轮）。
 *
 * 为什么必须看宽度：`tickStops(duration)` 原本只按时长决定"4–6 个"，
 * 而标签是 8 字符（`mm:ss.cc`）≈ 54px ⇒ 6 个要 330px。420px 面板（内容宽 356）放得下，
 * **272px 面板（内容宽 188）放不下 ⇒ 实测叠字 11px**，`00:00.0000:02.00…` 完全不可读。
 * 这是**功能缺陷**，不是审美问题（见 `音频编辑器视觉优化方案_20261011.md` §1.5）。
 */
export function tickLabelsForWidth(widthPx: number, labelPx = TICK_LABEL_FALLBACK_PX): number {
  const w = Number(widthPx);
  if (!Number.isFinite(w) || w <= 0) return TICK_MAX_LABELS; // 还没量到宽度：先按上限渲染，量到再收
  const lw = Number.isFinite(labelPx) && labelPx > 0 ? labelPx : TICK_LABEL_FALLBACK_PX;
  return Math.max(2, Math.min(TICK_MAX_LABELS, Math.floor(w / (lw + TICK_LABEL_GAP_PX))));
}

export function tickStops(duration: number, maxLabels = TICK_MAX_LABELS): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const step = TICK_STEPS.find((s) => duration / s <= maxLabels) ?? Math.ceil(duration / maxLabels);
  const out: number[] = [];
  for (let t = 0; t < duration - step * 0.5; t += step) out.push(t);
  return out;
}

/**
 * 刻度标签是否**右对齐**（文字贴在锚点左侧）。
 *
 * 刻度行绝对定位 + 左对齐锚点 ⇒ 靠右的标签文字会伸出容器右缘（被面板壳 `overflow:hidden` 裁掉）。
 * 这里给"锚点已在右侧 88% 之后"的标签改成右对齐，作为**溢出安全网**
 * （降到 4–6 个标签后很少触发，但触发时不会静默丢字）。
 */
export function tickLabelRightAligned(t: number, duration: number): boolean {
  return duration > 0 && t / duration > 0.88;
}

/** 缩放窗口的最小长度（秒）—— 与 `PEAKS_MIN_WINDOW_SEC` 同口径，由调用方传入以免跨层耦合 */
export const VIEW_MIN_SEC = 2;

/**
 * 把"要定位到的时刻"夹进 `[0, 总时长]`（←/→ 的 ±N 秒、句柄 seek 都走它）。
 *
 * 与 `clampViewStart` 的区别：那个夹的是**窗口起点**（上界 `total − 窗口长`），
 * 这个夹的是**播放头位置**（可以一直走到 `total` 本身）。
 *
 * 三条口径（都有单测）：
 *   - 总时长未知（`0` / NaN，波形还没就绪）时**只保证非负** —— 夹到 0 会让"刚打开就按 →"没反应；
 *   - `t` 非法（NaN / ±Infinity）⇒ 返回 0：宁可停在开头，也不把 NaN 交给播放库
 *     （库收到 NaN 会把播放轴算坏，`currentTime` 一起变 NaN，读数/打点/选区全部跟着坏）；
 *   - 越界一律夹到端点（到头就停住，**不越界、不回绕**）。
 */
export function clampSeekTime(t: number, totalSec: number): number {
  const raw = Number(t);
  if (!Number.isFinite(raw)) return 0;
  const total = Number(totalSec);
  const max = Number.isFinite(total) && total > 0 ? total : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(raw, 0), max);
}

/**
 * 把窗口起点夹进合法范围（`[0, total − sec]`）。
 *
 * 为什么单独一个函数：窗口有三个来源（滚轮缩放、◀▶ 平移、跟随播放头、缩放到选区），
 * 每个都要夹一次；写四遍必然有一处漏夹，而漏夹的症状是"波形右端出现空白"（看起来像数据缺失）。
 */
export function clampViewStart(startSec: number, sec: number, totalSec: number): number {
  const total = Number(totalSec);
  const len = Number(sec);
  const raw = Number(startSec);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const safeLen = Number.isFinite(len) && len > 0 ? Math.min(len, total) : total;
  const maxStart = Math.max(0, total - safeLen);
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(raw, 0), maxStart);
}

/**
 * 按**可见窗口**算刻度（时间轴缩放后必须这样算，否则刻度还是整段的稀疏格）。
 *
 * 与 `tickStops` 同款策略：从 `TICK_STEPS` 里挑"第一个让窗口内标签数 ≤ maxLabels"的步长，
 * 并且**刻度点对齐到步长的整数倍**（不是从窗口起点开始排）—— 这样缩放/平移时刻度不会整体漂移，
 * 用户看到的仍是 `00:02.00 / 00:04.00` 这种"整点"。
 */
export function tickStopsForWindow(
  startSec: number,
  sec: number,
  maxLabels = TICK_MAX_LABELS,
): number[] {
  const start = Number(startSec);
  const len = Number(sec);
  if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0) return [];
  const cap = Number.isFinite(maxLabels) && maxLabels > 0 ? Math.floor(maxLabels) : TICK_MAX_LABELS;
  const step = TICK_STEPS.find((s) => len / s <= cap) ?? Math.max(1, Math.ceil(len / cap));
  const end = start + len;
  const out: number[] = [];
  // 从"第一个 ≥ start 的步长整数倍"开始排；尾部同样不放贴边（半格内）
  for (let k = Math.ceil(start / step); k * step < end - step * 0.5; k++) {
    const t = k * step;
    if (t >= start) out.push(t);
  }
  if (out.length === 0) out.push(start); // 窗口比一个步长还窄时至少给一个刻度
  return out;
}
