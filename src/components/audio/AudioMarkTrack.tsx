'use client';

/**
 * AudioMarkTrack —— 波形播放器 + 打点 + 片段选取（录音打点/截取工具的呈现层）。
 *
 * 放在 `components/audio/` 这个中性目录：会议回放（Butler）与画布音频查看器都要用同一套波形，
 * 谁先接谁后接都不该让它落进某一方的目录里。
 *
 * 音频来源有两种（`srcUrl` 的形态据此不同）：
 *   1. **Blob URL** —— 先把整份音频抓成 Blob 再播（MeetingReplay 的降级链走这条）。
 *      代理不支持 Range 时只能如此；Blob URL 天然可任意 seek。
 *   2. **代理 URL + `precomputed`** —— 服务端先算出波形峰值（见 lib/audio/peaks.ts），
 *      播放交给 `<audio src>` 走 HTTP Range 按需拉取，波形直接由峰值绘制。
 *      WaveSurfer 在「有 peaks + duration」时**既不会整份 fetch 也不会全量解码**
 *      （wavesurfer.js:147-151 / :471 / :536-538），长录音因此不再吃掉几百 MB 内存
 *      （实测 3401s 的录音会解码出 ≈600MB PCM）。
 *      没给 `precomputed` 就退回第 1 种，行为与本组件引入 peaks 之前完全一致。
 *
 * 纯呈现：不认识 API、不落盘——打点的增删与片段导出都通过回调交给父级。
 *
 * 交互：
 *   - 波形点击 = 跳转；播放键 = 播放/暂停；
 *   - **前进/后退 0.3 秒**（2026-10-15 由 3s 改为 0.3s）：播放键**两侧**的 `↺0.3` / `↻0.3`（数字并入箭头，按钮只剩一个字形），
 *     或键盘 `←` / `→`；`Shift` + `←` / `→` = 粗调 3s。走的是同一条定位路径 `seekTo`（夹到 `[0, 总时长]`、
 *     宣告主动定位、缩放后滚到可见处、同步读数），到头/到尾就停住，**不越界不回绕**（见 `NUDGE_SEC` / `NUDGE_COARSE_SEC`）；
 *   - **播放 = 选区感知**（2026-10-12）：有选区时播放键/`Space`**只播选区**（起点外先跳回起点、终点自动停；
 *     再按一次 = 从起点重放）；无选区时是从当前位置播到底。浮条上的 `Play range` 与它同一条停止逻辑。
 *     **2026-10-17**：聚光区间（下轨选中的那个片段）也按同一条收束 —— 选中节选时播放不越过节选部分。
 *   - **逐点复核**（2026-10-12，优化 A）：`[` / `]` = 跳到上/下一个打点；控制行那枚 `⚑` 开关
 *     "停在每个打点"（播放遇到下一个打点自动暂停，只对**连续推进**生效，跳转不会误停）；
 *   - **打点可改时刻**（2026-10-12，优化 C）：点打点名字进就地编辑器后，名字左边那个 `mm:ss.d`
 *     输入框可以直接改时刻（Enter/失焦提交，Esc 取消；改完自动按时间重排、可撤销）；
 *   - Add mark：**冻结**当前播放时刻并展开批注输入框（Enter/失焦确认、Esc 取消），确认后才入库（批注可留空）——精度取播放器真实 currentTime，与段级 `[mm:ss]` 戳无关；
 *   - 波形上拖拽 = 选取片段（区间 region）；**两端都磁吸**（2026-10-12）：按下那端吸在打点/播放头/刻度上，
 *     被拖那端拖到打点竖线附近（6px）也会"粘"上去 ⇒「从打点到打点」切一段，两端都精确落线；
 * Clip 先展开命名输入框（预填默认名，Enter/✓ 导出、Esc/✗ 取消），确认后才交给父级导出（刻意不绑 onBlur：误触发一次 ffmpeg 导出太贵）；点波形空白处或选区旁的 ✕ 退出选区；
 *   - 打点显示为波形**上方的圆点**，悬浮显示名称（无批注则显示时刻），点击跳转；下方列表可点（跳转）/ 改批注 / ×（删除）；
 *   - 倍速：读数右侧的 `1×` 按钮点一下换下一档（0.5/0.75/1/1.25/1.5/2），非 1× 时按钮转为强调色；
 *     倍速记在**模块级**（见 `lastRate`），换源音频/片段重挂后沿用，不用每段重设。
 *   - **时间轴缩放**（只有大文件出现）：滚轮 = 以指针处为锚点缩放（`shift+滚轮` = 平移），
 *     或用**标题栏**那一组「Zoom」控件（`−` / `+` / `◀ 窗口长度 ▶` / 缩放到选区 / Follow）。
 *     `Esc` = 整段适配（快捷键只在焦点位于播放器内时生效；点标题栏那组控件会自动把焦点收回来）。
 *     ⚠️ 2026-10-12：这一行从"浮在波形右上角"搬到了**波形与刻度之下** —— 浮着会压住数据区
 *     （用户原话"放大缩小悬浮按钮在时间线上，很影响用户体验"），搬走后波形区零遮挡。
 *
 * 2026-10-11 二轮（打点/截取智能化）新增，全部**可选**、不接就与之前逐字节一致：
 *   - **选区吸附打点**：I/O 快捷键与起止输入框提交时，距最近打点 ≤0.3s 即吸附
 *     （`lib/audio/mark-ops.ts` 的 `snapToMark`）⇒「从这个打点到那一刻」切得整齐；
 *   - **打点名字/编辑内联在打点处**（2026-10-11 六轮，用户要求）：不再在轨道下方单独列一列 chips
 *     —— 那一列与"片段清单"太像，打点与截取容易混。现在：名字渲染在波形上（打点正上方），
 *     点名字就地改名、点圆点跳转、悬浮圆点出气泡（名字 + ✎/✕）。**重叠靠实测宽度分行**
 *     （`MARK_LABEL_MAX_LANES`：同排挤不下就换下一行；十轮起不再"藏名"，见 `MARK_LABEL_MIN_GAP_PX`），
 *     超出行数上限的点仍可通过气泡改名/删除，功能不丢；
 *   - **命名可外接**：`suggestClipName`（父级从转写文本里取默认名）与
 *     `onRequestClipName`（`✦` 让模型起名，拿到非空结果才覆盖草稿）；
 *   - **句柄新增** `getSelection()`：父级的"只转写这一截"要复用这里的选区状态
 *     （选区归本组件所有，只能这样问出来，不为它单开回调）。
 *
 * 字号口径（2026-10-11 定，与 AudioViewer 共用同一套）：
 *   L1 操作（`Add mark` / `Save excerpt` / `Play`）= `text-12`；L2 读数（`now / duration`）= `text-10`；
 *   L3 刻度（时间刻度）= `text-10` + `--ink-faint`。判定规则：**同一视觉行内，可点击文字的字号
 *   必须 > 不可点击文字的字号** —— 此前三者同为 `text-10`，层次只剩颜色一条通道。
 *
 * 行序口径（2026-10-11 二轮定稿，**六轮起 `{marks}` 与 `{draft}` 两行已取消** —— 打点相关的
 *   展示与编辑全部移到波形上的打点处，见上）：顺序 = 波形 → 控制行 → `{sel}`（选区编辑面）→ `{clipDraft}`。
 *   ⚠️ 下面这段"持久列表必须最上、不被推动"的推演仍**承重**：`{sel}` 的 0↔1 完全跟随一次拖选手势，
 *   属临时编辑面，必须排在最后；将来若再加条件行，仍要遵守"存在感越弱越靠下"。
 *   - `{marks}` 是**唯一**的持久数据展示，必须排在最上 ⇒ **不被任何交互推动**（实测：点 `Clip`/
 *     `Add mark`、拖选/清除选区时它一律 Δ=0）。
 *   - `{sel}` 虽然常驻到选区被清除，但它的 0↔1 **完全跟随一次拖选手势** ⇒ 归类为**临时编辑面**，
 *     必须排在 `{marks}` **之后**。曾放在前面：拖选会把打点列表 + 下方状态条/片段清单整块下推
 *     **30.38 / 33.62 / 36.87px @ m/l/xl**（XL 档 + 面板最小宽 272px 时 `flex-wrap` 折两行 ⇒ **63.00px**）。
 *     代价（已知）：**有选区时提交一次打点会把 `{sel}` 行下移一行**（两行等高，下方内容净位移 0）。
 *   - `{clipDraft}`/`{draft}` 是纯临时编辑器，排最后。（两者**不合并**成单槽位：addMark 与 openClip
 *     互不清除，同时打开是可能的，合并会静默隐藏其中一个。）
 *   ⚠️ 几何：四类行**行高完全相同**（`--lh-md + 2×0.125rem`），列间距 `0.375rem`
 *     ⇒ 任一行的插入/移除位移 = 行高 + 间距 = **30.38 / 33.62 / 36.87px @ m/l/xl**（实测吻合到 0.01px）。
 *     故「换位」不产生额外几何差异，只改变**哪个块在动**。
 *
 * 时间显示与落点（2026-10-11 四轮加）：
 *   - **刻度标签 = `mm:ss.cc`（秒后两位）**；标签个数随之从"6–12 个"降到 4–6 个
 *     （标签宽 1.6 倍 ⇒ 个数必须减半才不糊，理由与实测见 `TICK_STEPS` 上方注释）；
 *   - **悬停**：官方 Hover 插件跟随鼠标画**投影竖线**（半透明，与真实播放条区分）+ 时间标签，
 *     同样是 `mm:ss.cc`，标签靠右时自动翻到左侧；
 *   - **按下**：`pointerdown` **立即** `setTime` 落点 ⇒ 真实播放条（WaveSurfer 的 cursor）当场出现。
 *     ⚠️ WaveSurfer 自带的 seek 挂在 **`click`（抬起）** 上（`wavesurfer.js:231` 的 `clickSignal`），
 *     所以"按下即落点"必须由本组件自己补 —— 这不是重复实现，是补语义。
 *     已知取舍：拖拽选区的按下同样会先把播放条落到选区起点（符合"按下即落点"的直觉）。
 *     刻度/悬停用厘秒、而「当前时刻/总时长」读数保持 `mm:ss`（那个每帧在变，加两位会一直抖）。
 *
 * 兜底：波形解码失败（浏览器拼接的分片 blob 不是每个都能被 decodeAudioData 吃下）时
 * 退回原生 `<audio controls>`——打点用不了，但**播放不丢**，绝不让回放整屏报错。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions';
import { Check, Flag, Pause, Pencil, Play, Plus, RotateCcw, RotateCw, Scissors, Sparkles, X } from 'lucide-react';
import type { AudioMark } from '@/lib/audio/marks';
import { anchorSelectionEdge, packMarkLabels, snapToMark, snapToRefs, type SnapKind } from '@/lib/audio/mark-ops';
import {
  TICK_LABEL_FALLBACK_PX,
  TICK_MAX_LABELS,
  VIEW_MIN_SEC,
  clampSeekTime,
  mmss,
  mmss2,
  tickLabelsForWidth,
  tickLabelRightAligned,
  tickStops,
  tickStopsForWindow,
} from '@/lib/audio/timeline';
import { clipBaseName } from '@/lib/audio/naming';

/** 父级拿到的播放句柄（字幕点句跳转、外部联动、转写面板按句截取用） */
export interface AudioMarkTrackHandle {
  /** 跳到某秒（不自动播放） */
  seek(t: number): void;
  /** 当前播放时刻（秒） */
  getCurrentTime(): number;
  /** 从当前位置开始播放 */
  play(): void;
  /** 清掉波形选区（也用于解除“只播这一段”的播放收束） */
  clearSelection(): void;
  /** 只播某一段（下轨选中片段后的显式 `Play excerpt`） */
  playRange(range: { start: number; end: number }): void;
  /**
   * 当前选区（无选区返回 null）。
   * 供父级的「只转写这一截」入口用 —— 长音频（>30 分钟）整段转不了，按范围转写是正解，
   * 而选区状态归本组件所有，只能这样问出来（不为它单开一个回调：父级只在点击那一刻需要它）。
   */
  getSelection(): { start: number; end: number } | null;
  /**
   * 时间轴缩放的**命令口**（标题栏那一行控件用）。
   *
   * 为什么命令放句柄、状态走 `onViewChange`：缩放的真源（库的 zoom/scroll + 我们镜像的窗口）
   * 全在本组件里，父级只该"按按钮"和"知道当前状态"，不该各自再存一份能对不上的副本。
   */
  zoomIn(): void;
  zoomOut(): void;
  /** 整段适配（= 缩放行那个窗口读数按钮 / `Esc`） */
  fitAll(): void;
  /** 平移：正数向右、按容器宽的比例（0.5 = 半屏） */
  panBy(ratio: number): void;
  /** 缩放到当前选区（无选区时什么都不做） */
  zoomToSelection(): void;
  /**
   * 缩放到**任意区间**（不要求它正好是当前选区）：区间铺满视图 + 两侧 5% 余量。
   * 用途 = 下轨选中片段时"一键放大到界面宽度"（用户 2026-10-17 提的那个按钮）——
   * 与 `zoomToSelection` 共用同一段实现，只是区间从哪儿来不同。
   */
  zoomToRange(range: { start: number; end: number }): void;
  /** 跟随播放头开关（标题栏那颗 Follow） */
  setFollow(on: boolean): void;
}

/**
 * 时间轴**视图状态**快照（`onViewChange` 往外发的那一份）。
 *
 * 父级（`AudioViewer` 标题栏）只拿它来渲染那几个控件的**可用性/读数**：
 *   - `zoomable`：是否值得显示这组控件（只有走 peaks 的大文件才可缩放，见 `zoomable` 的定义）；
 *   - `view`：当前可见窗口（`null` = 整段视图）；
 *   - `loading`：正在拉窗口/细分辨率峰值（期间置灰，避免连点打出一串请求）；
 *   - `follow`：是否跟随播放头。
 */
export interface AudioTrackViewState {
  zoomable: boolean;
  view: { start: number; sec: number } | null;
  loading: boolean;
  follow: boolean;
}

/**
 * 服务端预算好的波形数据（见 lib/audio/peaks.ts）。
 * 同时给出 peaks 与 duration 才会走「不下载、不解码」的快路径 —— 二者缺一不可
 * （WaveSurfer 构造时只在 `peaks && duration` 都成立才短路，见 wavesurfer.js:147-151）。
 */
export interface PrecomputedWaveform {
  /** 单声道峰值，值域 [-1, 1]，长度 = 桶数 */
  peaks: number[];
  /** 总时长（秒） */
  duration: number;
}

interface AudioMarkTrackProps {
  /** 音频 URL：Blob URL，或（给了 precomputed 时）可直接 Range 的代理 URL */
  srcUrl: string;
  /** 服务端预算的波形数据；缺省 = 退回「整份抓 Blob + 全量解码」的老路径 */
  precomputed?: PrecomputedWaveform | null;
  /** 打点（已按 t 升序） */
  marks: AudioMark[];
  /** 在当前播放时刻打点（父级负责入库）；label = 批注，可空 */
  onAddMark?: (t: number, label?: string) => void;
  /** 打点列表变化（父级负责入库） */
  onMarksChange?: (marks: AudioMark[]) => void;
  /** 标题：用于预填片段默认名（缺省 Audio） */
  clipTitle?: string;
  /** 导出片段（父级负责调 ffmpeg）；name = 用户改过的主名，未改则 undefined */
  onClip?: (start: number, end: number, name?: string) => void;
  /** 播放推进（字幕高亮用） */
  onTimeUpdate?: (t: number) => void;
  /** 波形就绪（拿到总时长） */
  onReady?: (duration: number) => void;
  /** 正在导出片段（按钮置灰） */
  busy?: boolean;
  /**
   * 给待导出的区间**预填一个内容相关的名字**（同步；父级从转写文本里取）。
   * 返回 undefined/空串时回退既有的 `clipBaseName`（`片段 - 标题 - 时间戳`）——
   * 即"没有转写也照常能用"，这条链路不是新增的必填依赖。
   */
  suggestClipName?: (start: number, end: number) => string | undefined;
  /**
   * 让父级去问模型要一个更好的片段名（异步；截图里那个 `✦`）。
   * 返回 null 表示拿不到（未配置模型 / 超时 / 清洗后为空），此时**保持用户手上的草稿不动**，
   * 由父级负责把原因写进状态条。
   */
  onRequestClipName?: (start: number, end: number) => Promise<string | null>;
  /**
   * **按窗口取峰值**（时间轴缩放用）。不在组件里直接打 API：本组件只做呈现与交互，
   * 父级才知道 API 口径（source/path）。返回 null = 取不到（父级降级，本次缩放不生效）。
   */
  onRequestWindowPeaks?: (startSec: number, sec: number, points: number) => Promise<number[] | null>;
  /**
   * **时间轴视图状态变化**（2026-10-12 加）：标题栏那组缩放控件要跟着改读数/置灰。
   * 不接 = 与之前逐字节一致（组件自己的行为完全不受影响）。
   */
  onViewChange?: (v: AudioTrackViewState) => void;
  /**
   * **选区变化**（2026-10-15 加）：波形选区（绝对秒）实时往外发，`null` = 当前无选区。
   * 供转写面板高亮"落在选区内的句子"（父级把它转给 `TranscriptPanel`）。
   * 不接 = 与之前逐字节一致（组件行为完全不受影响）。
   */
  onSelectionChange?: (sel: { start: number; end: number } | null) => void;
  /**
   * **高亮区间**（2026-10-17 加）：给了它（绝对秒）就在波形上做一次"聚光"——
   * 该区间保持原样（外加一层极淡的主色染 + 两道边界），**其余整段压暗**。
   * 用途：下轨选中某个片段时，主音轨只亮这一段的源波形，"我在编辑哪一段"一眼可见。
   * `null` / 不接 = 完全不做暗化（既有观感逐字节不变）。
   *
   * ⚠️ 2026-10-17 起它**同时是播放边界**：走带键 / `Space` 在这个区间里收束（见 `toggle`）
   * —— 用户要求"选中节选时，播放不能超过节选部分"。聚光与"不许播出去"是同一件事的两面：
   * 亮着的这一段就是当前聚焦的那一段。
   */
  spotlight?: { start: number; end: number } | null;
  /**
   * **播放作用域 chip**（2026-10-17 加）：父级选中某个片段时把这一项传进来，
   * 控制行就显示“正在只播这一段”，点 × 交回父级清除作用域。
   *
   * 为什么放在控制行：`spotlight` 从 2026-10-17 起**同时是播放边界**（见 `toggle`），
   * 但这条边界原先只存在于行为里、屏幕上没有任何提示 —— 用户不知道自己在听片段还是整段。
   * 显式 chip 把“隐式模式”变成“看得见、可退出”的状态。
   * 不传 = 与之前逐字节一致。
   */
  playScope?: { label: string; onClear: () => void } | null;
}

/** 读主题色（canvas 不认 CSS 变量，必须取解析后的字面值；取不到用兜底色） */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 选区最短长度（与 enableDragSelection 的 minLength 同口径） */
const MIN_SEL = 0.2;

/** 倍速档位（点一下换下一档；从 2× 回到 0.5×） */
const RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * 前进/后退的**精修**步长（秒）—— 控制行那两个 `↺0.3` / `↻0.3` 按钮与 `←` / `→` 快捷键共用。
 *
 * 为什么改为 0.3 秒（2026-10-15，用户提案）：这屏的主要工作是**卡选区边界 / 找打点落点**，
 * 3 秒一步会跳过一句里的气口；0.3 秒刚好是"一个字的量级"，够精修又不至于要连点十几次。
 * 粗调（跨句/跨段）交给 `NUDGE_COARSE_SEC`（`Shift` + `←`/`→`）与打点跳转 `[` / `]`。
 * 与倍速无关（倍速只改播放速度，不改这个跨度）。
 */
const NUDGE_SEC = 0.3;

/** 前进/后退的**粗调**步长（秒）：`Shift` + `←` / `→`。用于长录音里快速挪一段 */
const NUDGE_COARSE_SEC = 3;

/**
 * 上次用过的倍速（**模块级**，不是组件 state）。
 * 父级给本组件挂了 `key={音频路径}`，切换源音频/片段会整只重挂 —— 若存在 state 里，
 * 用户每换一条片段就得重设一次倍速。模块级变量跨挂载保留（会话内），换片段不用重设。
 */
let lastRate = 1;

/**
 * 磁吸半径（**像素**，不是秒）。
 *
 * 为什么按像素：按固定秒数会在两端都失灵 —— 57 分钟的录音里 0.3s 只占零点几个像素（几乎吸不到），
 * 而 4 秒的音频里 0.3s 是整条波形的 7.5%（到处都在吸，反而失去"精确落点"的能力）。
 * 换算成秒的公式见 `timeAtClientX`：`px / 波形宽 × 时长`。
 * 取 6px：约等于指尖/指针的瞄准误差，够"粘"又不会把自由位置吃掉。
 */
const SNAP_PX = 6;

/**
 * 打点名字的**内联标签**：渲染在波形上（打点正上方），不再在轨道下方单独列一行。
 *
 * 为什么改（2026-10-11 六轮，用户要求）：轨道下方那一列 chips 与"片段清单"长得很像，
 * 打点与截取容易混；把名字与编辑都放到**打点处**，两条链路的 UI 就分开了。
 *
 * 关键约束是**碰撞**：名字宽度固定不了（中文/英文/长短不一），而点可能密到几像素一个
 * （按转写一键生成 30+ 个点、57 分钟录音上相邻两点只差 ~2px）。故**不猜宽度**：
 * 渲染后用 `getBoundingClientRect` 实测，再按实测盒**分行**（见 `MARK_LABEL_MAX_LANES`）。
 * 行数变化时**打点带自己长高**（名字只出现在带内）⇒ 名字永远不会盖住波形。
 *
 * ⚠️ 2026-10-12 十轮修正之一（用户反馈"mark 下一个后，上一个就消失了"）：
 * 九轮及以前是"碰撞就 `visibility:hidden` 藏掉"，优先级按时间倒序 —— 结果是
 * **后打的点一定会把先打的名字顶掉**（实测用户那条 57 分钟录音：317.8s / 459.2s / 582.6s
 * 三个点相距 ~31px，而名字宽 120/80px，于是两个真名字全被藏，只剩最新那个没名字的 `09:42`）。
 * 用户看到的就是"上一个打点不见了"（圆点其实还在，只是 6px 的圆点几乎看不出是什么）。
 * 十轮改成**叠行**：同一行放不下就换下一行，名字与圆点都不再消失。
 *
 * ⚠️ 十轮修正之二（用户反馈"点打多了，后面就对不上时间线了"）：叠行最初是把第 1..3 行**覆在波形上**，
 * 于是打点多起来之后（实测 13 个点）名字散落在 4 个高度、最深的一行压到波形中部 —— 既看不出
 * 哪个名字属于哪个圆点（"对不上时间线"），也把波形盖住、挡住了那里的点按定位。
 * 现在改成：**行数由打点带自己长高来容纳**（第 0 行最靠近圆点，优先级最高的名字排在第 0 行），
 * 名字层始终只在带内 ⇒ 波形区域与六轮定稿时一样**完全不被遮挡、点击不被截走**。
 */
const MARK_LABEL_MIN_GAP_PX = 4;

/**
 * 名字行盒**实测**：`text-10` + `py-0.5` + 1px 边框 + `leading-none` ⇒ 约 16px（随主题 rem 略变）。
 * 行距取 17px ⇒ 相邻两行之间留 1px 缝。
 */
const MARK_LABEL_LANE_PITCH_PX = 17;

/**
 * 名字最多占几行（打点带最多长高到 `1.5rem + (MAX−1) × 17px` = 111px）。
 *
 *   - 第 0 行**最靠近圆点**（圆点在带底部 `bottom-0`）；优先级最高的名字排第 0 行；
 *   - 再多行就往上排 ⇒ 打点带长高，**波形与下方内容整体下移**（这是"名字不盖波形"的代价）；
 *   - 超出行数上限仍走"只藏视觉"（圆点加描边 + 悬浮气泡给名字/✎/✕），⚠️ 优先级保证被藏的一定是
 *     **信息量最低**的那个（先藏没批注的老点、再藏有批注的老点，见判定 effect 的 order）。
 *
 * 取 6 行的理由：实测用户那条 57 分钟录音里 4.4 分钟内打了 3 个点（相距 ~31px）、
 * 一段里挤 4~5 个名字是常态；6 行足够覆盖，同时把最长带高压在 111px 以内（不会把波形顶出首屏）。
 */
const MARK_LABEL_MAX_LANES = 6;

/**
 * 第 `lane` 行的 `top`（px，相对打点带顶边）。
 *
 * 行号从**底部**数：`lane 0` 紧贴圆点那一行（打点带底部往上第一行），`lane k` 在它上面第 k 行。
 * 带高由 `labelLaneCount` 决定（见渲染处）⇒ 行号越大越靠上，永远不会压到带底那排圆点。
 */
function labelLaneTop(lane: number, lanes: number): string {
  const fromBottom = Math.max(0, lanes - 1 - lane);
  return `${fromBottom * MARK_LABEL_LANE_PITCH_PX}px`;
}

/** 两个下标集合内容是否相同（effect → setState → effect 的收敛判据，避免无谓重渲染） */
function sameIndexSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const i of b) if (!a.has(i)) return false;
  return true;
}

/** 两个「下标 → 行号」映射内容是否相同（同上） */
function sameIndexMap(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

/** 秒 → mm:ss.d（选区起止输入框的回填格式，保留一位小数） */
function mmssPrecise(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** "mm:ss(.d)" / "hh:mm:ss" / 纯秒 → 秒；非法输入返回 null（调用方回退原值） */
function parseTimeInput(str: string): number | null {
  const s = str.trim();
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':').map((p) => p.trim());
    if (parts.length > 3 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + Number(p);
    return sec;
  }
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

export const AudioMarkTrack = forwardRef<AudioMarkTrackHandle, AudioMarkTrackProps>(function AudioMarkTrack(
  {
    srcUrl,
    precomputed,
    marks,
    onAddMark,
    onMarksChange,
    onClip,
    clipTitle,
    onTimeUpdate,
    onReady,
    busy,
    suggestClipName,
    onRequestClipName,
    onRequestWindowPeaks,
    onViewChange,
    onSelectionChange,
    spotlight,
    playScope,
  },
  ref,
) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  /**
   * 组件根节点（带 `tabIndex=0` 与 `onKeyDown` 的那一层）。
   * 用途只有一个：**标题栏那组缩放控件点完后把焦点收回播放器** —— 否则焦点留在父级的按钮上，
   * `Space`/`←`/`→`/`M`/`Esc` 这些"焦点在播放器内才生效"的快捷键会全部失灵（实测 Esc 失效）。
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 把焦点收回播放器（不引起滚动） */
  const focusPlayer = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const clipRegionRef = useRef<Region | null>(null);
  /** 拖拽收尾那次 click 不该被当成「点空白退出选区」（时间窗抑制） */
  const suppressClickUntilRef = useRef(0);
  /** 试听选区的自动暂停点（秒）；null = 不自动停 */
  const playUntilRef = useRef<number | null>(null);
  const marksRef = useRef<AudioMark[]>(marks);
  /** 回调放 ref：重建波形（换 srcUrl）不该因父级重渲染而反复拆装 */
  const cbRef = useRef({ onAddMark, onMarksChange, onClip, onTimeUpdate, onReady, onViewChange, onSelectionChange });
  useEffect(() => {
    cbRef.current = { onAddMark, onMarksChange, onClip, onTimeUpdate, onReady, onViewChange, onSelectionChange };
  }, [onAddMark, onMarksChange, onClip, onTimeUpdate, onReady, onViewChange, onSelectionChange]);

  const [playing, setPlaying] = useState(false);
  /** 倍速：初始值取自模块级 lastRate（换片段后沿用），见文件头常量处说明 */
  const [rate, setRate] = useState(() => lastRate);
  const rateRef = useRef(lastRate);
  /**
   * 波形**实测宽度**（px）：刻度标签个数要按它算，否则窄面板下 8 字符的标签会叠字。
   * 用 ResizeObserver 而不是只量一次：面板是可拖拽缩放的，拖窄后必须重算。
   */
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  const [now, setNow] = useState(0);
  /**
   * **整段总时长**（绝对秒）。⚠️ 语义固定：永远是"整段的长度"，**不是**当前视图的长度 ——
   * 窗口模式下 `ws.getDuration()` 返回的是**窗口长度**，绝不能拿它覆盖这里（否则刻度/打点/读数全线错）。
   */
  const [duration, setDuration] = useState(0);
  /** 同上的 ref 版（事件处理器与 `pctOf` 要读它） */
  const totalSecRef = useRef(0);
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  /** 每次提交起止输入都自增：让两个输入框重挂以回填格式化值（非法输入回退原值） */
  const [selVersion, setSelVersion] = useState(0);
  const [failed, setFailed] = useState(false);
  /** 正在新建的打点：t 在点「Add mark」那一刻**冻结**，避免边打字边漂；确认后才入库 */
  const [draft, setDraft] = useState<{ t: number; text: string } | null>(null);
  /** 正在改批注的既有打点：下标 + 草稿文本 */
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  /** 正在命名待导出的片段：起止冻结 + 主名草稿（扩展名由服务端按源容器补） */
  const [clipDraft, setClipDraft] = useState<{ start: number; end: number; text: string } | null>(null);
  /**
   * 悬停投影：`ratio` = 0..1 在波形上的水平位置（**已按吸附结果反算**，所以线一定落在吸附点上），
   * `t` = 该位置的时刻，`snapped` = 吸到了什么（null = 自由位置）。
   */
  const [hover, setHover] = useState<{ ratio: number; t: number; snapped: SnapKind | null } | null>(null);
  /**
   * **被碰撞挤掉的标签下标**（见 `MARK_LABEL_MIN_GAP_PX` 的注释）：这些打点只显示圆点，
   * 名字靠悬浮气泡给出（气泡里带 ✎/✕，所以隐藏的标签照样能改名/删除）。
   * ⚠️ 十轮起这**只是兜底**：前 `MARK_LABEL_MAX_LANES` 行都能放，只有超出行数上限的才落到这里。
   */
  const [hiddenLabels, setHiddenLabels] = useState<ReadonlySet<number>>(new Set());
  /**
   * **每个名字所在的行号**（0 = 最靠近圆点那一行，往上是 1、2…；见 `labelLaneTop`）。
   *
   * 十轮新增：碰撞不再"藏"，改成"换一行"。缺少表项的按第 0 行渲染（首帧、或该点本就不画名字）。
   */
  const [labelLanes, setLabelLanes] = useState<ReadonlyMap<number, number>>(new Map());
  /**
   * 名字一共用了几行（≥1）—— 打点带的高度由它决定（`1.5rem + (lanes − 1) × 17px`）。
   * 只有 1 行时不写内联高度 ⇒ 默认几何与六轮定稿**逐字节一致**。
   */
  const labelLaneCount = useMemo(() => {
    let max = 0;
    for (const lane of labelLanes.values()) if (lane + 1 > max) max = lane + 1;
    return Math.max(1, max);
  }, [labelLanes]);
  /**
   * **需要翻到锚点左侧**的名字下标（由实测宽度算出，非阈值）。
   * 见下方判定 effect 的注释：固定阈值会误翻，而误翻会**连带隐藏别的名字**。
   */
  const [flippedLabels, setFlippedLabels] = useState<ReadonlySet<number>>(new Set());
  /**
   * **视图窗口**（时间轴缩放的核心状态）：`null` = 整段（原行为），非空 = 只渲染 `[start, start+sec]`。
   *
   * 真源是**库自己**：`zoom(minPxPerSec)` + `setScroll/getScroll`，`view` 只是镜像出来的可见窗口
   * （给刻度/吸附/探针用）。时间轴恒为**绝对** ⇒ 下面那条 `pxOf` 是唯一的几何。
   */
  /**
   * 缩放级别（minPxPerSec）与滚动位置（px）的 **state 镜像**：真源在库里，
   * 这两个只是"让 React 跟着重渲染"（覆盖层、刻度都靠它）并给探针当锚点。
   */
  const [zoomPx, setZoomPx] = useState(0);
  const [scrollPx, setScrollPx] = useState(0);
  const [view, setView] = useState<{ start: number; sec: number } | null>(null);
  /** 给回调/事件处理器用的实时窗口（state 在闭包里会过期） */
  const viewRef = useRef<{ start: number; sec: number } | null>(null);
  /** 当前窗口的峰值（拉取中/失败时为 null ⇒ 保持旧波形，不做半截渲染） */
  /** 选区（绝对秒）的 ref 镜像 */
  const selRef = useRef<{ start: number; end: number } | null>(null);
  /** 聚光区间（绝对秒）的 ref 镜像：走带 `toggle` 只在没有选区时用它当播放边界 */
  const focusRef = useRef<{ start: number; end: number } | null>(null);
  /** 正在取窗口峰值/细分辨率（用于把 +/− 置灰，避免连点打出一串请求） */
  const [viewLoading, setViewLoading] = useState(false);
  /** 细分辨率峰值的点数（0 = 还没加载；仅用于展示与探针锚点） */
  const [finePx, setFinePx] = useState(0);
  /** 细分辨率是否已在加载中 / 已加载（ref 版：供异步流程读，避免塞进依赖表） */
  const fineLoadingRef = useRef(false);
  const fineDoneRef = useRef(false);
  /**
   * **细分辨率被"挂起"了**（播放中收到换峰值的请求 ⇒ 等 pause 再换）。
   * 见 `ensureFinePeaks` 的注释：播放中 `ws.load()` 会静默打断播放。
   */
  const finePendingRef = useRef(false);
  /** `ensureFinePeaks` 的 ref 版（建库 effect 里的 pause 处理器要能调它，而它定义在后面） */
  const ensureFinePeaksRef = useRef<() => void>(() => {});
  /** 窗口峰值请求号（丢弃乱序返回的旧结果） */
  const viewReqIdRef = useRef(0);
  /**
   * **用户定位序号**：每次"用户主动跳转/改选区"自增。
   *
   * 为什么需要它：切窗口要 `ws.load()`，而 load 会把播放头复位 ⇒ 我在 `.then()` 里做了"恢复到切窗前的时刻"。
   * 但那个 `.then()` 是**异步**的：用户在等待期间又点了一下，恢复动作就会**把用户的新定位覆盖掉**
   * （实测：缩放后按下落点被拉回旧位置，差 67s；拖出的选区也跟着错）。
   * 故：切窗时记下序号，恢复前比对 —— 期间用户动过手就**放弃恢复**。
   */
  const seekSeqRef = useRef(0);
  /**
   * **按下那一刻吸附到的绝对时刻** —— 拖拽选区的"锚"。
   *
   * 本轮核心：选区原本由选区插件按**指针裸坐标**算（它自己 3px 阈值、不认打点/播放头），
   * 于是"起点最多偏几个像素"；而用户要的是"**从打点或播放头所在的那一刻开始拉**"。
   * 故按下时把吸附结果记下来，拖拽过程中**它固定不动**、另一头跟着鼠标走。
   */
  const pressAnchorRef = useRef<number | null>(null);
  /** 仪表：按下时锚点的**可读**副本（探针用；同时暴露 pin 写入次数，便于定位"到底哪一步没生效"） */
  const [pressAnchorDbg, setPressAnchorDbg] = useState<number | null>(null);
  const [pinCount, setPinCount] = useState(0);
  /** 仪表：捕获阶段 pointerup 命中次数（验证"归位到底有没有跑"） */
  const [upCount, setUpCount] = useState(0);
  /** 播放头当前绝对时刻（ref 版：事件处理器要读它，state 会过期） */
  const nowRef = useRef(0);
  /**
   * `syncViewFromLib` 的 **ref 转发**：建库 effect 在它之前就要订阅 `zoom/scroll`，
   * 直接写进依赖表会 TDZ（依赖数组在渲染期求值）—— 这是本轮踩到的第三个同类坑。
   */
  const syncViewRef = useRef<() => void>(() => {});
  /**
   * `snapTime` 的 **ref 转发**（同 `syncViewRef` 的理由）：建库 effect 里的拖拽处理器要用它，
   * 而它定义在 effect 之后 —— 直接引用会 TDZ。
   */
  const snapTimeRef = useRef<(tAbs: number) => { t: number; snapped: SnapKind | null }>((t) => ({ t, snapped: null }));
  /** 是否已做过"初始整段适配"（`ready` 会因 `load()` 反复触发，只允许适配一次） */
  const fittedRef = useRef(false);
  /** `stopAtMarks` 的 ref 版（timeupdate 处理器在 effect 闭包里，读 state 会过期） */
  const stopAtMarksRef = useRef(false);
  /** 设置滚动位置：**先同步写 ref 再写 state** ——
   *  ref 是同一 tick 内后续几何（pxOf / visibleWindow / 拖拽换算）读的值，
   *  只写 state 的话要等渲染后的 effect 才同步，那期间的换算全部基于旧滚动（实测：缩放后悬停/拖选整体偏一个窗口）。 */
  const setScrollSync = useCallback((px: number) => {
    scrollRef.current = px;
    setScrollPx(px);
  }, []);

  /**
   * **当前可见窗口**（秒），由缩放/滚动**派生**（不是独立状态 —— 真源在库里，避免两套状态漂移）。
   * 刻度、吸附参照、打点名字的碰撞判定都用它。
   */
  const visibleWindow = useCallback((): { start: number; sec: number } => {
    const mpps = zoomRef.current || 0;
    const w = boxWidthRef.current || 0;
    const total = totalSecRef.current || 0;
    if (!(mpps > 0) || !(w > 0)) return { start: 0, sec: total };
    return { start: scrollRef.current / mpps, sec: Math.min(total, w / mpps) };
  }, []);
  /** 播放态（ref 版：吸附要靠它决定播放头是否参与） */
  const playingRef = useRef(false);
  /** 父级给的取峰值回调固化到 ref：它是可选 prop，直接进依赖会让"父级每次重渲染 ⇒ 重新拉一次窗口峰值" */
  const reqPeaksRef = useRef(onRequestWindowPeaks);
  useEffect(() => {
    reqPeaksRef.current = onRequestWindowPeaks;
     
  }, [onRequestWindowPeaks]);

  /** P2-3 选区浮条的**实测宽度**（用于把它夹在波形内，不让它伸出面板被裁） */
  const [selBarW, setSelBarW] = useState(0);
  const selBarRef = useRef<HTMLDivElement | null>(null);
  // 浮条宽度实测（夹取要用它，避免靠右缘时伸出波形被裁）
  useEffect(() => {
    const el = selBarRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w > 0) setSelBarW((cur) => (Math.abs(cur - w) < 0.5 ? cur : w));
  }, [sel, selBarW, boxWidth]);
  // 选区 → ref（缩放/平移的回调要读它，state 在闭包里会过期）
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);
  // 聚光区间 → ref（同上：走带 `toggle` 与键盘处理器要读它当播放边界）
  useEffect(() => {
    focusRef.current = spotlight ?? null;
  }, [spotlight]);
  // 选区 → 父级（转写面板据此高亮落在选区内的句子）。**实时发**：拖拽中随 region-updated 一起更新，
  // 用户边调边界边看转写高亮跟着变。不接该回调时几乎零开销（`?.` 短路）。
  useEffect(() => {
    cbRef.current.onSelectionChange?.(sel);
  }, [sel]);

  // 视图窗口 → ref（事件处理器读它，避免过期闭包）
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /** 窗口相对时间 → **绝对秒**（整段模式恒等） */
  /**
   * 缩放/滚动的**真源在库里**（`zoom(minPxPerSec)` + `setScroll`），这里只镜像它给渲染用。
   *
   * 🔴 为什么不用"窗口模式"（换 peaks + 换 duration 让库只渲染一段）：实测那样**改不了媒体轴** ——
   * `<audio>` 仍是整段文件，`getDuration()/region/seek` 全按整段算，而覆盖层按窗口算 ⇒ 两套坐标系打架
   * （按下 50% 落到 16.98% = 101.9/600；拖选得到"整段 20–60% + 窗口偏移"）。
   * 而 `zoom()` 在 peaks 路径下**可用**（库用 `Decoder.createBuffer(peaks, duration)` 造出 `decodedData`，
   * 页面级实验已证）× `getScroll/setScroll` 也正常 ⇒ 时间轴恒为**绝对**，几何只需要下面这一条式子。
   */
  const boxWidthRef = useRef(0);
  const zoomRef = useRef(0);   // minPxPerSec：每像素多少秒的倒数
  const scrollRef = useRef(0); // 容器滚动位置（px，绝对轴上的偏移）
  /** 绝对秒 → **屏幕像素**：`t × minPxPerSec − scroll`（所有覆盖层都用它，不再有第二套几何） */
  const pxOf = useCallback((t: number) => t * (zoomRef.current || 0) - scrollRef.current, []);
  /** 同式的百分比版（覆盖层用百分比定位；容器宽为 0 时返回 0 而不是 Infinity） */
  const pctOf = useCallback((t: number) => (pxOf(t) / (boxWidthRef.current || 1)) * 100, [pxOf]);
  /** 绝对轴下"窗口相对"就是它自己：保留这两个名字只为不动几十处调用点（值恒等） */
  const toAbs = useCallback((t: number) => t, []);
  const toWin = useCallback((t: number) => t, []);

  /** 内联标签的 DOM 引用（用于实测宽度做碰撞判定） */
  const labelRefs = useRef<Array<HTMLDivElement | null>>([]);
  // 容器宽 → ref（几何要用；宽度的 state 版见 boxWidth）
  useEffect(() => {
    boxWidthRef.current = boxWidth;
  }, [boxWidth]);
  /** 刻度标签的**实测宽度**（换字号档后标签会变宽，估算会偏小 ⇒ 必须实测回灌） */
  const [tickLabelPx, setTickLabelPx] = useState(TICK_LABEL_FALLBACK_PX);
  const firstTickRef = useRef<HTMLSpanElement | null>(null);
  /** 正在等模型给片段名（`✦` 置灰用） */
  const [naming, setNaming] = useState(false);

  /**
   * 拆出预计算波形（父级可能每轮渲染都新建 `precomputed` 对象，直接把它当依赖会让波形
   * 反复重建 —— 这里依赖的是它**内部的两个值**，与父级对象身份解耦）。
   */
  const wavePeaks = precomputed?.peaks;
  const waveDuration = precomputed?.duration;

  // 建/拆波形：srcUrl（或预计算波形）变则整只重来 —— 换了 URL 就是另一段音频
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !srcUrl) return;
    clipRegionRef.current = null;
    playUntilRef.current = null;
    setPlaying(false);
    setNow(0);
    setDuration(0);
    setSel(null);
    setFailed(false);
    setDraft(null);
    setEditing(null);
    setClipDraft(null);

    const regions = RegionsPlugin.create();
    // 用户拖选/拖动选区也算"主动定位"：切窗的恢复不得覆盖它
    regions.on('region-updated', () => {
      seekSeqRef.current += 1;
    });
    const ws = WaveSurfer.create({
      container: box,
      url: srcUrl,
      // 有预计算峰值：波形直接画、不 fetch 也不 decode（见文件头）。peaks 需为「通道数组」，故包一层。
      // 只给 peaks 不给 duration 无效（构造时要求二者同时成立），故两个必须一起给。
      ...(wavePeaks && waveDuration ? { peaks: [wavePeaks], duration: waveDuration } : {}),
      height: 64,
      // 波形是这屏的**主角**：专用 token（ink 55% ⇒ 对波形底 3.83:1）。
      // 曾经借用 `--line-soft`（边框色、ink 28% ⇒ 只有 1.83:1），实测低于非文本图形 3:1 下限，
      // 整屏看着像"空盒子 + 一堆小灰字"（见 音频编辑器视觉优化方案_20261011.md §1.1）。
      waveColor: cssVar('--wave-bar', 'rgba(23,23,23,0.55)'),
      progressColor: cssVar('--primary-strong', '#3c2eca'),
      cursorColor: cssVar('--primary-strong', '#3c2eca'),
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    // 拖拽选取片段；一次只留一个选区。drag:true ⇒ 选区可**整体平移**（不只拖两端）
    regions.enableDragSelection({ color: 'rgba(75,63,227,0.16)', drag: true, resize: true, minLength: MIN_SEL });
    /**
     * **把拖拽的"锚端"钉在按下那一刻**（本轮核心）。
     *
     * 为什么需要：选区插件按**指针裸坐标**算端点（自带 3px 阈值，不认打点/播放头），
     * 所以"看起来吸附住了"但拖出来的起点仍会偏几像素。这里在每次 region 更新后，
     * 把**离锚更近的那一端**改成锚点：
     *   · 往右拖（锚在左）⇒ `start` 锁锚点，`end` 跟鼠标；
     *   · 往左拖（锚在右）⇒ `end` 锁锚点，`start` 跟鼠标。
     * 方向随意、**锚定端永远精确等于"打点/播放头/刻度"的那一刻**。
     * 幂等守卫：只在与目标差 > 1ms 时才写回，避免 `setOptions` → `region-updated` 自激循环。
     */
    const pinAnchor = (r: Region) => {
      const anchor = pressAnchorRef.current;
      if (anchor == null || r !== clipRegionRef.current) return;
      // 方向判定抽到纯函数（`anchorSelectionEdge`）：往左拖要钉 end、往右拖要钉 start，
      // 这是本轮最容易写反的地方，放在 `mark-ops.ts` 里用单测钉死；幂等守卫也在那里。
      const fix = anchorSelectionEdge({ start: r.start, end: r.end }, anchor, MIN_SEL);
      if (fix) {
        setPinCount((n) => n + 1);
        r.setOptions(fix.edge === 'start' ? { start: fix.value } : { end: fix.value });
      }
    };
    /**
     * **把"被拖那端"吸附到打点线/刻度**（2026-10-12，用户要求"在两个打点之间拖拽，接近时自动吸附收尾点的线"）。
     *
     * 之前只有**锚端**会吸（按下那一刻），被拖那端是"指针裸坐标 + 插件 3px 阈值" ⇒ 想"从打点到打点"
     * 切一段，终点总差几像素。现在两端同口径：都走 `snapTime`（`snapToRefs`：打点 > 播放头（暂停时）> 刻度，
     * 半径按**像素** 6px 折算）⇒ 拖到打点竖线附近时选区边会**直接粘在那条线上**，松手即精确落点。
     *
     * 三个细节：
     *   · 只有**真拖拽**（`pressAnchorRef` 非空）才吸 —— 代码创建的选区（转写面板按句截取）不该被改写；
     *   · 夹住 `MIN_SEL`：吸附不许把选区压成 0 宽（零宽在插件里等于取消选择）；
     *   · 差 < 1ms 就不写回（幂等守卫）：否则 `setOptions` → `region-updated` 自激。
     */
    const snapMovingEdge = (r: Region) => {
      const anchor = pressAnchorRef.current;
      if (anchor == null || r !== clipRegionRef.current) return;
      const movingIsEnd = Math.abs(r.start - anchor) <= Math.abs(r.end - anchor); // 锚在 start ⇒ 被拖的是 end
      const cur = movingIsEnd ? r.end : r.start;
      const snapped = snapTimeRef.current(cur).t;
      if (Math.abs(snapped - cur) < 0.001) return;
      if (movingIsEnd) r.setOptions({ end: Math.max(snapped, r.start + MIN_SEL) });
      else r.setOptions({ start: Math.min(snapped, r.end - MIN_SEL) });
    };
    regions.on('region-created', (r) => {
      if (r.start === r.end) {
        r.remove(); // 空白处单击（零宽）不算选区
        return;
      }
      if (clipRegionRef.current && clipRegionRef.current !== r) clipRegionRef.current.remove();
      clipRegionRef.current = r; // ⚠️ 必须**先认领**再钉锚：pinAnchor 里有 `r !== clipRegionRef.current` 的守卫
      pinAnchor(r);
      snapMovingEdge(r);
      // region 的时间是**窗口相对**的 ⇒ sel 统一存绝对秒（下游的输入框/导出/吸附都是绝对口径）
      setSel({ start: toAbs(r.start), end: toAbs(r.end) });
      suppressClickUntilRef.current = Date.now() + 300;
    });
    regions.on('region-updated', (r) => {
      if (r !== clipRegionRef.current) return;
      pinAnchor(r);
      snapMovingEdge(r);
      setSel({ start: r.start, end: r.end });
    });
    regions.on('region-removed', (r) => {
      if (r !== clipRegionRef.current) return;
      clipRegionRef.current = null;
      setSel(null);
    });

    // 库的缩放/滚动是**真源**：订阅它并把可见窗口镜像回 React（刻度/标签/探针都靠它重渲染）
    ws.on('zoom', () => syncViewRef.current());
    ws.on('scroll', () => syncViewRef.current());
    ws.on('ready', (d) => {
      totalSecRef.current = d;
      setDuration(d);
      // 倍速：实例建好后补设（切换源音频/片段重挂时，沿用上次选定的倍速）
      try {
        ws.setPlaybackRate(rateRef.current);
      } catch {
        /* 后端不支持就保持 1× */
      }
      cbRef.current.onReady?.(d);
      // ⚠️ `ready` **不止发一次**：`ensureFinePeaks()` 换细分辨率时会 `load()` 一次，又一次 ready。
      // 若每次都做"整段适配"，就会把用户当前的缩放/滚动打回原形（实测：第二个滚轮事件拿到的 zoomRef 还是初始值）。
      if (fittedRef.current) return;
      fittedRef.current = true;
      // 初始 = **整段适配**（minPxPerSec = 容器宽 / 时长）⇒ 与"整段铺满"的观感一致
      const w = boxWidthRef.current || boxRef.current?.getBoundingClientRect().width || 0;
      if (w > 0) {
        zoomRef.current = w / d;
        setZoomPx(w / d);
        try {
          ws.zoom(w / d);
        } catch {
          /* 库拒绝（无 decodedData）⇒ 保持默认缩放 */
        }
        ws.setScroll(0);
        syncViewRef.current();
      }
    });
    ws.on('timeupdate', (t) => {
      // WaveSurfer 的时间是"当前加载的那一段"的**相对**时间 ⇒ 一律翻译成绝对秒再往外发
      const abs = toAbs(t);
      nowRef.current = abs;
      setNow(abs);
      cbRef.current.onTimeUpdate?.(abs);
      // 跟随播放头：只在"要出画"时滚一下（比每帧居中安静，也不跟用户手动滚动打架）
      const w = boxWidthRef.current || 0;
      const mpps = zoomRef.current || 0;
      if (followRef.current && ws.isPlaying() && w > 0 && mpps > 0) {
        const px = abs * mpps - ws.getScroll();
        if (px < w * 0.15 || px > w * 0.85) {
          ws.setScroll(Math.max(0, abs * mpps - w / 2));
          syncViewFromLib();
        }
      }
      // 试听选区：播到选中终点自动停（只停这一档，不干扰普通播放）
      const until = playUntilRef.current;
      if (until != null && t >= until) {
        playUntilRef.current = null;
        ws.pause();
      }
      /**
       * 停在每个打点（开关，见 `stopAtMarks` 的注释）：只在**连续推进**时判，
       * 且"跨过"的定义是 `prev < markT <= abs` —— 正好落在打点上也算，差 1e-6 的浮点噪声不算。
       */
      {
        const prev = markStopPrevRef.current;
        const advancing = !prev.skip && abs > prev.t && abs - prev.t < 2;
        if (stopAtMarksRef.current && advancing && ws.isPlaying() && playUntilRef.current == null) {
          const crossed = marksRef.current.find((m) => m.t > prev.t + 1e-6 && m.t <= abs + 1e-6);
          if (crossed) ws.pause();
        }
        prev.t = abs;
        prev.skip = false;
      }
    });
    ws.on('play', () => setPlaying(true));
    ws.on('pause', () => {
      playUntilRef.current = null;
      setPlaying(false);
      // 播放中被挂起的"换细分辨率"在这里补跑：此刻换渲染层不会打断任何播放（见 ensureFinePeaks）
      if (finePendingRef.current) {
        finePendingRef.current = false;
        ensureFinePeaksRef.current();
      }
    });
    ws.on('finish', () => {
      playUntilRef.current = null;
      setPlaying(false);
      if (finePendingRef.current) {
        finePendingRef.current = false;
        ensureFinePeaksRef.current();
      }
    });
    ws.on('error', () => setFailed(true));
    // 点击波形空白处 = 退出选区（拖拽刚结束的那次 click 已在时间窗内被抑制）
    ws.on('click', () => {
      if (Date.now() < suppressClickUntilRef.current) return;
      clipRegionRef.current?.remove();
    });

    return () => {
      regionsRef.current = null;
      wsRef.current = null;
      clipRegionRef.current = null;
      try {
        void ws.destroy();
      } catch {
        /* 销毁失败不影响卸载 */
      }
    };
    // syncViewFromLib 不列在依赖里：它经 syncViewRef 转发（见其声明处），列上会让每次缩放都重建 WaveSurfer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcUrl, wavePeaks, waveDuration, setView, toAbs]);



  // 波形宽度 → 刻度标签个数（面板可缩放，必须跟着变）
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setBoxWidth((cur) => (Math.abs(cur - w) < 0.5 ? cur : w));
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [srcUrl]);

  // 刻度标签实测宽度：文本恒为 8 字符 ⇒ 与"个数"无关，量到即稳定（不会来回抖）。
  // 依赖里带 `tickLabelPx`：改完值再量一次、相等即停 —— 刻意让它有收敛点，避免无限链。
  useEffect(() => {
    const el = firstTickRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w > 0) setTickLabelPx((cur) => (Math.abs(cur - w) < 0.5 ? cur : w));
  }, [duration, boxWidth, tickLabelPx]);

  // 选区浮条宽度：只在有选区时量得到；夹取要用它，故量到即存
  



  // 打点变化 → 同步给回调用的 ref（圆点层由 marks/duration 直接派生，无需重画）
  useEffect(() => {
    marksRef.current = marks;
  }, [marks]);

  /**
   * **名字的翻转与分行判定**（全部实测，不猜宽度）：渲染后量每个名字的**自然宽度**，然后
   *   ① 逐条决定**是否需要翻到锚点左侧**（`锚点 + 宽度 > 带宽` ⇒ 会伸出右缘 ⇒ 翻转）；
   *   ② 按优先级把每条名字放进**第一个放得下的行**（`MARK_LABEL_MAX_LANES` 行都放不下的才藏）。
   *
   * 四个设计点（每条都有实测教训）：
   *   - 🔴 **翻转必须数据驱动**：曾用"锚点在 70% 之后就算翻转"的固定阈值 —— 实测 70.8% 处右侧
   *     还有 109px 本不该翻，翻过去后与左边的名字相撞，**连带把中间那个名字挤没了**
   *     （一个错误的翻转会隐藏别人，这是"阈值型判定"最典型的连带伤害）；
   *   - 🔴 **碰撞换行、不藏名**（十轮修）：藏名的直接后果是"后打的点把先打的名字顶掉"
   *     —— 用户就是这么丢的（见 `MARK_LABEL_MIN_GAP_PX` 的注释）。分行只吃**垂直空间**，
   *     不动带宽/带高 ⇒ 名字之间不再互相消灭；
   *   - **优先级**：正在编辑的 → **有批注的**（没批注的标签只是一个时刻，与刻度重复）→ 时间倒序
   *     （用户边听边打点，最新那个最需要看见，故它排在有名字的老点之前）；
   *   - 用 `visibility:hidden` 而不是 `display:none`：后者下一轮就量不到宽度，判定会退化成"全隐藏"。
   */
  useEffect(() => {
    if (duration <= 0 || marks.length === 0 || !(boxWidth > 0)) {
      if (hiddenLabels.size > 0 && marks.length === 0) setHiddenLabels(new Set());
      if (labelLanes.size > 0 && marks.length === 0) setLabelLanes(new Map());
      return;
    }
    const order = marks
      .map((_, i) => i)
      .sort((a, b) => {
        const pa = editing?.i === a ? 0 : 1;
        const pb = editing?.i === b ? 0 : 1;
        if (pa !== pb) return pa - pb;
        const na = marks[a].label ? 0 : 1;
        const nb = marks[b].label ? 0 : 1;
        if (na !== nb) return na - nb;
        return b - a; // 新的优先
      });
    const boxes: Array<{ left: number; right: number } | null> = marks.map(() => null);
    const flipNext = new Set<number>();
    for (const i of order) {
      const el = labelRefs.current[i];
      if (!el) continue;
      // 隐藏态也要能量（visibility:hidden 保留布局盒）；transform 不影响宽度 ⇒ 量到的是自然宽
      const w = el.getBoundingClientRect().width;
      const anchor = (pctOf(marks[i].t) / 100) * boxWidth;
      const flip = anchor + w > boxWidth - 2;
      if (flip) flipNext.add(i);
      boxes[i] = flip ? { left: anchor - w, right: anchor } : { left: anchor, right: anchor + w };
    }
    // 装箱是纯函数（`lib/audio/mark-ops.ts`，有单测）：这里只负责"量宽度 + 交给它排"
    const { lanes: nextLanes, hidden: nextHidden } = packMarkLabels({
      boxes,
      order,
      maxLanes: MARK_LABEL_MAX_LANES,
      minGapPx: MARK_LABEL_MIN_GAP_PX,
    });
    setFlippedLabels((cur) => (sameIndexSet(cur, flipNext) ? cur : flipNext));
    setHiddenLabels((cur) => (sameIndexSet(cur, nextHidden) ? cur : nextHidden));
    setLabelLanes((cur) => (sameIndexMap(cur, nextLanes) ? cur : nextLanes));
  }, [
    marks,
    duration,
    boxWidth,
    editing?.i,
    hiddenLabels.size,
    flippedLabels.size,
    labelLanes.size,
    pctOf,
    /*
      🔴 缩放/平移必须进依赖（2026-10-18 修"音轨放大时打点溢出边框"的连带项）：
      `pctOf` 读的是 `zoomRef`/`scrollRef`/`boxWidthRef` 三个 ref，进依赖起不到触发作用
      ⇒ 加这两个 state 才能在窗口变化后**重新实测**。
      不重算的后果：翻转（`flippedLabels`）与藏名（`hiddenLabels`）还停留在**旧窗口**的判断上 ——
      一个靠右缘的名字翻到锚点左侧、缩放后锚点跑到左缘，名字就会甩到带外（同样是"溢出边框"）；
      被藏的名字也仍按旧窗口保持隐藏。窗口外的点已由渲染层过滤，不会参与这次装箱。
      代价：跟随播放头时每帧量一次可见名字的宽度（自动打点不出名字 ⇒ 实际条数很少），可接受。
    */
    zoomPx,
    scrollPx,
  ]);

  /** 跟随播放头（缩放后长音频不跟随就会"一播就出画"；默认开） */
  const followRef = useRef(true);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  /**
   * **停在每个打点**（2026-10-12，用户选的优化 A）：开着时播放遇到下一个打点就暂停。
   *
   * 为什么做成一枚**开关**而不是"播到下一个打点"的一次性按钮：两者是同一件事的两个用法 ——
   * 点圆点跳到某处（或 `[`/`]` 跳）后按播放，开关开着就自动停在下一个打点，正是"逐点复核"的节奏；
   * 不开则一路播下去（原行为）。一个开关覆盖两种用法，不额外占行、也不用记住两条快捷键。
   * ⚠️ 只在**连续推进**时触发（`t` 比上一帧大、且步长 < 2s）：拖动播放头/跳转会一次跨好几个打点，
   *    那种情况不该"啪"地停住。
   */
  const [stopAtMarks, setStopAtMarks] = useState(false);
  /** 上一帧的播放时刻（判"跨过打点"用；跳转会把 skip 置位 ⇒ 不会把跳转误判成"连续推进"） */
  const markStopPrevRef = useRef<{ t: number; skip: boolean }>({ t: 0, skip: true });
  useEffect(() => {
    stopAtMarksRef.current = stopAtMarks;
  }, [stopAtMarks]);

  /** 缩放是否可用：只有走 peaks 路径（大文件）才有可缩放的峰值数据 */
  const zoomable = !!precomputed && duration > 0;
  /** 最小窗口（秒）→ 允许的最大 minPxPerSec */
  const maxZoomPx = useCallback(() => boxWidthRef.current / VIEW_MIN_SEC, []);

  /**
   * 把**视图状态**报给父级（标题栏那组缩放控件的可用性/读数全由它驱动）。
   * 与 `onAddMark` 等一样走 `cbRef`：父级重渲染不该重建波形（见 cbRef 声明处的说明）。
   */
  useEffect(() => {
    cbRef.current.onViewChange?.({ zoomable, view, loading: viewLoading, follow });
  }, [zoomable, view, viewLoading, follow]);

  /** 把库的缩放/滚动**镜像回 React**（刻度、标签、探针锚点都靠它重渲染） */
  const syncViewFromLib = useCallback(() => {
    const ws = wsRef.current;
    const w = boxWidthRef.current;
    if (!ws || !(w > 0)) return;
    const total = ws.getDuration() || 0;
    const mpps = zoomRef.current || 0;
    if (!(total > 0) || !(mpps > 0)) return;
    const px = ws.getScroll();
    setScrollSync(px);
    // 窗口直接由**库的滚动值**算（不用 state/ref 的镜像值：它们要等一次渲染才同步）
    const win = { start: px / mpps, sec: Math.min(total, w / mpps) };
    setView(win.sec >= total - 0.05 ? null : win);
  }, [setScrollSync]);

  // 把最新的 syncViewFromLib 交给建库 effect 里的订阅用（ref 转发，见其声明处的说明）
  useEffect(() => {
    syncViewRef.current = syncViewFromLib;
  }, [syncViewFromLib]);

  /** 整段适配：minPxPerSec = 容器宽 / 总时长，并滚回 0（这也是初始状态） */
  const fitAll = useCallback(() => {
    const ws = wsRef.current;
    const w = boxWidthRef.current || 0;
    const total = ws?.getDuration() || 0;
    if (!ws || !(w > 0) || !(total > 0)) return;
    try {
      ws.zoom(w / total);
    } catch {
      return; // 库拒绝缩放（无 decodedData）⇒ 保持原样，不抛
    }
    zoomRef.current = w / total;
    setZoomPx(w / total);
    ws.setScroll(0);
    setScrollSync(0);
    syncViewFromLib();
  }, [setScrollSync, syncViewFromLib]);

  /**
   * 以某个**绝对时刻**为锚点缩放：锚点在屏幕上的像素位置保持不变。
   * ⚠️ 只改 `minPxPerSec` 会让内容以左边缘为基准伸缩 ⇒ "越缩越跑"，这是最容易做错的地方。
   */
  const zoomAt = useCallback(
    (anchorAbs: number, factor: number) => {
      const ws = wsRef.current;
      const w = boxWidthRef.current || 0;
      if (!ws || !(w > 0)) return;
      const total = ws.getDuration() || 1;
      const cur = zoomRef.current || w / total;
      const target = Math.min(Math.max(cur * factor, w / total), maxZoomPx());
      const anchorPx = anchorAbs * cur - ws.getScroll(); // 锚点当前在屏幕上的位置
      // 放大要清晰 ⇒ 按需换细分辨率（**按钮与滚轮共用这里**，否则"用按钮放大"永远只有粗桶波形）。
      // 它会自己判断：播放中只挂起、已就位/加载中直接返回（见 ensureFinePeaks）。
      ensureFinePeaksRef.current();
      try {
        ws.zoom(target);
      } catch {
        return;
      }
      zoomRef.current = target; // 立即更新 ref：同一帧内后续几何要用新值
      setZoomPx(target);
      const nextScroll = Math.max(0, anchorAbs * target - anchorPx);
      ws.setScroll(nextScroll);
      setScrollSync(nextScroll);
      syncViewFromLib();
    },
    [maxZoomPx, setScrollSync, syncViewFromLib],
  );

  /**
   * 缩放的**锚点**（绝对秒）：当前可见窗口中点；整段视图时取 `0.5 × 总时长`。
   * 按钮（标题栏那组）与组件内原来的按钮都用它 ⇒ 两处手感一致。
   */
  const zoomAnchorAbs = useCallback(
    () => (viewRef.current ? viewRef.current.start + viewRef.current.sec / 2 : (totalSecRef.current || 0) / 2),
    [],
  );

  /**
   * 缩放到**区间**（区间铺满视图 + 两侧 5% 余量）。
   *
   * 选区（`zoomToSelection`）与"下轨选中的片段"（句柄 `zoomToRange`）共用这一段：
   * 两者要的观感是同一个 —— 让这段内容铺满一屏宽。
   */
  const zoomToRange = useCallback(
    (r: { start: number; end: number }) => {
      const ws = wsRef.current;
      const w = boxWidthRef.current || 0;
      if (!ws || !(w > 0)) return;
      const pad = Math.max(0.2, (r.end - r.start) * 0.05);
      const start = Math.max(0, r.start - pad);
      const span = Math.max(VIEW_MIN_SEC, r.end + pad - start);
      const mpps = w / span;
      try {
        ws.zoom(mpps);
      } catch {
        return;
      }
      zoomRef.current = mpps;
      setZoomPx(mpps);
      ws.setScroll(start * mpps);
      setScrollSync(start * mpps);
      syncViewFromLib();
    },
    [setScrollSync, syncViewFromLib],
  );

  /** 缩放到选区：区间从 `selRef` 取（选区归本组件所有，命令口在句柄上） */
  const zoomToSelection = useCallback(() => {
    const s = selRef.current;
    if (s) zoomToRange(s);
  }, [zoomToRange]);

  /** 平移（按容器宽的比例）；越界由库夹住 */
  const panBy = useCallback(
    (ratio: number) => {
      const ws = wsRef.current;
      const w = boxWidthRef.current || 0;
      if (!ws || !(w > 0)) return;
      const next = ws.getScroll() + w * ratio;
      ws.setScroll(next);
      setScrollSync(ws.getScroll()); // 库会夹取越界值 ⇒ 读回来
      syncViewFromLib();
    },
    [setScrollSync, syncViewFromLib],
  );

  /** 把某个绝对时刻滚到可见处（`centre` 时居中）；已经看得见就不滚，避免无谓跳动 */
  const scrollToTime = useCallback(
    (t: number, centre = true) => {
      const ws = wsRef.current;
      const w = boxWidthRef.current || 0;
      const mpps = zoomRef.current || 0;
      if (!ws || !(w > 0) || !(mpps > 0)) return;
      const px = t * mpps - ws.getScroll();
      if (centre ? px >= w * 0.1 && px <= w * 0.9 : px >= 0 && px <= w) return;
      ws.setScroll(Math.max(0, t * mpps - w / 2));
      setScrollSync(ws.getScroll());
      syncViewFromLib();
    },
    [setScrollSync, syncViewFromLib],
  );

  /**
   * **首次缩放时按需拉一次细分辨率**（`points = 时长 × 50Hz`），再用
   * `load(url, [fine], 媒体自带时长)` 替换库内部的 `decodedData`。
   *
   * 为什么必须：库是从**我们喂的 peaks** 造渲染数据的，粗桶只有 2000 个点
   * （3401s ⇒ 1.7s/点），放大到 20s 窗口只剩 12 个点 ⇒ 波形变成十来根粗柱。
   * 细分辨率是 20ms/桶（服务端从**已算出的 10ms 微桶**合并，零额外解码成本，≈160KB/小时）。
   * ⚠️ `duration` 传**媒体自己的时长** ⇒ 时间轴仍为绝对，不产生第二套坐标系。
   */
  const ensureFinePeaks = useCallback(async () => {
    const ws = wsRef.current;
    const req = reqPeaksRef.current;
    const total = ws?.getDuration() || 0;
    if (!ws || !req || fineLoadingRef.current || fineDoneRef.current || !(total > 0)) return;
    /**
     * 🔴 **播放中绝不换渲染层**（2026-10-12 修：用户反馈"时间线放大或缩小后就无法播放及操作了"）。
     *
     * `ws.load()` 会把媒体元素/渲染层整个重建：**位置回到 0、正在播的音频直接停住**，
     * 而且**不发 `pause` 事件** —— 于是 UI 停在"正在播放"（播放键显示 Pause）、实际一点声音都没有。
     * 用户看到的就是"放大之后不能播了"：点播放键第一次只是把假的播放态关掉，第二下才真的播。
     *
     * 处理：播放中只**挂起**（`finePendingRef`），等下一次 `pause`/`finish` 再换 ——
     * 那时换渲染层不打断任何播放。下面还额外做了"位置 + 播放态"的兜底恢复（暂停时缩放也会复位位置）。
     */
    if (ws.isPlaying()) {
      finePendingRef.current = true;
      return;
    }
    const reqId = ++viewReqIdRef.current;
    fineLoadingRef.current = true;
    setViewLoading(true);
    try {
      const points = Math.min(200000, Math.max(2000, Math.round(total * 50)));
      const peaks = await req(0, total, points);
      if (reqId !== viewReqIdRef.current || !peaks || peaks.length === 0) return;
      setFinePx(peaks.length);
      fineDoneRef.current = true;
      // ⚠️ `load()` 会重建渲染层 ⇒ 缩放、滚动、**播放位置**全被重置。
      // keep 值必须在**调用 load 的前一刻**取：拉细分辨率的请求要几百毫秒到 1 秒，
      // 期间用户很可能又滚了几格 —— 取早了的旧值会在加载完成时把用户的新视图"倒回去"（实测漂 47s）。
      const keepZoom = zoomRef.current;
      const keepScroll = scrollRef.current;
      const keepTime = ws.getCurrentTime();
      const wasPlaying = ws.isPlaying();
      await ws.load(srcUrl, [peaks], total);
      // 位置先还回去（load 之后是 0）：读数、打点吸附、刻度都读这个值
      if (keepTime > 0) {
        try {
          ws.setTime(keepTime);
        } catch {
          /* 库拒绝就保持 0 */
        }
        nowRef.current = keepTime;
        setNow(keepTime);
      }
      if (keepZoom > 0) {
        try {
          ws.zoom(keepZoom);
        } catch {
          /* 保持默认 */
        }
        zoomRef.current = keepZoom; // 必须回写 ref：ready 处理器不会动它，但 load 之后库的缩放已是默认值
        setZoomPx(keepZoom);
        ws.setScroll(keepScroll);
        setScrollSync(ws.getScroll());
      }
      syncViewFromLib();
      // 播放态兜底：理论上播放中不会走到这里（上面已挂起），但"按下的瞬间正好在播"这类竞态要能自愈
      if (wasPlaying) {
        try {
          await ws.play();
        } catch {
          setPlaying(false); // 被浏览器拦下就如实显示成暂停，不留"假播放态"
        }
      }
    } catch {
      /* 拿不到细分辨率 ⇒ 就用粗桶缩放（偏糊但不报错） */
    } finally {
      if (reqId === viewReqIdRef.current) setViewLoading(false);
      fineLoadingRef.current = false;
    }
  }, [srcUrl, setScrollSync, syncViewFromLib]);

  // pause/finish 里补跑"挂起的换细分辨率"要用最新那份实现（ref 转发，与 syncViewRef 同款）
  useEffect(() => {
    ensureFinePeaksRef.current = () => void ensureFinePeaks();
  }, [ensureFinePeaks]);

  /**
   * **滚轮 = 以指针所指时刻为锚点缩放**（锚点不动才符合直觉）；`shift + 滚轮` = 平移。
   *
   * ⚠️ 必须用**原生监听 + `{ passive: false }`**：React 的 `onWheel` 挂在 passive 监听上，
   * `preventDefault()` 会被浏览器忽略 ⇒ 缩放的同时整页在滚。
   * ⚠️ `deltaMode` 在触控板/鼠标下不同（像素/行/页），统一折算并夹住单次步进。
   */
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!zoomable) return;
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      const dy = Math.max(-120, Math.min(120, e.deltaY * unit));
      if (e.shiftKey) {
        panBy(Math.max(-0.5, Math.min(0.5, (dy / 120) * 0.5)));
        return;
      }
      const anchor = Math.max(0, (e.clientX - rect.left + scrollRef.current) / (zoomRef.current || 1));
      // 细分辨率由 `zoomAt` 内部按需触发（按钮与滚轮同一条路，见那里的注释）
      zoomAt(anchor, Math.exp(-dy * 0.0015));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [zoomable, panBy, zoomAt]);


  

  /** 退出选区：移除 region（region-removed 处理器会把 sel 置空） */
  const clearSelection = useCallback(() => {
    clipRegionRef.current?.remove();
  }, []);

  /**
   * **定位到某个绝对秒**（组件内唯一的定位实现：句柄 `seek`、`←`/`→` 的 ±3 秒都走它）。
   *
   * 四件事必须一起做，缺一件就会"看着定位了、其实没定住"：
   *   - `clampSeekTime` 夹到 `[0, 总时长]`：到头/到尾就停住，绝不把越界值交给库；
   *   - `seekSeqRef += 1`：宣告"用户主动定位"—— 否则播放中推进来的旧时刻会把刚设的值覆盖回去；
   *   - `scrollToTime`：缩放后目标点常在可见窗口外，不滚过去就是"按了没反应"；
   *   - `setNow`：读数不等 `timeupdate` 回调（那会慢半拍，看起来像没反应）。
   */
  const seekTo = useCallback(
    (t: number) => {
      const ws = wsRef.current;
      if (!ws) return;
      const v = clampSeekTime(t, totalSecRef.current || 0);
      seekSeqRef.current += 1;
      // 跳转会一次跨过若干打点 ⇒ 置 skip，"停在每个打点"不该把跳转当成播放推进（见 markStopPrevRef）
      markStopPrevRef.current = { t: v, skip: true };
      ws.setTime(v); // 绝对轴：直接定位（无换算）
      scrollToTime(v); // 不在可见窗口内就滚过去，否则"跳过去了但看不见"
      setNow(v);
    },
    [scrollToTime],
  );

  /**
   * 前进（`delta > 0`）/ 后退（`delta < 0`）N 秒 —— 控制行的 `↺③`/`↻③` 与 `←`/`→` 共用。
   *
   * 基准取**播放器真实当前时刻**（`getCurrentTime()`，与打点同口径）：播放中就是从"此刻"往前跳，
   * 暂停时就是从停住的那一点跳；两端由 `seekTo` 夹住（退到 0、进到尾即停）。
   */
  const nudgeBy = useCallback(
    (delta: number) => {
      const ws = wsRef.current;
      if (!ws) return;
      seekTo(toAbs(ws.getCurrentTime()) + delta);
    },
    [seekTo, toAbs],
  );

  /** 设倍速：记住（模块级）→ 更新 UI → 立刻作用到当前实例（未就绪则等 ready 补设） */
  const applyRate = useCallback((r: number) => {
    rateRef.current = r;
    lastRate = r;
    setRate(r);
    try {
      wsRef.current?.setPlaybackRate(r);
    } catch {
      /* 实例未就绪 */
    }
  }, []);

  /** 点一下换下一档（0.5 → 0.75 → 1 → 1.25 → 1.5 → 2 → 0.5） */
  const cycleRate = useCallback(() => {
    const i = RATE_STEPS.indexOf(rateRef.current);
    applyRate(RATE_STEPS[(i + 1) % RATE_STEPS.length]);
  }, [applyRate]);

  /**
   * clientX → 波形上的落点（**含磁吸**）。悬停投影与按下落点共用它 ⇒ 两处口径必然一致
   * （否则"看到的位置"与"按下去落的位置"会差一点点 —— 正是这类交互最容易出的错）。
   *
   * 四个细节：
   *   - 用 `boxRef`（波形容器）的 rect 换算比例，而不是 shadow DOM 里的 wrapper：
   *     两者同宽同起点，而容器在普通 DOM 里、可稳定取到（shadow 内的元素 `querySelector` 取不到）；
   *   - **磁吸阈值按像素算**（`SNAP_PX`），换算成秒时用 `px / 宽度 × 时长` ⇒
   *     时长一变、面板一窄，手感都一致（写死秒数会"长音频几乎吸不到、短音频到处吸"）；
   *   - `ratio` 由**吸附后的时刻反算** ⇒ 投影线与标签必然落在同一个点上，不会各走各的；
   *   - `duration` 未知（未就绪）时返回 null，调用方什么都不做。
   */

  /** 指针位置的**裸时刻**（不吸附）：拖拽的"被拖那端"要用它 —— 跟手，不吸 */
  const rawTimeAtClientX = useCallback((clientX: number, rect: DOMRect): number | null => {
    const mpps = zoomRef.current || 0;
    if (!(mpps > 0)) return null;
    // 绝对轴：屏幕 x → 内容 x（加回滚动）→ 秒
    return Math.max(0, (clientX - rect.left + scrollRef.current) / mpps);
  }, []);

  /**
   * **松手兜底归位**（window 捕获阶段）。
   *
   * 为什么必须是 window 捕获：选区插件在拖拽时会对 pointer 事件 `preventDefault()/stopPropagation()`，
   * React 挂在波形容器上的 `onPointerUp` **收不到**（实测：锚点算对了、但归位一次都没执行）。
   * 捕获阶段在目标之前、在 shadow DOM 之外先跑，`stopPropagation` 拦不住它。
   * 再用 `setTimeout(0)` 让**插件自己的 pointerup 处理**先完成，然后才读它最终给的选区。
   */
  useEffect(() => {
    const onUpCapture = (e: PointerEvent) => {
      setUpCount((n) => n + 1);
      const anchor = pressAnchorRef.current;
      if (anchor == null) return;
      const clientX = e.clientX; // 松手位置：给"被拖那端"用（setTimeout 里事件对象可能已被回收）
      setTimeout(() => {
        const r = clipRegionRef.current;
        const box = boxRef.current;
        if (r && box) {
          // ⚠️ 这里**不能**只看 `anchorSelectionEdge` 的返回值：拖拽过程中锚端已被钉好时它返回 null
          // （幂等守卫），于是"修正被拖端"会被整体跳过 —— 实测就是这个原因让终点一直留着插件的 +5px 偏差。
          // 故按**方向**直接算两端：指针在锚右侧 ⇒ 起点=锚、终点=松手位置；反之终点=锚、起点=松手位置。
          const rawT = rawTimeAtClientX(clientX, box.getBoundingClientRect());
          // 松手这一刻也要过磁吸（与拖拽过程同一口径）⇒ 落点真的落在打点竖线上，而不是"看着像"
          const pointerT = rawT == null ? null : snapTimeRef.current(rawT).t;
          if (pointerT != null && Math.abs(pointerT - anchor) >= MIN_SEL) {
            if (pointerT >= anchor) {
              r.setOptions({ start: anchor, end: Math.max(pointerT, anchor + MIN_SEL) });
            } else {
              r.setOptions({ start: Math.min(pointerT, anchor - MIN_SEL), end: anchor });
            }
          }
          setSel({ start: r.start, end: r.end });
        }
        pressAnchorRef.current = null; // 只服务于"这次拖拽"，不污染之后由代码创建的选区
      }, 0);
    };
    window.addEventListener('pointerup', onUpCapture, true);
    return () => window.removeEventListener('pointerup', onUpCapture, true);
    // rawTimeAtClientX 是稳定引用（useCallback 空依赖），但"被拖端"要用它 ⇒ 明确列出
  }, [rawTimeAtClientX]);

  /**
   * **绝对秒 → 磁吸后的绝对秒**（磁吸的**唯一实现**，两个消费者共用）：
   *   · `timeAtClientX`：指针位置换算（按下锚点、悬停投影）；
   *   · 拖拽的**被拖那端**（2026-10-12 加，见建库 effect 里的 `snapMovingEdge`）。
   *
   * 目标与半径口径全在 `snapToRefs` 里：优先级 **打点 > 播放头（仅暂停时）> 刻度**；
   * 半径按**像素**（`SNAP_PX`）折算成秒 ⇒ 缩放到哪一级，"粘"的手感都一样
   * （按固定秒数会在长音频里几乎吸不到、短音频里到处吸）。
   */
  const snapTime = useCallback(
    (tAbs: number): { t: number; snapped: SnapKind | null } => {
      const box = boxRef.current;
      const rect = box?.getBoundingClientRect();
      if (!rect || !(rect.width > 0)) return { t: tAbs, snapped: null };
      const win = visibleWindow();
      const span = win.sec;
      if (!(span > 0)) return { t: tAbs, snapped: null };
      // 吸附在**绝对秒域**里做（打点是绝对口径），缩放只影响显示 ⇒ 吸附结果不随缩放漂移
      return snapToRefs(tAbs, {
        marks: marksRef.current.map((m) => m.t),
        // 播放头只在**暂停时**参与：播放中它一直在动，会把指针"拖走"
        playhead: playingRef.current ? null : nowRef.current,
        ticks: tickStopsForWindow(win.start, win.sec, TICK_MAX_LABELS),
        tolSec: (SNAP_PX / rect.width) * span,
      });
    },
    [visibleWindow],
  );

  const timeAtClientX = useCallback(
    (clientX: number): { ratio: number; t: number; snapped: SnapKind | null } | null => {
      const box = boxRef.current;
      if (!box) return null;
      const rect = box.getBoundingClientRect();
      if (!(rect.width > 0)) return null;
      const win = visibleWindow();
      const span = win.sec;
      if (!(span > 0)) return null;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const res = snapTime(win.start + ratio * span);
      return { ratio: (res.t - win.start) / span, t: res.t, snapped: res.snapped };
    },
    [visibleWindow, snapTime],
  );

  // snapTime 交给建库 effect 里的拖拽处理器用（ref 转发，见其声明处的说明）
  useEffect(() => {
    snapTimeRef.current = snapTime;
  }, [snapTime]);

  /** 悬停：更新投影（含吸附）；指针离开波形即清空 */
  const onWavePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const at = timeAtClientX(e.clientX);
      if (!at) return;
      // 值没变就不 setState：pointermove 触发极密，避免无谓重渲染
      setHover((cur) => (cur && cur.ratio === at.ratio && cur.t === at.t ? cur : at));
    },
    [timeAtClientX],
  );
  const onWavePointerLeave = useCallback(() => setHover(null), []);

  /**
   * **按下的位置是否落在已有选区内**（含两端各 6px 的缩放手柄带）。
   *
   * 为什么需要它：选区插件把两端渲染成 `ew-resize` 的拖拽手柄、并允许整体平移，但它**不拦 pointerdown**
   * ⇒ 按下事件会冒泡到波形容器，触发 `seekFromPointer` 把锚点钉在这一刻。于是拖拽收尾的归位
   * （`onUpCapture`）会按"锚点 → 松手点"重写选区，把用户刚调好的大小/位置**整体覆盖** —— 表现为
   * "选区两端根本拖不动"。故：按在选区上 ⇒ 钉锚逻辑整体让路，交给插件处理。
   */
  const pressInSelection = useCallback(
    (clientX: number): boolean => {
      const r = clipRegionRef.current;
      const box = boxRef.current;
      if (!r || !box) return false;
      const x = clientX - box.getBoundingClientRect().left;
      const a = pxOf(r.start); // 绝对轴：选区两端的屏幕像素
      const b = pxOf(r.end);
      const HANDLE_PX = 6; // 与插件 addResizeHandles 的手柄宽度一致
      return x >= Math.min(a, b) - HANDLE_PX && x <= Math.max(a, b) + HANDLE_PX;
    },
    [pxOf],
  );

  /**
   * **按下即落点**：把指针位置（**吸附后**）换算成时刻并立刻 `setTime`。
   *
   * 为什么必须自己做：WaveSurfer 的 seek 挂在 `click`（抬起）上
   * （`wavesurfer.js:231` 的 `clickSignal` 订阅的是 wrapper 的 `click`），
   * 所以"按下那一刻就出现播放条"在原实现里是不成立的。
   * `setNow(t)` 与 `setTime` 同时做：等 `timeupdate` 回调再更新会慢半拍（看起来像没反应）。
   *
   * ⚠️ 例外（见 `pressInSelection`）：按在**已有选区**上时不落点、不钉锚 —— 那是"调整/平移选区"的手势。
   */
  const seekFromPointer = useCallback(
    (clientX: number) => {
      const ws = wsRef.current;
      const at = timeAtClientX(clientX);
      if (!ws || !at) return;
      // 按在选区上 ⇒ 交给选区插件做"改大小 / 整体平移"：这里不钉锚、不跳播放头。
      // 不钉锚是关键 —— 否则 `onUpCapture` 的收尾归位会把用户刚调好的选区覆盖回"锚点→松手点"。
      // 顺带压掉这次 click：选区插件的"点击即清除"否则会把选区一并删掉（误触手柄也会中招）。
      if (pressInSelection(clientX)) {
        pressAnchorRef.current = null;
        suppressClickUntilRef.current = Date.now() + 300;
        return;
      }
      seekSeqRef.current += 1; // 用户主动定位：宣告"别再拿旧时刻覆盖我"
      pressAnchorRef.current = at.t; // 拖拽选区的锚 = 按下这一刻**吸附后**的时刻
      setPressAnchorDbg(at.t);
      ws.setTime(toWin(at.t));
      setNow(at.t);
    },
    [timeAtClientX, toWin, pressInSelection],
  );

  /** 点「Add mark」：冻结当前时刻并展开批注输入框（此刻还不入库，确认后才落点） */
  const addMark = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    setDraft({ t: toAbs(ws.getCurrentTime()), text: '' });
  }, [toAbs]);

  /** 确认新建：带批注入库（批注可空） */
  const commitDraft = useCallback(() => {
    if (!draft) return;
    const label = draft.text.trim();
    cbRef.current.onAddMark?.(draft.t, label || undefined);
    setDraft(null);
  }, [draft]);

  /** 确认改批注：整份回写（清空批注 = 只留时刻） */
  const commitEditing = useCallback(() => {
    if (!editing) return;
    const label = editing.text.trim();
    cbRef.current.onMarksChange?.(
      marksRef.current.map((m, i) => (i === editing.i ? (label ? { ...m, label } : { t: m.t }) : m)),
    );
    setEditing(null);
  }, [editing]);

  /**
   * **改打点的时刻**（2026-10-12，用户选的优化 C）。
   *
   * 为什么需要：打点是靠耳朵按的，落点常差 0.5~2s；在 3h38m 那条录音上你打了 7 个点，
   * 而此前唯一"修正"的办法是删掉重打（位置全丢）。现在就地改：输入 `mm:ss.d` 或纯秒都行。
   *
   * 三条口径：
   *   · 解析失败 ⇒ 什么都不做（回填由 `key` 重挂输入框完成，与选区起止输入同款范式）；
   *   · 夹到 `[0, 总时长]`，并**四舍五入到 0.1s**（与 `addMark` 的落点精度一致）；
   *   · 改完**立刻关闭编辑态**：时刻一变，数组按 t 重排，`editing.i` 可能指向别的点了（下标错位）。
   */
  const applyMarkTime = useCallback((index: number, raw: string) => {
    const parsed = parseTimeInput(raw);
    setEditing(null); // 无论成败都退出编辑态（输入框随重挂回填真值）
    if (parsed == null) return;
    const total = totalSecRef.current || 0;
    const at = Math.round(clampSeekTime(parsed, total) * 10) / 10;
    const next = marksRef.current
      .map((m, i) => (i === index ? { ...m, t: at } : m))
      .sort((a, b) => a.t - b.t);
    cbRef.current.onMarksChange?.(next);
  }, []);

  /**
   * 点 Clip：先展开命名输入框，确认后才真的导出。
   *
   * 默认名优先取**区间内的转写文本**（`suggestClipName`，由父级从 transcript 里截取），
   * 拿不到才回退 `片段 - 标题 - 起止`。这样"截一句话"直接得到一个有意义的文件名，
   * 而不是一串时间戳。
   */
  const openClip = useCallback(() => {
    const r = clipRegionRef.current;
    if (!r) return;
    const suggested = suggestClipName?.(r.start, r.end)?.trim();
    setClipDraft({
      start: r.start,
      end: r.end,
      text: suggested || clipBaseName(clipTitle || 'Audio', r.start, r.end),
    });
  }, [clipTitle, suggestClipName]);

  /**
   * `✦` 让模型给个更好的名字：只在拿到非空结果时**替换草稿**；
   * 失败（null）保持用户手上的草稿不动 —— 输入框绝不能被一次失败的模型调用清空。
   */
  const requestClipName = useCallback(async () => {
    const d = clipDraft;
    if (!d || !onRequestClipName || naming) return;
    setNaming(true);
    try {
      const next = await onRequestClipName(d.start, d.end);
      const name = (next || '').trim();
      if (name) setClipDraft((cur) => (cur ? { ...cur, text: name } : cur));
    } finally {
      setNaming(false);
    }
  }, [clipDraft, onRequestClipName, naming]);

  /** 确认导出：名字留空 → 回退默认名（服务端也会兜）。刻意不绑 onBlur —— 误触发一次导出太贵 */
  const commitClip = useCallback(() => {
    if (!clipDraft) return;
    const { start, end, text } = clipDraft;
    setClipDraft(null);
    cbRef.current.onClip?.(start, end, text.trim() || undefined);
  }, [clipDraft]);

  const removeMark = useCallback((index: number) => {
    cbRef.current.onMarksChange?.(marksRef.current.filter((_, i) => i !== index));
  }, []);

  /**
   * 选区起点/终点设为当前播放时刻（I/O 快捷键）；无选区时以当前时刻为锚建一个 1s 选区。
   *
   * 时刻先过一道 `snapToMark`：用户听到"就是这一句"时按下 I/O，落点常与打点差 0.1~0.3s，
   * 吸附后「从这个打点到那一刻」才切得整齐（阈值 0.3s，见 lib/audio/mark-ops.ts 的 snapToMark）。
   */
  const markBound = useCallback((which: 'start' | 'end') => {
    const ws = wsRef.current;
    const regions = regionsRef.current;
    if (!ws || !regions) return;
    const t = snapToMark(Math.max(0, toAbs(ws.getCurrentTime())), marksRef.current);
    const r = clipRegionRef.current;
    if (!r) {
      const start = which === 'start' ? t : Math.max(0, t - 1);
      const end = which === 'start' ? t + 1 : t;
      if (end - start < MIN_SEL) return;
      clipRegionRef.current = regions.addRegion({
        start,
        end,
        color: 'rgba(75,63,227,0.16)',
        drag: true,
        resize: true,
      });
      setSel({ start, end });
      return;
    }
    if (which === 'start') r.setOptions({ start: Math.max(0, Math.min(t, r.end - MIN_SEL)) });
    else r.setOptions({ end: Math.max(t, r.start + MIN_SEL) });
  }, [toAbs]);

  /** 提交选区起止输入：解析失败回退原值；成功则**吸附到最近打点**后钳到 [0, 时长] 并保证 start < end */
  const applySelBound = useCallback(
    (which: 'start' | 'end', raw: string) => {
      setSelVersion((n) => n + 1); // 无论成败都重挂输入框以回填格式化值
      const r = clipRegionRef.current;
      const parsed = parseTimeInput(raw);
      if (!r || parsed == null) return;
      seekSeqRef.current += 1;
      const v = snapToMark(parsed, marksRef.current); // 手输 12.5 而那里正好有个打点 ⇒ 落到打点上
      const max = duration > 0 ? duration : Number.POSITIVE_INFINITY;
      // r.start/r.end 是**窗口相对**的 ⇒ 先还原成绝对秒再比大小（口径统一在绝对域里做）
      const cur = selRef.current;
      let start = cur ? cur.start : toAbs(r.start);
      let end = cur ? cur.end : toAbs(r.end);
      if (which === 'start') start = Math.max(0, Math.min(v, end - MIN_SEL));
      else end = Math.min(max, Math.max(v, start + MIN_SEL));
      setSel({ start, end });
      r.setOptions({ start, end }); // 绝对轴：region 与 sel 同口径，无需换算
      scrollToTime(start, false);
    },
    [duration, scrollToTime, toAbs],
  );

  /**
   * **逐点跳转**（2026-10-12，用户选的优化 A）：跳到上/下一个打点（`[` / `]`）。
   *
   * 口径：以**当前播放头**为基准，取严格小于（上一个）/ 大于（下一个）的最近一个打点；
   * 到头了就停在原地（不回绕 —— 回绕会在"我到底跳了没"上骗人，这与 `↺③/↻③` 夹住到头的口径一致）。
   * 跳转前先把"跨打点判定"置 skip（`seekTo` 里做）⇒ 开着"停在每个打点"也不会被跳转弄停。
   */
  const jumpMark = useCallback(
    (dir: -1 | 1) => {
      const ws = wsRef.current;
      if (!ws) return;
      const ts = marksRef.current.map((m) => m.t);
      if (ts.length === 0) return;
      const cur = toAbs(ws.getCurrentTime());
      const eps = 0.05; // 已经很贴近某个打点时不重复跳它（连按 = 一个一个往下走）
      const next = dir === 1
        ? ts.find((t) => t > cur + eps)
        : [...ts].reverse().find((t) => t < cur - eps);
      if (next == null) return;
      seekTo(next);
    },
    [seekTo, toAbs],
  );

  /** 试听一段区间：跳到起点播放，播到终点由 timeupdate 自动停 */
  const playRange = useCallback(
    (r: { start: number; end: number }) => {
      const ws = wsRef.current;
      if (!ws) return;
      scrollToTime(r.start); // 区间不在可见窗口内就滚过去
      ws.setTime(r.start); // 绝对轴
      playUntilRef.current = r.end;
      void ws.play();
    },
    [scrollToTime],
  );

  useImperativeHandle(
    ref,
    () => ({
      seek: seekTo,
      getCurrentTime: () => toAbs(wsRef.current?.getCurrentTime() ?? 0),
      play: () => {
        void wsRef.current?.play();
      },
      /** 清掉波形选区（也用于“Play all”前解除播放收束） */
      clearSelection: () => {
        clearSelection();
      },
      /** 只播某一段（下轨选中片段后的显式 `Play excerpt`） */
      playRange: (range: { start: number; end: number }) => {
        playRange(range);
        focusPlayer();
      },
      getSelection: () => {
        const r = clipRegionRef.current;
        return r ? { start: r.start, end: r.end } : null;
      },
      /**
       * 缩放命令（标题栏那组控件）。锚点口径与组件内原来那颗按钮**完全一致**：
       * 以**当前可见窗口的中点**为锚（整段视图时用 0.5×总时长）—— 锚点不动，按一下不会让内容整体跑。
       */
      zoomIn: () => { zoomAt(zoomAnchorAbs(), 1.6); focusPlayer(); },
      zoomOut: () => { zoomAt(zoomAnchorAbs(), 1 / 1.6); focusPlayer(); },
      fitAll: () => { fitAll(); focusPlayer(); },
      panBy: (ratio: number) => { panBy(ratio); focusPlayer(); },
      zoomToSelection: () => { zoomToSelection(); focusPlayer(); },
      zoomToRange: (range: { start: number; end: number }) => { zoomToRange(range); focusPlayer(); },
      setFollow: (on: boolean) => { setFollow(on); focusPlayer(); },
    }),
    [seekTo, toAbs, clearSelection, playRange, zoomAt, fitAll, panBy, zoomToSelection, zoomToRange, zoomAnchorAbs, focusPlayer],
  );



  /**
   * 播放/暂停（走带那颗键 + `Space`）。
   *
   * 2026-10-12（用户要求"截取一段，播放 ⇒ 只播放截取位置"）：**有选区时只播选区**。
   *   ① 正在播 → 暂停（原语义，不变）；
   *   ② 无选区 → 从当前位置播到底（原语义，不变）；
   *   ③ 有选区且播放头在**选区外**（或已经播到终点）→ 跳回选区起点重放；
   *   ④ 有选区且播放头在**选区内** → 从当前位置续播。
   * 终点统一由 `playUntilRef`（timeupdate 里那条）自动停 —— 与浮条上的 `Play range` 共用同一条停止逻辑，
   * 所以"按钮播一遍"和"空格播一遍"行为完全一致（不会长出第二条计时路径）。
   *
   * 2026-10-17：**下轨选中的片段（`spotlight` 区间）也按同一条收束** —— 用户要求"选中节选时，
   *   播放不能超过节选部分"。优先级：选区（手上正圈的那一段）> 聚光（选中的那个片段）；
   *   两者都没有才是原来的"从当前位置播到底"。
   */
  const toggle = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.isPlaying()) {
      void ws.playPause(); // 播放中 = 暂停
      return;
    }
    const bound = selRef.current ?? focusRef.current;
    if (!bound) {
      void ws.playPause();
      return;
    }
    const t = toAbs(ws.getCurrentTime());
    // 在区间内（且没到终点）⇒ 续播；否则（起点之前 / 已到终点）⇒ 从起点重放
    if (t < bound.start || t >= bound.end - 0.01) {
      playRange(bound);
      return;
    }
    playUntilRef.current = bound.end;
    void ws.play();
  }, [playRange, toAbs]);

  /** 键盘快捷键（仅焦点在本组件内生效，避免抢占转录/输入框的按键） */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        toggle();
        return;
      }
      // ←/→ = 后退/前进 N 秒（与控制行那两个按钮同一条路径）。放在 Space 之后、字母键之前：
      // 用 `e.key` 而不是 `toLowerCase()` 判，方向键没有大小写。
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); // 否则会被面板的滚动容器当成"滚动列表"
        // 默认精修 NUDGE_SEC；按住 Shift 走粗调 NUDGE_COARSE_SEC（长录音里快速挪一段）
        const step = e.shiftKey ? NUDGE_COARSE_SEC : NUDGE_SEC;
        nudgeBy(e.key === 'ArrowLeft' ? -step : step);
        return;
      }
      /**
       * `Esc` = 整段适配（缩放行那个窗口读数按钮的 title 一直这么写，但**以前根本没接**）。
       * 只在真的放大过（`view` 非空）时吞键：否则 Esc 该留给上层面板/弹窗。
       * ⚠️ 输入框里的 Esc 到不了这里（上面那行 `INPUT/TEXTAREA` 早退守卫）⇒ 撤销改名不会被抢。
       */
      if (e.key === 'Escape') {
        if (!viewRef.current) return;
        e.preventDefault();
        fitAll();
        return;
      }
      // `[` / `]` = 上一个 / 下一个打点（逐点复核的主动作；见 jumpMark）
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        jumpMark(e.key === '[' ? -1 : 1);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'm') {
        e.preventDefault();
        addMark();
      } else if (k === 'i') {
        e.preventDefault();
        markBound('start');
      } else if (k === 'o') {
        e.preventDefault();
        markBound('end');
      }
    },
    [toggle, addMark, markBound, nudgeBy, fitAll, jumpMark],
  );

  // 波形解码失败：退回原生控件，保住播放能力（打点不可用）
  if (failed) {
    return (
      <div className="flex flex-col gap-1">
        <audio
          src={srcUrl}
          controls
          className="w-full"
          onTimeUpdate={(e) => cbRef.current.onTimeUpdate?.(e.currentTarget.currentTime)}
        />
        <p className="text-10" style={{ color: 'var(--ink-faint)' }}>
          The waveform could not be rendered — playback only.
        </p>
      </div>
    );
  }

  /**
   * **可见窗口内的打点**（下标 + 已算好的百分比）。
   *
   * 为什么必须过滤（2026-10-18 修"音轨放大时打点溢出边框"）：`pctOf` 是按**当前窗口**算的百分比，
   * 缩放/平移后窗口外的点会 <0 / >100 —— 仍按百分比画就会把圆点/名字甩出打点带。而带子**不能**加
   * `overflow-hidden`（悬浮气泡必须溢出到波形上，见渲染处说明）⇒ 它们会直接溢出到轨道卡片/面板之外。
   * 守卫口径与波形上那排打点竖线（`data-role="mark-line"`）一致：留 1% 余量让贴边的点正常露出。
   *
   * 一次算好给**两层共用**（圆点层 + 名字层）：两层的位置天然同源、不会各算一份而漂开；
   * 也让名字层不必再画窗口外的名字 —— 那些点的 `labelRefs[i]` 因此为 null，不进判定 effect 的装箱。
   */
  const visibleMarks = marks
    .map((m, i) => ({ m, i, pct: pctOf(m.t) }))
    .filter(({ pct }) => pct >= -1 && pct <= 101);

  return (
    <div
      ref={rootRef}
      className="flex flex-col gap-1.5 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary-strong)]"
      tabIndex={0}
      onKeyDown={onKeyDown}
      title={`Space: play/pause · ←/→: ±${NUDGE_SEC}s (Shift ±${NUDGE_COARSE_SEC}s) · [ / ]: previous/next mark · M: add mark · I/O: set selection start/end`}
    >
      <div className="relative">
        {/* 打点带（2026-10-11 八轮起 h-3 → h-6）：**圆点 + 名字都在波形上方这一条**。
            为什么把名字从波形上挪到这里：波形是这屏的主角（对比度刚从 1.83:1 提到 3.83:1），
            名字盖在它身上就是在跟主角抢地方；而且名字层与悬停投影标签都在波形顶部、会互相压（实测过）。
            挪到带里之后：波形完整可见、名字有独立的一条、投影标签也不再被压。
            点击=跳转；悬浮=名字 + ✎改 / ✕删 气泡。
            ⚠️ 气泡必须**可用鼠标点**（不是 instrument 的装饰）：名字被碰撞挤掉的点
            （见 `hiddenLabels`）只有这里能改名/删除 —— 否则那些点就变成"改不动的点"。
            故气泡用 `group-hover:flex` + `pointer-events-auto`，并让气泡**骑在圆点上**
            （`bottom-full` 留 4px），鼠标从圆点移到气泡的途中不会掉出 hover 区。 */}
        {/* ⚠️ 2026-10-12 十轮：名字要换行时**由这条带子自己长高**（每多一行 +17px，上限 6 行 = 111px），
            名字层始终只在带内 ⇒ 波形区**永远不被名字覆盖、那里的点按定位也不会被名字截走**
            （覆在波形上会让"哪个名字属于哪个圆点"看不出来 —— 用户原话"点打多了就对不上时间线了"）。
            代价：行数增加时波形与下方内容整体下移 17px（只在**新增了一行**时发生，不是每次打点）。 */}
        {/*
          🔴 带子上的 `z-30` 是**承重**的，不是装饰（2026-10-12 十轮修的一个老缺陷）：
          圆点外层那个 `-translate-x-1/2`（`transform`）会**创建层叠上下文**，于是悬浮气泡里的
          `z-20` 只在那个小盒子里生效 —— 气泡虽然画在圆点下方（覆在波形上），却会被**后面的兄弟**
          `[data-role="wave-wrap"]`（z-index: auto 的定位元素）整个盖住：`elementFromPoint` 命中的是
          波形容器，点 ✕/✎ 实际落到波形上（顺带把播放头跳走）⇒ 用户根本删不掉打点（"打点支持删除吗？"）。
          给带子一个 `z-index` 就把它变成层叠上下文，整棵子树（圆点 + 气泡 + 名字）一起抬到波形之上。
          ⚠️ 别顺手加 `overflow-hidden`：气泡必须能溢出到带外（它挂在圆点下方、覆在波形上）。
        */}
        <div
          className="relative z-30 h-6 w-full"
          data-role="mark-band"
          data-lanes={labelLaneCount}
          style={labelLaneCount > 1 ? { height: `calc(1.5rem + ${(labelLaneCount - 1) * MARK_LABEL_LANE_PITCH_PX}px)` } : undefined}
        >
          {duration > 0 &&
            visibleMarks.map(({ m, i, pct }) => (
              <div
                key={`${m.t}-${i}`}
                className="group absolute bottom-0 -translate-x-1/2"
                style={{ left: `${pct}%` }}
              >
                <button
                  type="button"
                  onClick={() => wsRef.current?.setTime(toWin(m.t))}
                  className="block"
                  data-role="mark-dot"
                  data-mark-index={i}
                  title={m.label || mmss(m.t)}
                  aria-label={m.label || mmss(m.t)}
                >
                  <span
                    className="block h-1.5 w-1.5 rounded-full transition-transform group-hover:scale-125"
                    style={{
                      // AI 落点（Highlights 选中的区间）画成**空心环**、且用**另一个色相**，手打点是实心琥珀：
                      // 原来两类只有"空心/实心"的差别，点小、离远了看不出谁是谁（用户要求"颜色与用户打点区分"）。
                      // 色相与波形上那条 5px 刻痕同源（`--mark-line-ai`）：圆点与它脚下那条线是一件事，
                      // 且必须与播放头/选区的紫色、手打点的琥珀分开（同屏三色相各归各的，见 globals.css）。
                      ...(m.auto
                        ? { backgroundColor: 'transparent', border: '1.5px solid var(--mark-line-ai)' }
                        : { backgroundColor: 'var(--mark-line)' }),
                      // 名字没地方显示的点**加一圈描边**：一眼看出"这点有名字，只是没排下"
                      ...(hiddenLabels.has(i) ? { boxShadow: '0 0 0 2px var(--paper-hover)' } : {}),
                    }}
                  />
                </button>
                <span
                  className="pointer-events-none absolute top-full z-20 mt-0.5 hidden items-center gap-1 rounded px-1.5 py-0.5 text-10 whitespace-nowrap group-hover:flex"
                  style={{
                    backgroundColor: 'var(--panel-bg)',
                    color: 'var(--ink)',
                    border: '1px solid var(--line)',
                    pointerEvents: 'auto',
                    // 气泡挂在圆点**下方**（覆在波形上）：圆点层在轨道最顶端，
                    // 挂上方会伸出组件盒被面板壳 `overflow:hidden` 裁掉。靠右的点把气泡翻到左侧。
                    ...(pctOf(m.t) > 75 ? { right: 0 } : { left: 0 }),
                  }}
                >
                  <span className="max-w-40 truncate">{m.label || mmss(m.t)}</span>
                  <button
                    type="button"
                    onClick={() => setEditing({ i, text: m.label || '' })}
                    className="shrink-0 transition-colors hover:text-[var(--primary-strong)]"
                    title="Edit this mark's name"
                  >
                    <Pencil className="h-2.5 w-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeMark(i)}
                    className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                    title="Remove this mark"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              </div>
            ))}
          {/*
            **打点名字层**（2026-10-11 八轮：从波形挪到打点带内）。
            位置：与底部那一排圆点同 x、且**始终在带内** ⇒ 一眼看出"哪个名字属于哪个点"；
            波形因为这一挪而**完全不被遮挡**（八轮把波形对比度从 1.83:1 提到 3.83:1，就是为了让它当主角）。
            这一层 `pointer-events-none`，只有名字/输入框自己 `pointer-events-auto`
            ⇒ 空白处的悬停与拖拽照旧穿透（**带外的波形也一样**：名字不会出现在那里）。
            同一行放不下的名字由判定 effect **换到上面一行**（`labelLanes`，最多 `MARK_LABEL_MAX_LANES` 行；
            行数增加时打点带自己长高，见上 —— 十轮修的正是"后打的点把先打的名字顶掉"与
            "名字压到波形上、对不上自己的圆点"）；
            只有超出行数上限的才由 `hiddenLabels` 只藏视觉（见 `MARK_LABEL_MIN_GAP_PX`），
            被藏的点仍有圆点 + 悬浮气泡（气泡里有 ✎/✕），功能不丢。
          */}
          {duration > 0 && marks.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
              {visibleMarks.map(({ m, i, pct }) => {
                const isEditing = editing?.i === i;
                /*
                  P2-4：**自动打点默认不显名字**（只有正在编辑的那个例外）。
                  理由：AI 一次能生成 30+ 个点，全显名字时打点带会被它们占满（碰撞逻辑只能靠"藏"，
                  结果是"谁的名字都看不全"）；手打点才是用户真正要反复看的锚点。
                  自动点的名字仍可**悬浮圆点**得到（气泡里有名字 + ✎/✕），功能不丢。
                */
                if (m.auto && !isEditing) return null;
                // pct 由 `visibleMarks` 带来（与带底那排圆点同源，且已保证在可见窗口内）
                // 翻转与否由**实测宽度**决定（见判定 effect），不再用百分比阈值
                const flip = flippedLabels.has(i);
                // 行号同样由判定 effect 给；缺省第 0 行（＝紧贴圆点那一行，首帧、或该点本就不在密集区）
                const lane = labelLanes.get(i) ?? 0;
                return (
                  <div
                    key={`label-${m.t}-${i}`}
                    className="absolute"
                    style={{ left: `${pct}%`, top: labelLaneTop(lane, labelLaneCount) }}
                  >
                    {isEditing && (
                      <div
                        className="pointer-events-auto flex items-center gap-1 rounded px-1 py-0.5"
                        style={{
                          backgroundColor: 'var(--panel-bg)',
                          border: '1px solid var(--primary-strong)',
                          ...(flip ? { transform: 'translateX(-100%)' } : {}),
                        }}
                      >
                        {/*
                          **时刻输入**（优化 C）：`mm:ss.d` 或纯秒；Enter/失焦提交，Esc 取消。
                          用 `defaultValue` + `key`（重挂回填真值）而不是受控 state —— 与"选区起止输入"同款范式：
                          非法输入回退原值无需额外代码，也不会把脏值写进打点。
                          宽度只给 w-14（`00:00.0` 是 7 个字符的定宽等宽字），别把编辑器撑宽。
                        */}
                        <input
                          key={`t-${m.t}-${i}`}
                          defaultValue={mmssPrecise(m.t)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            else if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); }
                          }}
                          onBlur={(e) => {
                            // 焦点移到**同一个编辑器内**的另一个控件（名字输入 / ✕）不算提交 ——
                            // 否则"点一下名字框"会立刻触发时刻提交 ⇒ 编辑器被关掉，名字改不了（实测踩到）。
                            // ✕ 另用 `onMouseDown preventDefault`（见下），所以它不会走到这里。
                            const to = e.relatedTarget as Node | null;
                            if (to && e.currentTarget.parentElement?.contains(to)) return;
                            applyMarkTime(i, e.target.value);
                          }}
                          className="w-14 shrink-0 rounded px-1 text-10 leading-none outline-none"
                          style={{ backgroundColor: 'var(--surface-muted)', color: 'var(--ink-muted)' }}
                          title="Mark time — mm:ss(.d) or seconds"
                          aria-label="Mark time"
                        />
                        <input
                          autoFocus
                          value={editing.text}
                          onChange={(e) => setEditing({ i, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEditing();
                            else if (e.key === 'Escape') setEditing(null);
                          }}
                          onBlur={(e) => {
                            // 同款守卫：焦点在编辑器内部搬家（名字 ⇄ 时刻）不提交，
                            // 只有真正离开编辑器才落库（点 ✕ 走 preventDefault，也不会到这里）。
                            const to = e.relatedTarget as Node | null;
                            if (to && e.currentTarget.parentElement?.contains(to)) return;
                            commitEditing();
                          }}
                          placeholder="Name"
                          className="w-24 rounded px-1 text-10 leading-none outline-none"
                          style={{ backgroundColor: 'var(--surface-muted)', color: 'var(--ink)' }}
                        />
                        {/*
                          🔴 这个 ✕ 必须先把焦点"钉住"，否则**删不掉**（2026-10-12 十轮修的第二个删除缺陷）：
                          事件顺序是 `mousedown` → input 失焦（`onBlur = commitEditing`）→ `click`。
                          让 blur 先跑，它会拿"改了名字的那一版"整份回写，把紧接着的删除**覆盖掉**
                          （实测：点编辑器里的 ✕，圆点数不动）。`preventDefault` 阻止失焦 ⇒ 输入框不提交，
                          只发生"删除"这一件事，语义唯一；顺带把编辑态关掉（否则它会挂在一个已移位的下标上）。
                        */}
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setEditing(null);
                            removeMark(i);
                          }}
                          className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                          title="Remove this mark"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      ref={(el) => {
                        labelRefs.current[i] = el as unknown as HTMLDivElement | null;
                      }}
                      onClick={() => setEditing({ i, text: m.label || '' })}
                      data-role="mark-label"
                      data-mark-index={i}
                      title={`${m.label || mmss(m.t)} — click to rename`}
                      // `leading-none` 是刻意的：`text-10` 是裸值（行盒沿用 `--lh-md` = 23px），
                      // 打点带只有 24px，23px 的行盒会把圆点挤出去。
                      className="pointer-events-auto max-w-32 truncate rounded px-1 text-10 leading-none"
                      style={{
                        backgroundColor: 'var(--panel-bg)',
                        color: 'var(--ink)',
                        border: '1px solid var(--line)',
                        paddingTop: 2,
                        paddingBottom: 2,
                        // 挤不下时只隐藏**视觉**（visibility 保留布局盒 ⇒ 下一轮还能量宽度）
                        visibility: hiddenLabels.has(i) ? 'hidden' : 'visible',
                        display: isEditing ? 'none' : 'block',
                        ...(flip ? { transform: 'translateX(-100%)' } : {}),
                      }}
                    >
                      {m.label || mmss(m.t)}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/*
          波形 + 投影层。包一层 `relative` 只为了让自绘投影能绝对定位在波形之上
          （静态包装层，不参与条件渲染 ⇒ 不引入任何位移；高度仍由波形容器决定）。
          为什么投影**自绘**而不是用官方 `HoverPlugin`：插件自己按指针算 `transform` 定位那根线，
          **没有吸附的插入点**；收回自绘后线/标签/吸附口径都在我们手里，还能用 Tailwind 类
          （不必再为 shadow DOM 传 rem 字号），探针也不必钻 shadow root。

          为什么 handler 挂在波形容器上（而不是整个 wrapper）：
            ① 它正是 WaveSurfer 渲染波形的位置（shadow DOM 里的 pointerdown 会 composed 冒泡上来）；
            ② 上方那层"打点圆点"是**兄弟节点**，点圆点不会被这里抢走（那是跳转打点的手势）。
        */}
        <div
          className="relative"
          data-role="wave-wrap"
          data-view={view ? `${view.start.toFixed(3)}:${view.sec.toFixed(3)}` : 'all'}
          data-total={duration.toFixed(3)}
          data-zoom-req={onRequestWindowPeaks ? 'yes' : 'no'}
          data-press-anchor={pressAnchorDbg == null ? 'none' : pressAnchorDbg.toFixed(4)}
          data-up-count={upCount}
          data-pin-count={pinCount}
          data-fine={finePx > 0 ? String(finePx) : 'none'}
          data-zoom={zoomPx > 0 ? zoomPx.toFixed(4) : '0'}
          data-scroll={scrollPx.toFixed(1)}
        >
          <div
            ref={boxRef}
            className="w-full overflow-hidden rounded-md"
            style={{ backgroundColor: 'var(--surface-muted)' }}
            onPointerDown={(e) => seekFromPointer(e.clientX)}
          /**
           * 松手 = **兜底归位**：把"离锚最近的那一端"精确钉到按下时吸附到的时刻。
           *
           * 为什么不能只靠拖拽过程中的 `region-updated`：实测（本轮仪表）选区插件的
           * `region-created` / `region-updated` 在合成输入下的触发时机并不可靠，而且它给的是
           * **指针裸坐标**（起点 = 按下点原始位置，被拖那端还会累积 +5px 偏差）。
           * 故松手时再算一次（`anchorSelectionEdge` 幂等，重复调用无副作用）——
           * 这一步不依赖插件的行为，是"起点精准"的**最终保证**。
           */

            onPointerMove={onWavePointerMove}
            onPointerLeave={onWavePointerLeave}
            /**
             * **滚轮 = 以指针所指时刻为锚点缩放**（锚点不动才符合直觉；否则"越缩越跑"）。
             * `shift + 滚轮` = 平移（横向），与常见 DAW 一致。
             * `passive: false` 是必须的 —— React 的 onWheel 是 passive 的，`preventDefault()` 会被忽略，
             * 结果整页跟着滚；所以这里用原生监听（见下面的 addEventListener effect）。
             */
            data-role="wave-box"
          />
          {hover && duration > 0 && (
            <div
              // z-30：必须**高于打点名字层**（z-20）—— 曾经都是 z-10、而名字层在 DOM 里更靠后，
              // 于是后绘制的名字把投影标签盖掉一半（实测截图为证，见 方案 §1.6）
              className="pointer-events-none absolute inset-y-0 z-30"
              style={{ left: `${hover.ratio * 100}%` }}
              // 自证 + 探针锚点：`data-snap` 直接说明"吸到了什么"，不必靠颜色猜
              data-snap={hover.snapped ?? 'free'}
              data-t={hover.t}
            >
              <div
                className="h-full"
                style={{
                  width: 1,
                  // 吸住时用实色（与真实播放条同色系但更细），自由时半透明 ⇒ 一眼能看出"粘没粘上"。
                  // 吸到**打点**时改用打点色（`--mark-line`）：否则"粘在打点上"和"粘在播放头上"
                  // 是同一根紫线，只能靠上方文字分辨；配色对齐后颜色本身就是判据。
                  backgroundColor:
                    hover.snapped === 'mark'
                      ? 'var(--mark-line)'
                      : hover.snapped
                        ? 'var(--primary-strong)'
                        : 'color-mix(in oklab, var(--primary-strong) 45%, transparent)',
                }}
              />
              <span
                data-role="hover-time"
                className="absolute whitespace-nowrap rounded px-1 font-mono text-10"
                style={{
                  backgroundColor: 'var(--panel-bg)',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  /**
                   * ⚠️ 2026-10-12：原来这里有一层"避让缩放簇"的逻辑（悬停标签横向进入簇的范围就下沉），
                   * 因为簇以前**浮在波形右上角**、会压住标签。现在缩放控件搬到波形下方的独立一行
                   * （见 `data-role="zoom-bar"`）⇒ 波形区不再有任何浮层遮挡，这条避让随之删掉：
                   * 标签恒定贴在投影线顶端（`top: 0`），不会再被推到波形中部去。
                   */
                  top: 0,
                  // 靠右缘时把标签翻到线的左侧，免得伸出容器被面板壳裁掉
                  ...(hover.ratio > 0.85 ? { right: 0, transform: 'translateX(-100%)' } : { left: 0 }),
                }}
              >
                {hover.snapped && (
                  <span
                    className="mr-0.5"
                    // 三态可辨：打点=主色、播放头=墨色、刻度=淡灰
                    // （P2 那轮把 `--info` 统一成主色后这里曾退化成同色，分不出"吸到了什么"）
                    style={{
                      color:
                        hover.snapped === 'mark'
                          ? 'var(--primary-strong)'
                          : hover.snapped === 'playhead'
                            ? 'var(--ink-strong)'
                            : 'var(--ink-faint)',
                    }}
                    title={
                      hover.snapped === 'mark'
                        ? 'Snapped to a mark'
                        : hover.snapped === 'playhead'
                          ? 'Snapped to the playhead'
                          : 'Snapped to a tick'
                    }
                  >
                    •
                  </span>
                )}
                {mmss2(hover.t)}
              </span>
            </div>
          )}
          {/*
            **打点竖线**（十二轮）：让"打点"在**波形上**看得见 —— 之前只有上方圆点，
            于是"吸附到打点"这件事在波形上没有落点可看。
            · 手打点：全高 1px 细线（用户要反复参照的锚）；
            · 自动打点：只在顶部画一小段刻痕（一键生成 30+ 点时不会把波形糊成栅栏）；
            · 只画**当前可见窗口内**的（窗口外的 pctOf 会 >100 或 <0，直接跳过，省 DOM）。
            `pointer-events-none`：不挡波形的悬停/拖拽（它纯粹是视觉参照）。
          */}
          {duration > 0 && marks.length > 0 && (
            <div className="pointer-events-none absolute inset-0 z-0">
              {marks.map((m, i) => {
                const pct = pctOf(m.t);
                if (pct < -1 || pct > 101) return null;
                return (
                  <div
                    key={`line-${m.t}-${i}`}
                    data-role="mark-line"
                    data-auto={m.auto ? '1' : '0'}
                    className="absolute top-0"
                    style={{
                      left: `${pct}%`,
                      width: 1,
                      height: m.auto ? 5 : '100%',
                      // 三类线同屏可分（见 globals.css 那两个 token 的注释）：
                      // 播放头/选区 = 紫、手打点 = 琥珀 `--mark-line`、AI 落点 = 青 `--mark-line-ai`。
                      backgroundColor: m.auto ? 'var(--mark-line-ai-soft)' : 'var(--mark-line)',
                    }}
                  />
                );
              })}
            </div>
          )}
          {/*
            **聚光（spotlight）**：下轨选中某片段时，主音轨只亮它的区间、其余整段压暗。
            · 做法是"两片遮罩 + 中间留白"：左片 [0, start]、右片 [end, 100] 各铺一层
              **轨道底色**的半透明洗色（不是黑色）—— 因为"变暗"的本质是**降低波形对比度**，
              洗向本轨底色在明/暗主题下都成立（黑片在暗色主题里反而会看不出变化）；
            · 中间那段本就最亮，只补一层极淡主色 + 两道边界，把"精确到哪一帧"交代清楚；
            · z-20：高于波形/打点竖线(z-0)/试听进度(z-10)，低于悬停投影(z-30)与浮条(z-40)
              ⇒ 指针跟随线不会被压暗盖住；
            · `pctOf` 定位 ⇒ 与打点线/进度同一套映射，缩放平移后仍与下轨的块严格共线；
            · 区间在窗口外/退化时按夹取后为空则不画（缩放跑到区间外就自动"整屏变暗"）。
          */}
          {spotlight && duration > 0 && (() => {
            const a = Math.max(0, Math.min(100, pctOf(spotlight.start)));
            const b = Math.max(0, Math.min(100, pctOf(spotlight.end)));
            if (b <= a) return null;
            const wash = 'color-mix(in oklab, var(--surface-muted) 68%, transparent)';
            return (
              <div className="pointer-events-none absolute inset-0 z-20" data-role="spotlight">
                <div className="absolute inset-y-0" style={{ left: 0, width: `${a}%`, backgroundColor: wash }} />
                <div className="absolute inset-y-0" style={{ left: `${b}%`, right: 0, backgroundColor: wash }} />
                <div
                  className="absolute inset-y-0"
                  style={{
                    left: `${a}%`,
                    width: `${b - a}%`,
                    backgroundColor: 'color-mix(in oklab, var(--primary-strong) 10%, transparent)',
                    borderLeft: '1px solid color-mix(in oklab, var(--primary-strong) 55%, transparent)',
                    borderRight: '1px solid color-mix(in oklab, var(--primary-strong) 55%, transparent)',
                  }}
                />
              </div>
            );
          })()}
          {/*
            试听选区的**轨道播放进度**：点浮条 `Play`（或带选区按空格）后，从选区起点起，
            轨道上"已播过的部分"铺一层主色 ⇒ 一眼看出试听走到哪了；播到终点自动停（`playUntilRef`），
            `playing` 转 false，这层随之消失。
            · z-10：高于选区插件自身的高亮层（它内部用 z-index 2 / 5），低于打点名字层（z-20）与浮条（z-40）；
            · `pointer-events-none`：仍可在波形上悬停/拖拽；
            · 用 `pctOf` 定位 ⇒ 与打点竖线、投影标签同一套映射；窗口外的部分夹到 0 / 100（缩放跑到选区外也不画出界）。
          */}
          {sel && playing && now >= sel.start && now <= sel.end && (
            <div className="pointer-events-none absolute inset-0 z-10">
              <div
                data-role="sel-progress"
                className="absolute top-0 h-full"
                style={{
                  left: `${Math.max(0, pctOf(sel.start)).toFixed(3)}%`,
                  width: `${Math.max(0, Math.min(100, pctOf(now)) - Math.max(0, pctOf(sel.start))).toFixed(3)}%`,
                  backgroundColor: 'color-mix(in oklab, var(--primary-strong) 22%, transparent)',
                }}
              />
            </div>
          )}
          {/*
            P2-3：**选区浮条** —— 跟着选区走的一小组动作（Save excerpt / Play / Clear）。
            · 位置：选区中点上方，并按**实测浮条宽度**夹在波形内（否则窄选区时浮条会伸出面板被裁）；
            · 绝对定位 ⇒ 出现/消失**不推动任何行**（控制行因此可以专心做全局动作）；
            · 它盖住波形顶部约 22px，选择与拖拽仍可在下方 40px 内进行。
          */}
          {sel && duration > 0 && (
            <div
              ref={selBarRef}
              className="absolute top-0.5 z-40 flex items-center gap-1 rounded-md px-1 py-0.5"
              data-role="sel-bar"
              data-sel-start={sel.start.toFixed(4)}
              data-sel-end={sel.end.toFixed(4)}
              style={{
                left: `${(() => {
                  const centerPx = (pctOf((sel.start + sel.end) / 2) / 100) * boxWidth;
                  const half = selBarW / 2;
                  const min = half + 2;
                  const max = Math.max(min, boxWidth - half - 2);
                  return ((Math.min(Math.max(centerPx, min), max) / Math.max(boxWidth, 1)) * 100).toFixed(3);
                })()}%`,
                transform: 'translateX(-50%)',
                backgroundColor: 'var(--panel-bg)',
                border: '1px solid var(--line)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
              }}
            >
              <button
                type="button"
                onClick={openClip}
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:text-[var(--ink-faint)] disabled:opacity-70"
                style={{ color: 'var(--primary-strong)' }}
                title="Save this range as an excerpt (exports a copy)"
              >
                <Scissors className="h-3 w-3" />
                Save excerpt
              </button>
              <button
                type="button"
                onClick={() => sel && playRange(sel)}
                className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-12 font-medium transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--primary-strong)' }}
                title="Play the selected range"
              >
                <Play className="h-3 w-3" />
                Play
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                style={{ color: 'var(--ink-faint)' }}
                title="Clear selection"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          {/*
            新建打点的**瞬时编辑器**：浮在波形上（没有搬进打点带）。
            为什么：带只有 24px 高，输入框挤在带里会与圆点打架；而它是"你正在做的事"，
            浮在主角上反而对（打完字/失焦即消失）。
            同样 `pointer-events-none` + 自身 `pointer-events-auto`：空白处照旧穿透到波形。
          */}
          {draft && duration > 0 && (
            <div className="pointer-events-none absolute inset-0 z-30">
              <div className="absolute top-0.5" style={{ left: `${pctOf(draft.t)}%` }}>
                <div
                  className="pointer-events-auto flex items-center gap-1 rounded px-1 py-0.5"
                  style={{
                    backgroundColor: 'var(--panel-bg)',
                    border: '1px solid var(--primary-strong)',
                    ...(pctOf(draft.t) > 70 ? { transform: 'translateX(-100%)' } : {}),
                  }}
                >
                  <span className="shrink-0 font-mono text-10 leading-none" style={{ color: 'var(--primary-strong)' }}>
                    {mmss(draft.t)}
                  </span>
                  <input
                    autoFocus
                    value={draft.text}
                    onChange={(e) => setDraft({ t: draft.t, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitDraft();
                      else if (e.key === 'Escape') setDraft(null);
                    }}
                    onBlur={commitDraft}
                    placeholder="Name (optional)"
                    className="w-24 rounded px-1 text-10 leading-none outline-none"
                    style={{ backgroundColor: 'var(--surface-muted)', color: 'var(--ink)' }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 时间刻度：按总时长自适应步长，长音频自动稀疏，便于定位。
          **标签带秒后两位**（`mmss2`）；靠右的标签改成右对齐，避免文字伸出右缘被面板壳裁掉。 */}
      {duration > 0 && (
        <div className="relative h-3 w-full select-none" data-role="ticks">
          {(view
            ? tickStopsForWindow(view.start, view.sec, tickLabelsForWidth(boxWidth, tickLabelPx))
            : tickStops(duration, tickLabelsForWidth(boxWidth, tickLabelPx))
          ).map((t, ti) => (
            <span
              key={t}
              // 用**函数式 ref**：条件表达式在 TS 里会被推成 `RefObject | undefined`，与 ref 的属性签名不兼容
              ref={ti === 0 ? (el: HTMLSpanElement | null) => { firstTickRef.current = el; } : undefined}
              className="absolute top-0 font-mono text-10"
              style={{
                left: `${pctOf(t)}%`,
                color: 'var(--ink-faint)',
                // 右缘安全网：窗口模式按窗口内相对位置判（整段模式即原口径）
                // ⚠️ 条件**必须先整体求值再展开**：写成 `...(view ? a : b ? x : {})` 会被解析成
                // `view ? a : (b ? x : {})`，view 为真时展开的是布尔值（TS 直接报 Spread types）
                ...((view ? pctOf(t) > 88 : tickLabelRightAligned(t, duration))
                  ? { transform: 'translateX(-100%)' }
                  : {}),
              }}
            >
              {mmss2(t)}
            </span>
          ))}
        </div>
      )}

      {/* 时间轴缩放控件**不在这里**（2026-10-12）：DOM 在父级 `AudioViewer` 的标题栏
          （用户要求"移到标题栏"）—— 命令走 `AudioMarkTrackHandle`（zoomIn/zoomOut/fitAll/panBy/
          zoomToSelection/setFollow），状态经 `onViewChange` 反向报给父级。
          沿革：波形右上角浮着（会压数据区）→ 波形下一行 → 最终落在标题栏。 */}

      {/* 控制行：**必须 flex-wrap**（2026-10-11 实测）。
          本行内容宽（4s 音频）= **328 / 371 / 415px @ m/l/xl**，而可用内容宽 = 面板宽 − 3rem 内边距
          （`px-6` 是 rem ⇒ 内边距随根字号变宽）= **275 / 269 / 263px @ 面板 320**，
          即最窄档本身就装不下 —— 不折行就会被面板壳的 `overflow:hidden`（CanvasFlow.tsx:628）裁掉。
          实测（面板 320，两个独立见证：几何在裁剪区内 + 中心点 elementFromPoint）：
            · m 档 ：「Play range」可见宽 45.22/75.36，中心仍在内 ⇒ 可点
            · L 档 ：「Play range」可见宽 **8.62/85.41**，中心已在裁剪区外 ⇒ hit=false，实际点不到
            · XL 档：「Play range」可见宽 **0**（完全不可见）；「Clip」也被裁到 38.54/57.06
          折行后最坏只是本行多占一行（2 行 ≈ 63px @ L），远小于上方波形区高度。
          ⚠️ 溢出量还随音频时长增长（读数 `mmss(now) / mmss(duration)` 变长）⇒ 折行是唯一不随数据恶化的解。
          注：折行后第 2 行左对齐（`flex-1` 占位 span 会把第 1 行撑满），这是刻意的最小改动，不引入嵌套结构。
          ⚠️ 2026-10-12：本行新增 `↺③` / `↻③` 两个走带按钮（数字并入箭头后 ≈ +44px；
          早先"图标 + 3s 文字"的版本是 +≈76px，已按用户要求融合收窄），顺序 = 后退 → 播放 → 前进
          → 读数 → 倍速 → 占位 → Add mark。上面那组"内容宽 vs 可用宽"的实测是含 Clip/Play range 的旧口径
          （两者已移走），新增按钮后窄面板**更容易折到第 2 行** —— 折行是既定行为（只是多占一行），
          但将来若再往本行加东西，必须先在 320px 面板下复测"每个按钮的中心点是否仍在裁剪区内"。 */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 后退 N 秒：与 `←` 同一条路径（`nudgeBy`），到头停在 0 不越界。
            ⚠️ 2026-10-16（用户要求"按钮不用显示数字"）：**撤掉箭头上的 `0.3` 徽标**，
            只留 `↺` 图标本身；步长改由 `title` / `aria-label`（以及整条控件行的 `title`）交代。 */}
        <button
          type="button"
          onClick={() => nudgeBy(-NUDGE_SEC)}
          disabled={!duration}
          className="flex shrink-0 items-center justify-center rounded-md p-1 text-[var(--ink-strong)] transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:text-[var(--ink-faint)] disabled:opacity-70"
          title={`Back ${NUDGE_SEC}s (←) · Shift for ${NUDGE_COARSE_SEC}s`}
          aria-label={`Back ${NUDGE_SEC} seconds`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={toggle}
          disabled={!duration}
          className="flex shrink-0 items-center justify-center rounded-md p-1 text-[var(--ink-strong)] transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:text-[var(--ink-faint)] disabled:opacity-70"
          title={
            playing
              ? 'Pause'
              : sel
                ? `Play selection only (${mmss(sel.start)}–${mmss(sel.end)}) · Space`
                : 'Play (Space)'
          }
          aria-label="Play or pause"
        >
          {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        </button>
        {/* 前进 N 秒：与 `→` 同一条路径，到尾停在 total 不越界；同样只留 `↻` 图标（不显示数字）。 */}
        <button
          type="button"
          onClick={() => nudgeBy(NUDGE_SEC)}
          disabled={!duration}
          className="flex shrink-0 items-center justify-center rounded-md p-1 text-[var(--ink-strong)] transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:text-[var(--ink-faint)] disabled:opacity-70"
          title={`Forward ${NUDGE_SEC}s (→) · Shift for ${NUDGE_COARSE_SEC}s`}
          aria-label={`Forward ${NUDGE_SEC} seconds`}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <span className="shrink-0 font-mono text-10" style={{ color: 'var(--ink-muted)' }}>
          {mmss(now)} / {mmss(duration)}
        </span>
        {/* 倍速：点一下换下一档（不弹菜单，省一层开合；当前档位直接写在按钮上） */}
        <button
          type="button"
          onClick={cycleRate}
          disabled={!duration}
          className="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-10 transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:text-[var(--ink-faint)] disabled:opacity-70"
          style={{ color: rate === 1 ? 'var(--ink-muted)' : 'var(--primary-strong)' }}
          title="Playback speed"
        >
          {rate}×
        </button>
        {/* 播放作用域：选中片段后，播放会被收束到该区间（见 `toggle`）。
            以前这是**隐式**行为，走带上看不出任何变化；这颗 chip 把它显式化，× = 恢复整段播放。 */}
        {playScope && (
          <span
            data-role="play-scope"
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-10 font-medium"
            style={{
              color: 'var(--primary-strong)',
              backgroundColor: 'var(--primary-soft)',
              border: '1px solid color-mix(in oklab, var(--primary-strong) 22%, transparent)',
            }}
            title="Playback is limited to this excerpt — clear it to play the whole recording"
          >
            {playScope.label}
            <button
              type="button"
              onClick={playScope.onClear}
              className="inline-flex items-center justify-center rounded-full p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--primary-strong)' }}
              title="Play the whole recording instead"
              aria-label="Clear the playback range"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
        {/* 停在每个打点（优化 A 的开关；只有存在打点才有意义 ⇒ 无打点时置灰）。
            与 Follow 那种"视图"开关不同，它是**播放行为**开关，所以留在控制行、不放标题栏。 */}
        <button
          type="button"
          onClick={() => setStopAtMarks((v) => !v)}
          disabled={!duration || marks.length === 0}
          className="flex shrink-0 items-center justify-center rounded-md p-1 transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: stopAtMarks ? 'var(--primary-strong)' : 'var(--ink-faint)' }}
          title={
            marks.length === 0
              ? 'Stop at each mark — add a mark first'
              : stopAtMarks
                ? 'Stopping at each mark (click to turn off)'
                : 'Stop at each mark — playback pauses on every mark'
          }
          aria-label="Stop at each mark"
          aria-pressed={stopAtMarks}
        >
          <Flag className="h-3 w-3" />
        </button>
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={addMark}
          disabled={!duration}
          className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-12 font-medium text-[var(--primary-strong)] transition-colors hover:bg-[var(--paper-hover)] disabled:cursor-not-allowed disabled:text-[var(--ink-faint)] disabled:opacity-70"
        >
          <Plus className="h-3 w-3" />
          Add mark
        </button>
        {/*
          P2-3（2026-10-11 九轮）：`Clip` / `Play range` 从本行**移走**了 —— 它们是**针对选区**的动作，
          常驻在控制行里既稀释了层次（一行三个同权重文字按钮），又和"播放/读数/Add mark"这些**全局**动作混在一起。
          现在它们跟着选区走：拖出选区后，选区上方浮出一条小工具条（见下方 `selBar`）。
          ⚠️ 这一改顺带**消除了一个潜在位移**：原来是"禁用但常驻"，若改成"无选区就隐藏"会让控制行
          在拖选时从 2 行变 1 行、把下面所有内容顶起来；现在是绝对定位的浮条 ⇒ 开合零位移。
        */}
</div>

      {/* 选区编辑面：排在 {marks} **之后**（见文件头「行序口径」）—— 它的 0↔1 完全跟随一次拖选
          手势，属临时编辑面。放在前面会把打点列表与下方内容整块下推 30.38/33.62/36.87px
          （XL 档 + 面板最小宽 272px 时折两行 ⇒ 63.00px）。 */}
      {sel && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-10" style={{ color: 'var(--ink-faint)' }}>Selected</span>
          <input
            key={`s-${selVersion}`}
            defaultValue={mmssPrecise(sel.start)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => applySelBound('start', e.target.value)}
            className="w-16 shrink-0 rounded px-1 py-0.5 font-mono text-10 outline-none"
            style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink)' }}
            title="Start — mm:ss(.d) or seconds"
          />
          <span className="text-10" style={{ color: 'var(--ink-faint)' }}>–</span>
          <input
            key={`e-${selVersion}`}
            defaultValue={mmssPrecise(sel.end)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => applySelBound('end', e.target.value)}
            className="w-16 shrink-0 rounded px-1 py-0.5 font-mono text-10 outline-none"
            style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink)' }}
            title="End — mm:ss(.d) or seconds"
          />
          <span className="text-10 tabular-nums" style={{ color: 'var(--ink-faint)' }}>
            {Math.max(0, sel.end - sel.start).toFixed(1)}s
          </span>
          {/* ✕ 清除动作已随 P2-3 迁到选区上方的浮条 —— 同一个动作不摆两处 */}
        </div>
      )}

      {/* 临时编辑器排在**最下**（见文件头「行序口径」）。最初它们排在最前 ⇒ 点 Clip / Add mark
          会把上方所有行整块下推一行；P4 把它们移到持久行之后；二轮实测又发现 `{sel}` 的 0↔1
          同样会推 `{marks}`，故最终顺序 = marks → sel → clipDraft → draft。
          两个编辑器不合并成单槽位：addMark 与 openClip 互不清除，同时打开是可能的。 */}
      {clipDraft && (
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-10" style={{ color: 'var(--ink-muted)' }}>
            {mmss(clipDraft.start)}–{mmss(clipDraft.end)}
          </span>
          <input
            autoFocus
            value={clipDraft.text}
            onChange={(e) => setClipDraft((d) => (d ? { ...d, text: e.target.value } : d))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitClip();
              else if (e.key === 'Escape') setClipDraft(null);
            }}
            placeholder="Excerpt name"
            className="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-10 outline-none"
            style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink)' }}
          />
          {/* `✦` 只在父级接了模型命名时才出现 —— 没接就没有这个按钮（不摆一个点了没反应的图标）。
              放在 Export 左侧：先想名字、再导出，与操作顺序一致。 */}
          {onRequestClipName && (
            <button
              type="button"
              onClick={() => void requestClipName()}
              disabled={naming}
              className="shrink-0 rounded-md p-0.5 transition-colors hover:bg-[var(--paper-hover)] disabled:opacity-40"
              style={{ color: 'var(--primary-strong)' }}
              title="Suggest a name from the transcript"
            >
              <Sparkles className={`h-3 w-3${naming ? ' animate-pulse' : ''}`} />
            </button>
          )}
          <button
            type="button"
            onClick={commitClip}
            className="shrink-0 rounded-md p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--primary-strong)' }}
            title="Save excerpt"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => setClipDraft(null)}
            className="shrink-0 rounded-md p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
            style={{ color: 'var(--ink-faint)' }}
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
});