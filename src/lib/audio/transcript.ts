/**
 * 编辑器侧转写的**纯函数与类型**（无 `node:fs`、无子进程 ⇒ 客户端组件也能值引入）。
 *
 * 为什么单独一个文件：`lib/audio/library.ts` / `marks.ts` 里有 sidecar 的 `node:fs` 动态导入，
 * 是服务端专属；一旦被客户端组件**值引入**就会把 node 内置模块拖进浏览器包
 * （同 `naming.ts` 头注释记录的取舍）。故本文件放"两侧都要用"的东西：
 *   - `AudioTranscript` 类型（客户端 state 的形状 = sidecar 的形状，单一真源）；
 *   - `segmentsForEditor()` 段归一（含**无戳兜底**，见下）；
 *   - `activeSegmentIndex()` 播放高亮用的二分（MeetingReplay 与转写面板共用）；
 *   - `validRange()` 区间**严格校验**（AI 建议与批量截取共用）。
 *
 * ⚠️ 两条来自 audio-parser 的硬约束（写在这里，改这个文件前先读）：
 *
 * 1. **时间戳已是全局时间轴，本文件不做偏移**。`parseAudio` 拼正文时用的
 *    `starts[i] = baseOffset + …`（`audio-parser.ts:748` / `:751`，`baseOffset = range.start`，`:715`），
 *    段头直接写 `startOffset`（`:796`）⇒ 按范围转写出来的 `[mm:ss]` 也是全局的。
 *    早期设计稿里那句「offsetSec = range.start」是**错的**，会造成双重偏移（按选区转写时
 *    段戳整体后移一个 range.start）。此处刻意**不提供** offset 参数。
 *
 * 2. **单个切块不带时间戳**。`audio-parser.ts:795` 只在 `segCount > 1` 时写 `[mm:ss]`；
 *    而 `parseTranscriptSegments` 的段起点正则要求 `[mm:ss]` **独占一行**
 *    （`lib/core/meeting-transcript.ts:41`）⇒ 对短音频（<60s 单块）它返回**空数组**。
 *    若不兜底，编辑器会把"转写成功"显示成"没有内容"（静默失效）。
 */
import { parseTranscriptSegments } from '@/lib/core/meeting-transcript';

/** 一条段（时间一律是**源音频全局时间轴**的秒） */
export interface TranscriptSegment {
  /** 段起点 */
  t: number;
  /** 段终点（下一段起点；末段由音频时长或兜底跨度决定） */
  end: number;
  /** 0 基簇号；未贴标签为 null（老产物 / 单人录音 / 未开分离） */
  speaker: number | null;
  text: string;
  /**
   * 手工插入行（用户加的"断句"）。
   *
   * 插入行的 `t` / `end` 默认复制上一行（没有更细的时间信息），如果不打标记，
   * 它会按"相邻同人"并进上一轮：轮首的改归属入口是**整轮**操作，
   * 用户只点了一下插入行，整轮说话人全被改掉（`groupSegmentTurns` 不拆、润色视图又按
   * 时间重叠反查，时间完全重合 ⇒ 把整轮都圈进来）。
   *
   * 因此：插入行**自成一轮**、只归自己；时长重叠不再被当作"属于同一轮"的证据。
   */
  inserted?: true;
}

/** 转写 sidecar 的源文件指纹：与当前文件不符即视为失效（音频被替换/改名覆盖） */
export interface TranscriptSource {
  size: number;
  mtimeMs: number;
}

/**
 * 一条 AI 精选建议（区间 + 标题 + 理由）。
 *
 * 类型放在本文件（纯函数层）而不是 `lib/audio/ai.ts`：那个文件 import 了
 * `resolveTaskModel`（拖进设置与 `node:fs`），是**服务端专属**。客户端组件只需要这个形状，
 * 放在这里就永远不会有人不小心把服务端模块值引入浏览器包（同 `naming.ts` 的分层理由）。
 */
export interface HighlightSuggestion {
  start: number;
  end: number;
  title: string;
  reason: string;
}

/**
 * 润色后的一轮对话（随稿写入 `.transcript.json` 的 `polished`，Hippo/预览共享）。
 * 只改 text；speaker/start/end 一律沿用原轮，保证点击仍能定位。
 */
export interface PolishedTurn {
  speaker: number | null;
  start: number;
  end: number;
  text: string;
  /** 手工插入的一轮（与 [`TranscriptSegment.inserted`] 同源：只归自己，不并进邻轮） */
  inserted?: true;
}

/** 润色结果的 sidecar 形状（与转写同一份 `.transcript.json` 持久化，Hippo/预览共享） */
export interface TranscriptPolish {
  /** 润色时刻（ISO） */
  at: string;
  /** 产出它的模型（展示用） */
  model: string;
  /** 对话轮；时间/说话人沿用原轮 */
  turns: PolishedTurn[];
}

/** 单轮形状校验：脏数据当没有，不让旧缓存把面板带崩 */
export function isPolishedTurn(value: unknown): value is PolishedTurn {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.text === 'string' &&
    o.text.trim().length > 0 &&
    Number.isFinite(Number(o.start)) &&
    Number.isFinite(Number(o.end)) &&
    (o.speaker === null || Number.isFinite(Number(o.speaker)))
  );
}

/** 润色块形状校验（服务端写入前、客户端读取时共用） */
export function isTranscriptPolish(value: unknown): value is TranscriptPolish {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.at === 'string' &&
    typeof o.model === 'string' &&
    Array.isArray(o.turns) &&
    o.turns.length > 0 &&
    o.turns.every(isPolishedTurn)
  );
}

/**
 * 这一段是不是手工插入行（断句）。
 *
 * `inserted` 标记是 v0.7.742 才写进 sidecar 的：更早版本插入的断句没有该字段，
 * 只看标记就会把老数据当普通段 —— 用户升级后仍然"改说话人连带整轮"。
 * 插入行的特征很确定：`t/end` 都是插入时**从上一行原样复制**的，
 * 而 ASR 段是首尾相接、严格递增的（`end` = 下一段 `t`）⇒ 相邻两段时间区间完全一致只可能是插入行。
 * 读盘时（`parseTranscriptSidecar`）会把推断结果**固化**成标记，之后的逻辑只看标记。
 */
export function isInsertedSegment(
  segments: ReadonlyArray<TranscriptSegment>,
  index: number,
): boolean {
  const seg = segments[index];
  if (!seg) return false;
  if (seg.inserted === true) return true;
  if (index === 0) return false;
  const prev = segments[index - 1];
  return seg.t === prev.t && seg.end === prev.end;
}

/**
 * 把细碎段并成“对话轮”，供 LLM 润色。
 *
 * 规则（只决定喂给模型的块，不改原文事实）：
 *   - 连续同说话人合并；
 *   - 单人/无标签稿按“同块 ≤45s 且 ≤400 字”合并（否则 563 段会变成 563 次模型调用）；
 *   - 换人、超时长、超字数就开新轮。
 */
export function groupSegmentTurns(
  segments: TranscriptSegment[],
  opts: { maxSec?: number; maxChars?: number } = {},
): PolishedTurn[] {
  const maxSec = opts.maxSec ?? 45;
  const maxChars = opts.maxChars ?? 400;
  const out: PolishedTurn[] = [];
  // 上一段是否是手工插入行：插入行**自成一轮**（见 `TranscriptSegment.inserted` 的说明），
  // 既不能并进上一轮，也不许下一段并进来 —— 否则轮首改归属会连带改掉整轮。
  let prevInserted = false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = out[out.length - 1];
    const inserted = isInsertedSegment(segments, i);
    const sameSpeaker = !!last && !prevInserted && !inserted &&
      (seg.speaker === null ? last.speaker === null : last.speaker === seg.speaker);
    const fits =
      !!last &&
      sameSpeaker &&
      seg.end - last.start <= maxSec &&
      last.text.length + seg.text.length + 1 <= maxChars;
    if (fits && last) {
      last.text = `${last.text}\n${seg.text}`;
      last.end = seg.end;
    } else {
      out.push({ speaker: seg.speaker, start: seg.t, end: seg.end, text: seg.text, ...(inserted ? { inserted: true as const } : {}) });
    }
    prevInserted = inserted;
  }
  return out;
}

/** 编辑器侧转写（= sidecar `<dir>/<base>.transcript.json` 的形状） */
export interface AudioTranscript {
  /** 格式版本：将来改结构时据此丢弃旧 sidecar，而不是让旧数据把 UI 带崩 */
  version: number;
  segments: TranscriptSegment[];
  /** 无戳全文（纯正文；AI 精选与片段命名都用它） */
  plainText: string;
  /** 源音频总时长（秒；探测失败为 null） */
  durationSec: number | null;
  /** 引擎抬头（直接取 parse 结果的抬头文案，仅用于展示） */
  engine: string;
  /** 转写范围（整段为 null）—— 按选区转写时非空，供 UI 说明"只转了这一截" */
  range: { start: number; end: number } | null;
  /**
   * DeepSeek 润色结果（侧车持久化；Hippo 与预览面板读同一份）。
   * 缺省 = 这份稿子还没润色过；重新转写会自然丢掉（buildTranscript 不写该字段）。
   */
  polished?: TranscriptPolish;
  /**
   * 这次转写**请求过**的说话人模式（null/缺省 = 没开分离）。
   * 用途：分离是增强项，失败时会静默退回无标签链路；UI 靠它区分
   * 「用户要了对话稿但分离没成功」与「这份录音本来就是单人」。
   * 老 sidecar 没有该字段 ⇒ 由 `engine` 里的「未分说话人 / 按说话人分块」兜底推断。
   */
  diarize?: 'auto' | 'duo' | 'group' | null;
  /**
   * **说话人显示名**（`{ 0: '张三', 1: '李四' }`；缺省 = 全用默认 `Speaker N`）。
   *
   * 只影响显示：`segments[].speaker` 仍是分离出来的 0 基簇号，一字不动
   * ⇒ 改名的代价是零风险（不碰分轮、不碰打点、不碰任何按时间存的东西）。
   * 删掉某个键 / 值改成空串 = 那一簇恢复默认名（见 `updateSpeakerName`）。
   *
   * ⚠️ **重新转写 / 重新分离会整份换掉 sidecar ⇒ 名字随之清空**（转写那条路径是重建 transcript，
   * 不搬运本字段）。这是**有意**的：簇号是这一次分离的结果，重新分完之后 `0` 可能已经换人了，
   * 搬运过来等于把名字贴错人。改归属（`updateSegmentSpeakers`）不动这里，随便改都不影响名字。
   */
  speakerNames?: Record<number, string>;
  /** 写入时刻（ISO） */
  at: string;
  /** 源文件指纹（读回时对账，不符即失效） */
  source: TranscriptSource | null;
  /**
   * **尚未转完**（长音频窗口化转写的中间态）：还有窗口没跑。
   * 语义：这份稿子是**可用但不完整**的 —— UI 要如实标注，且"继续转写"应从 `coveredUntilSec` 续，
   * 而不是从头再来（parse 层按范围缓存，续跑不重复付费）。
   */
  partial?: boolean;
  /**
   * 已覆盖到的秒数（全局时间轴）。断点续跑的唯一依据：
   * 下次从这一点往后切窗口，已转过的窗口靠 parse 层内容哈希缓存直接命中。
   */
  coveredUntilSec?: number;
}

/** 当前 sidecar 版本（改结构时 +1） */
export const TRANSCRIPT_VERSION = 1;

/** 说话人簇号上限（0 基；一次分离最多几十人，99 已远超）—— 挡住 `speaker: 1e9` 这类脏值进 sidecar */
const MAX_SPEAKER_ID = 99;
/** 显示名长度上限（是一个名字，不是一句简介） */
const MAX_SPEAKER_NAME_LEN = 40;
/**
 * 一份稿子里最多记多少个显示名（远超实际簇数；只为挡住畸形数据把对象撑大）。
 * **导出**：批量改名（`updateSpeakerNames` → `rename_speakers` 路由）要用它挡畸形批次，
 * 两处各写一个数迟早分叉（放开上限时漏改一处，就成了"界面能改、服务端拒收"）。
 */
export const MAX_SPEAKER_NAMES = 20;

/** 末段拿不到时长时的兜底跨度（秒） */
const DEFAULT_LAST_SPAN_SEC = 30;
/** 段最短跨度（防止 0 长度段把 chunk 压成不可点） */
const MIN_SEGMENT_SPAN_SEC = 0.1;

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface SegmentsForEditorOptions {
  /**
   * 末段 `end` 的上界（秒，全局时间轴）：整段转写 = 音频时长；按选区转写 = 选区终点 `range.end`。
   * 缺省（null/NaN/≤0）时末段回退 `t + fallbackSpanSec`。
   */
  endSec?: number | null;
  /** 无 `endSec` 时末段的兜底跨度（秒，默认 30） */
  fallbackSpanSec?: number;
}

/**
 * `parseAudio` 的纯正文 → 编辑器段列表。
 *
 * - 有 `[mm:ss]` 戳：逐段补 `end`（= 下一段 `t`；末段用 `endSec` 或兜底跨度）；
 * - **无戳但有正文**：兜底成**单段**（见文件头第 2 条）；空正文 → `[]`。
 * - `t` 一律取原文戳（全局时间轴），本函数**不加偏移**（见文件头第 1 条）。
 */
export function segmentsForEditor(
  plainText: string,
  opts: SegmentsForEditorOptions = {},
): TranscriptSegment[] {
  const text = String(plainText ?? '');
  const rawBound = Number(opts.endSec);
  const bound = Number.isFinite(rawBound) && rawBound > 0 ? rawBound : null;
  const rawSpan = Number(opts.fallbackSpanSec);
  const fallbackSpan = Number.isFinite(rawSpan) && rawSpan > 0 ? rawSpan : DEFAULT_LAST_SPAN_SEC;

  const parsed = parseTranscriptSegments(text);
  if (parsed.length === 0) {
    const body = text.trim();
    if (!body) return [];
    const end = bound ?? fallbackSpan;
    return [{ t: 0, end: round1(Math.max(MIN_SEGMENT_SPAN_SEC, end)), speaker: null, text: body }];
  }

  return parsed.map((seg, i) => {
    const t = round1(Math.max(0, seg.t));
    const nextStart = i + 1 < parsed.length ? parsed[i + 1].t : null;
    const end = nextStart ?? bound ?? t + fallbackSpan;
    return {
      t,
      end: round1(Math.max(t + MIN_SEGMENT_SPAN_SEC, end)),
      speaker: seg.speaker,
      text: seg.text,
    };
  });
}

/**
 * 原地改一句的文字（**只改 `text`，绝不动 `t` / `end` / `speaker`**）。
 *
 * 为什么是纯函数、且**服务端也调它**（`api/audio/clip/route.ts` 的 `action:'save_transcript'`）：
 * 编辑的规则只能有一份，否则"界面上改成功了、落盘却按另一套规则丢了"这类静默分叉迟早出现。
 *
 * 三条拒绝口径（一律返回 `null`，调用方据此保持原样并**显式反馈**）：
 *   1. `index` 不是整数 / 越界 —— 绝不 `map` 一遍原样返回（那是「按 id 落定却零反馈」的翻版）；
 *   2. 去空白后为空 —— 空串段会让 `marksFromRanges` 生成无名打点；"清空"在语义上是**取消编辑**，
 *      不是把这句话从稿子里抹掉（抹掉会连带时间轴出现空洞）；
 *   3. 与原文相同 —— 无变化就不该写盘、也不该留在编辑态。
 *
 * `plainText` 一并按段重建（与 `parseTranscriptSidecar` 的兜底同源）：它是 AI 精选与片段命名的
 * "全文"输入，不跟着改就会出现"人看到的是新句子、模型读到的是旧句子"。
 * 代价：窗口化长稿原本用空行分隔各窗口，重建后规范成单换行 —— 只影响空白形态，不丢内容。
 */
export function updateSegmentText(
  transcript: AudioTranscript,
  index: number,
  text: string,
): AudioTranscript | null {
  const segs = transcript.segments;
  if (!Number.isInteger(index) || index < 0 || index >= segs.length) return null;
  const next = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!next || next === segs[index].text) return null;
  const segments = segs.map((s, i) => (i === index ? { ...s, text: next } : s));
  return { ...transcript, segments, plainText: segments.map((s) => s.text).join('\n') };
}

/**
 * 时间码文本 → 秒（转写面板里手改句首时间用）。
 *
 * 接受三种写法（都返回 `round1` 后的秒）：
 *   - `mm:ss` / `h:mm:ss`（低位必须 < 60，`1:99` 视为非法）；
 *   - 纯秒数（`83` / `83.5`）。
 * 非法（空串、负数、非数字、位数过多）一律返回 `null` —— 调用方据此**还原**输入框，
 * 不猜"用户大概想写几秒"，也不把脏值写进 sidecar。
 */
export function parseTimecode(input: string): number | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  // 纯数字：按秒解释（`1.5` = 1.5s）
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? round1(n) : null;
  }
  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const piece = p.trim();
    if (!/^\d+(\.\d+)?$/.test(piece)) return null;
    nums.push(Number(piece));
  }
  const last = nums[nums.length - 1];
  // 秒位是小数、必须 < 60；三段式时分钟位也必须 < 60
  if (last >= 60) return null;
  if (nums.length === 3 && nums[1] >= 60) return null;
  return round1(nums.reduce((acc, n) => acc * 60 + n, 0));
}

/**
 * 原地改一句的**起点时间**（`t`；`end` 与上一段的 `end` 跟着走）。
 *
 * 为什么必须重排上一段的 `end`：sidecar 里段的时间是**首尾相接**的（`end` = 下一段 `t`，
 * 见 `segmentsForEditor`）。只改本段 `t` 会让上一段与它之间凭空多出一段空隙，
 * 波形选区高亮、`activeSegmentIndex` 与导出都按这套边界算 ⇒ 必须同步。
 *
 * 跳转口径：界面上的时间戳与"跳到这里"读的是**同一个值**（`segments[index].t`），
 * 改完即刻生效，不需要额外维护映射。润色视图按轮的 `start` 跳，故边界也要一起挪。
 *
 * 手工插入行（`inserted`）是**标注**，`t/end` 都是插入时从上一行复制的，没有独立音频区间：
 *   - 它的时间**不钩稽上一行**：可落在音频内任意位置，改完按时间**自动归位**（文稿永远按时间读，
 *     `activeSegmentIndex` 的二分也依赖有序）；不截短任何其他邻段，也不动它们的 `end`；
 *   - **唯一联动的是"插入时截出来的那条边"**：上一行的 `end` 原本 = 旧起点、改完仍在新位置上面时，
 *     它跟着停到新起点（用户口径："上一行结尾始终跟着插入行起点走"）；跳到别的行后面就不跟，
 *     免得把无关的一行截短。润色稿按同一口径处理它上面那一轮；
 *   - 普通段改起点时，只同步**最近一段普通行**的 `end`（中间夹着的插入行不参与时间轴）；
 *   - 润色稿对账时插入轮走**精确配对**：它与上一轮同 `start`，按值对账会把两边一起带走。
 *
 * 拒绝口径（一律 `null`，调用方保持原样并显式反馈）：
 *   1. `index` 非整数/越界，`start` 非有限数/为负；
 *   2. **普通段**：新起点越过本段 `end`（至少留 `MIN_SEGMENT_SPAN_SEC`）；
 *   3. **普通段**：新起点越过上一行起点（保持时间非递减；插入行不受此限）；
 *   4. 已有总时长时超出音频末尾。
 * 与原文相同 ⇒ 也返回 `null`（无变化不写盘、不留在编辑态）。
 *
 * 已有润色稿**不丢弃**：它只对文本负责，时间只是边界标注。插入行按精确配对只挪自己那一轮
 * 并按新时间重排；普通段把"起点恰好等于旧 `t`"的轮首与"终点恰好等于旧 `t`"的上一轮尾
 * 一起挪到新 `t`，两边仍然对得上（对不上的不动，不猜）。
 */
export function updateSegmentStart(
  transcript: AudioTranscript,
  index: number,
  start: number,
): AudioTranscript | null {
  const segs = transcript.segments;
  if (!Number.isInteger(index) || index < 0 || index >= segs.length) return null;
  if (!Number.isFinite(start) || start < 0) return null;
  const t = round1(start);
  const seg = segs[index];
  if (t === seg.t) return null;
  const bound = Number.isFinite(transcript.durationSec) && (transcript.durationSec ?? 0) > 0
    ? transcript.durationSec
    : null;
  if (bound !== null && t > bound) return null;
  const oldT = seg.t;

  if (seg.inserted === true) {
    // 手工插入行：没有独立音频区间 ⇒ 时间自由，改完按时间归位（不截短任何邻段）
    if (bound !== null && t > bound - MIN_SEGMENT_SPAN_SEC) return null;
    const end = t > seg.end - MIN_SEGMENT_SPAN_SEC ? round1(t + MIN_SEGMENT_SPAN_SEC) : seg.end;
    const nextSeg: TranscriptSegment = { ...seg, t, end };
    // 联动：上一行的 `end` 停在新起点上（插入时写的就是这条边，改时间不能让它脱钩）。
    // 三个前提缺一不可：它原本就贴着旧起点（`end === oldT`）、改完**仍然是上一行**
    // （插入行跳到别的行后面时，这条边界已不属于它）、新起点没越过它自己的起点。
    const prev = index > 0 ? segs[index - 1] : null;
    const rest = segs.filter((_, i) => i !== index);
    const at = rest.findIndex((s) => s.t > t);
    const pos = at < 0 ? rest.length : at;
    const above = pos > 0 ? rest[pos - 1] : null;
    const linked = !!prev && prev.end === oldT && above === prev && t >= prev.t;
    const segments = [
      ...rest.slice(0, pos).map((s) =>
        linked && s === prev ? { ...s, end: Math.max(s.t + MIN_SEGMENT_SPAN_SEC, t) } : s,
      ),
      nextSeg,
      ...rest.slice(pos),
    ];

    let polished = transcript.polished;
    const polishedNow = transcript.polished;
    if (polishedNow && polishedNow.turns.length > 0) {
      // 插入轮与插入段同源：时间可能与上一轮完全重合，只能按"时间 + 文字"精确配回自己
      const candidates: number[] = [];
      polishedNow.turns.forEach((turn, i) => {
        if (turn.inserted === true && turn.start === oldT && turn.end === seg.end) candidates.push(i);
      });
      const exact = candidates.filter((i) => polishedNow.turns[i].text === seg.text);
      const own = exact.length === 1 ? exact[0] : exact.length === 0 && candidates.length === 1 ? candidates[0] : -1;
      if (own >= 0) {
        const ownTurn: PolishedTurn = { ...polishedNow.turns[own], start: t, end };
        const turns = [
          ...polishedNow.turns.slice(0, own),
          ownTurn,
          ...polishedNow.turns.slice(own + 1),
        ].sort((a, b) => a.start - b.start);
        // 润色稿的"上一行"同理：只看改完仍在它下面、且原本贴着旧起点的那一轮
        const prevTurn = own > 0 ? polishedNow.turns[own - 1] : null;
        const oi = turns.indexOf(ownTurn);
        if (prevTurn && oi > 0 && turns[oi - 1] === prevTurn && prevTurn.end === oldT && t >= prevTurn.start) {
          turns[oi - 1] = { ...prevTurn, end: Math.max(prevTurn.start + MIN_SEGMENT_SPAN_SEC, t) };
        }
        polished = { ...polishedNow, turns };
      }
    }

    // 位置变了才重建 plainText（段序 = 文稿顺序，正文必须跟着走）
    const plainText = pos === index ? transcript.plainText : plainTextOf(segments);
    return { ...transcript, segments, plainText, polished };
  }

  // 普通段：不能顶到/越过自己的终点（末段也一样：end 是它的说唱终点）
  if (t > seg.end - MIN_SEGMENT_SPAN_SEC) return null;
  const prev = index > 0 ? segs[index - 1] : null;
  if (prev && t < prev.t + MIN_SEGMENT_SPAN_SEC) return null;
  // 时间轴的"上一段" = 最近一段普通行（插入行只是标注，不能顶替它）
  let prevNormal = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (segs[i].inserted !== true) {
      prevNormal = i;
      break;
    }
  }

  const segments = segs.map((s, i) => {
    if (i === index) return { ...s, t };
    if (i === prevNormal) return { ...s, end: t };
    return s;
  });

  const polishedNow = transcript.polished;
  let polished = polishedNow;
  if (polishedNow && polishedNow.turns.length > 0) {
    const turns = polishedNow.turns.map((turn) => {
      // 插入轮与上一轮同 start：按值对账会把用户没点的插入行一起带走
      if (turn.inserted === true) return turn;
      return turn.start === oldT ? { ...turn, start: t } : turn.end === oldT ? { ...turn, end: t } : turn;
    });
    if (turns.some((turn, i) => turn !== polishedNow.turns[i])) polished = { ...polishedNow, turns };
  }

  // plainText 与时间无关：原样保留（不按段重建，避免窗口空行被规范化的副作用）
  return { ...transcript, segments, polished };
}

/**
 * 原地改**润色稿里的一轮**文字（`view=polished` 时的编辑入口）。
 *
 * 与 `updateSegmentText` 的分工：润色轮是 DeepSeek 重写后的文本，和 `segments` **不是一一对应**
 * （`groupSegmentTurns` 会把多句并成一轮），改一轮没法安全地摊回某一句。所以这里只改
 * `polished.turns[index].text`，原文 `segments` **一字不动** —— 切回 `View original` 仍是 ASR 原文，
 * 导出 raw 也不受影响。这与"润色只对文本负责"是同一口径（见 `refreshPolishedSpeakers`）。
 *
 * 拒绝口径与 `updateSegmentText` 同源：越界 / 空文本 / 无变化一律返回 `null`
 * （调用方保持原样并显式反馈）。`at` 是"润色发生的时刻"，手工改字不是重新润色，故不更新。
 */
export function updatePolishedTurnText(
  transcript: AudioTranscript,
  index: number,
  text: string,
): AudioTranscript | null {
  const polished = transcript.polished;
  if (!polished || !Number.isInteger(index) || index < 0 || index >= polished.turns.length) return null;
  const next = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!next || next === polished.turns[index].text) return null;
  const turns = polished.turns.map((t, i) => (i === index ? { ...t, text: next } : t));
  return { ...transcript, polished: { ...polished, turns } };
}

/**
 * 说话人的**显示名**（`张三` / 默认 `Speaker 1` / 未归属 `Unassigned`）。
 *
 * 单一真源：转写面板、Markdown 导出、任何要写"这句是谁说的"的地方都走它 ——
 * 否则改名只在面板生效、导出还是 `Speaker 2`，用户会以为名字没保存（或更糟：以为存了两份不同的归属）。
 */
export function speakerLabel(
  names: Record<number, string> | undefined,
  id: number | null,
): string {
  if (id === null || !Number.isFinite(id)) return 'Unassigned';
  const name = names?.[id];
  return typeof name === 'string' && name.trim() ? name.trim() : `Speaker ${id + 1}`;
}

/**
 * 润色稿的**手工插入轮** ↔ 原文的**手工插入段**配对（返回段下标；配不上给 -1）。
 *
 * 两者是同一件事的两种表示，时间与文字都来自同一次插入。但用户之后可能只改了其中一侧
 * （原文改字不会重写润色稿），所以优先级是：时间 + 文字全等 → 时间唯一的那个 →
 * 配不上（多个时间相同且都对不上）就**不猜**，返回 -1（宁可不改，也不能改错一整轮）。
 */
export function findInsertedSegmentIndex(
  segments: ReadonlyArray<TranscriptSegment>,
  turn: Pick<PolishedTurn, 'start' | 'end' | 'text'>,
): number {
  let fallback = -1;
  let ambiguous = false;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.inserted !== true || s.t !== turn.start || s.end !== turn.end) continue;
    if (s.text === turn.text) return i;
    if (fallback >= 0) ambiguous = true;
    else fallback = i;
  }
  return ambiguous ? -1 : fallback;
}

/**
 * 改动归属后，把润色稿里记着的说话人**跟着刷新**（按 `start` 对回原段）。
 *
 * 为什么这次**不**像 `updateSegmentText` 那样把润色稿丢掉：润色稿只对**文本**负责
 * （`PolishedTurn.text` 才是 DeepSeek 的产物），说话人只是它顺手带的一份标注。改归属时文本一字未动，
 * 丢掉用户花过钱的润色稿属于误伤 —— 刷新一下就能两边都对上。
 *
 * 对账依据是 `start`：`groupSegmentTurns` 里 `start = 该轮首段.t`，而本函数所在的路径
 * **绝不改时间轴**（只改 `speaker`），所以这份对账是稳定的。对不上的轮（转写稿被换过之类）保留原值，
 * **不猜**——猜错会把润色稿里的归属也弄乱，比留着旧值更难查。
 *
 * 手工插入轮另走精确配对（`findInsertedSegmentIndex`）：它的 `start` 与上一轮完全重合，
 * 按 `start` 对账会把"改插入行"变成"改上一轮"。
 */
function refreshPolishedSpeakers(
  polished: TranscriptPolish | undefined,
  segments: ReadonlyArray<TranscriptSegment>,
): TranscriptPolish | undefined {
  if (!polished || polished.turns.length === 0) return polished;
  const byStart = new Map<number, number | null>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    // 手工插入行与上一行同 `start`：不能让它抢走邻轮的对账键（否则改一次插入行，邻轮跟着变）
    if (isInsertedSegment(segments, i)) continue;
    if (!byStart.has(s.t)) byStart.set(s.t, s.speaker);
  }
  const turns = polished.turns.map((t) => {
    let sp: number | null = t.speaker;
    if (t.inserted === true) {
      // 插入轮与插入段是同一件事的两种表示 ⇒ 精确配回那一段（时间重合，不能按 start 批量对账）
      const i = findInsertedSegmentIndex(segments, t);
      if (i >= 0) sp = segments[i].speaker;
    } else if (byStart.has(t.start)) {
      sp = byStart.get(t.start) ?? null;
    }
    return sp === t.speaker ? t : { ...t, speaker: sp };
  });
  return turns.some((t, i) => t !== polished.turns[i]) ? { ...polished, turns } : polished;
}

/**
 * 把**一批段**改归到某个说话人（`null` = 未归属）。
 *
 * 为什么入参是一**批下标**、而不是单个下标：界面上"改归属"的最小操作单位是**一轮**
 * （`groupSegmentTurns` 按"相邻同人"合并出来的那段连续发言）。若只改一句，同一轮里就会出现
 * "前半句归甲、后半句归乙"，分轮逻辑立刻把这轮拆成两轮 —— 用户刚点的那轮当场散架。
 * 所以由调用方（转写面板）把轮内所有段下标一起传进来，本函数只管校验与落值。
 *
 * 三条拒绝口径（与 `updateSegmentText` 同源，一律返回 `null`，调用方保持原样并**显式反馈**）：
 *   1. `indexes` 不是「非空 + 全是合法整数 + 无重复」⇒ 拒绝。**先校验再改**，不做"去重后照改"——
 *      那是"按 id 落定却零反馈"的翻版；
 *   2. `speaker` 既不是 `null`、也不是 `0..MAX_SPEAKER_ID` 的整数 ⇒ 拒绝（脏值绝不进 sidecar）；
 *   3. 这一批**本来就已经全是这个归属** ⇒ 返回 `null`（无变化不写盘、也不留编辑态）。
 *
 * `plainText` 一字未动（说话人不参与正文）⇒ 只重建 `segments`，不重算全文。
 * 已有润色稿则**同步刷新它的说话人标注**（见 `refreshPolishedSpeakers`）—— 文本没变，润色稿不该被丢。
 */
export function updateSegmentSpeakers(
  transcript: AudioTranscript,
  indexes: number[],
  speaker: number | null,
): AudioTranscript | null {
  const segs = transcript.segments;
  if (!Array.isArray(indexes) || indexes.length === 0) return null;
  const hit = new Set<number>();
  for (const i of indexes) {
    if (!Number.isInteger(i) || i < 0 || i >= segs.length || hit.has(i)) return null;
    hit.add(i);
  }
  if (speaker !== null && (!Number.isInteger(speaker) || speaker < 0 || speaker > MAX_SPEAKER_ID)) {
    return null;
  }
  if (indexes.every((i) => segs[i].speaker === speaker)) return null;
  const segments = segs.map((s, i) => (hit.has(i) ? { ...s, speaker } : s));
  const polished = refreshPolishedSpeakers(transcript.polished, segments);
  return polished ? { ...transcript, segments, polished } : { ...transcript, segments };
}

/** 插入行的入参：时间沿用上一行（用户可再调），文案必须非空（空行在 sidecar 里会被丢弃） */
export interface InsertedLine {
  speaker: number | null;
  /** 原文稿的段起点（秒） */
  t: number;
  /** 段终点（秒）；`< t` 时归一到 `t`（零时长） */
  end: number;
  text: string;
}

/** 插入行的时间/文案/说话人校验；不合法返回 `null`（调用方显式反馈，不静默落空行） */
function normalizeInsertedLine(line: InsertedLine): { speaker: number | null; t: number; end: number; text: string } | null {
  const t = Number(line?.t);
  if (!Number.isFinite(t) || t < 0) return null;
  const rawEnd = Number(line?.end);
  const end = Number.isFinite(rawEnd) && rawEnd >= t ? rawEnd : t;
  const speaker = line?.speaker;
  if (speaker !== null && (!Number.isInteger(speaker) || speaker < 0 || speaker > MAX_SPEAKER_ID)) return null;
  const text = String(line?.text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) return null;
  return { speaker: speaker ?? null, t, end, text };
}

/** 按段重建 `plainText`（与 `updateSegmentText` 同源：AI 精选与片段命名读的是这里） */
function plainTextOf(segments: TranscriptSegment[]): string {
  return segments.map((s) => s.text).join('\n');
}

/**
 * 在 `afterIndex` 那**行下面**插一行（原文稿 / 润色稿都支持插入）。
 *
 * 时间由调用方给（界面默认取当前播放头）。插入后**上一行的 `end` 跟着新行起点走** ——
 * 新行从哪儿开始，上一行就说到哪儿（用户口径："上一行的结尾处时间 = 插入行的开始时间"）；
 * 其余段的时间一字不动。留 0.1s 最短跨度：新行起点与上一行起点完全重合时，
 * 上一行不会变成零长度（零长度段读盘时会被规范化成 +0.1，等于静默改数据）。
 *
 * 润色稿同步：若已有 `polished`，把新行也插到锚点段所属轮的后面（否则切到 View polished 会"消失"），
 * 并让那一轮的 `end` 与新行起点对齐（两个视图的"上一行"是同一行）。
 * 找不到对应轮（老稿 / 时间越界）就只动原文 —— 宁可润色稿少一行，也不要把它插错位置。
 */
export function insertSegmentAfter(
  transcript: AudioTranscript,
  afterIndex: number,
  line: InsertedLine,
): AudioTranscript | null {
  const segs = transcript.segments;
  if (!Number.isInteger(afterIndex) || afterIndex < 0 || afterIndex >= segs.length) return null;
  const norm = normalizeInsertedLine(line);
  if (!norm) return null;
  const anchor = segs[afterIndex];
  /** 上一行的终点：= 新行起点（至少留 0.1s） */
  const anchorEnd = Math.max(anchor.t + MIN_SEGMENT_SPAN_SEC, norm.t);
  // `inserted: true` = 用户手工加的断句：自成一轮，轮首改归属只影响它自己
  const seg: TranscriptSegment = { ...norm, inserted: true };
  const segments = [
    ...segs.slice(0, afterIndex),
    { ...anchor, end: anchorEnd },
    seg,
    ...segs.slice(afterIndex + 1),
  ];

  let polished = transcript.polished;
  if (polished && polished.turns.length > 0) {
    // 锚点段落在哪一轮里；时间有重叠（补插的行）时取**最后一轮**，新行才排在这一带的最下面
    let pi = -1;
    polished.turns.forEach((x, i) => {
      if (x.start <= anchor.t) pi = i;
    });
    if (pi >= 0) {
      const turns = [...polished.turns];
      // 锚点恰是该轮覆盖的**最后一段**时，让这一轮的 end 也跟着新行起点走
      // （多句并一轮时锚点可能是轮中间的某句，截这一轮会把后面的句子甩出轮外，故不动）
      let last = -1;
      segs.forEach((s, i) => {
        if (s.t < turns[pi].end) last = i;
      });
      if (last === afterIndex) turns[pi] = { ...turns[pi], end: anchorEnd };
      // 显式构造轮字段：`InsertedLine.t` 是原文口径，别把多余的 `t` 也写进 polished
      turns.splice(pi + 1, 0, { speaker: norm.speaker, start: norm.t, end: norm.end, text: norm.text, inserted: true });
      polished = { ...polished, turns };
    }
  }

  return {
    ...transcript,
    segments,
    plainText: plainTextOf(segments),
    ...(polished ? { polished } : null),
  };
}

/**
 * 在润色稿第 `afterIndex` 轮下面插一轮；同时把它落回 `segments`（两个视图不会各说各话）。
 *
 * 段插入位置 = 该轮覆盖的**最后一段之后**（`t < 该轮 end` 的最后一段）：
 * 润色轮是多段合并来的，直接按 `start` 插会落到这一轮中间。
 * 新段的 `t` 取调用方给的时间但不早于该段起点 —— 保证段列表仍按时间非递减。
 * 插入后**上一轮与它最后一段的 `end` 都跟着新行起点走**（用户口径："上一行的结尾处时间 =
 * 插入行的开始时间"），留 0.1s 最短跨度。
 */
export function insertPolishedTurnAfter(
  transcript: AudioTranscript,
  afterIndex: number,
  line: InsertedLine,
): AudioTranscript | null {
  const polished = transcript.polished;
  if (!polished || !Number.isInteger(afterIndex) || afterIndex < 0 || afterIndex >= polished.turns.length) {
    return null;
  }
  const norm = normalizeInsertedLine(line);
  if (!norm) return null;
  const anchor = polished.turns[afterIndex];

  const segs = transcript.segments;
  let si = -1;
  segs.forEach((s, i) => {
    if (s.t < anchor.end) si = i;
  });
  // 零时长锚点 / 时间异常：退化成"最后一段 start <= 锚点 start"之后
  if (si < 0) {
    segs.forEach((s, i) => {
      if (s.t <= anchor.start) si = i;
    });
  }
  // 🔴 段列表必须按 `t` **非递减**（`activeSegmentIndex` 的二分依赖它）。
  // 多句并一轮时，轮起点会早于该轮中间某句的起点 ⇒ 把新段抬到"该轮最后一句"的起点：
  // 宁可时间重叠，也不把顺序打乱（顺序一乱，播放高亮会指到错误的行）。
  const floorT = si >= 0 ? segs[si].t : 0;
  const t = Math.max(norm.t, floorT);
  // 上一轮（以及它覆盖的最后一段）的终点跟着新行起点走（用户口径：上一行说到新行开始处）
  const prevEnd = Math.max((si >= 0 ? segs[si].t : anchor.start) + MIN_SEGMENT_SPAN_SEC, t);
  const seg: TranscriptSegment = { speaker: norm.speaker, t, end: Math.max(norm.end, t), text: norm.text, inserted: true };
  const segments = si >= 0
    ? [...segs.slice(0, si), { ...segs[si], end: prevEnd }, seg, ...segs.slice(si + 1)]
    : [seg, ...segs];

  const turns = [...polished.turns];
  turns[afterIndex] = { ...turns[afterIndex], end: prevEnd };
  // 轮与段用**同一组时间**（多句并一轮时轮起点会被抬到前一句之后）：
  // 一是切视图/排序口径一致，二是删除时能靠"时间+文字全等"精确配回这一段。
  turns.splice(afterIndex + 1, 0, {
    speaker: seg.speaker,
    start: seg.t,
    end: seg.end,
    text: seg.text,
    inserted: true,
  });

  return {
    ...transcript,
    segments,
    plainText: plainTextOf(segments),
    polished: { ...polished, turns },
  };
}

/**
 * 一轮润色稿与一句原文是否**完全是同一行**（插入时复制出来的那一对）。
 *
 * 只在"删除"里用：时间与文字都对得上才认为两边是同一句，从而一起删掉。
 * 润色稿是 LLM 改写，原文一句与润色一轮的文案通常不同 ⇒ 这个严格口径不会误删改写内容。
 */
function isSameLine(
  turn: { start: number; end: number; text: string },
  seg: { t: number; end: number; text: string },
): boolean {
  return turn.start === seg.t && turn.end === seg.end && turn.text === seg.text;
}

/**
 * 删掉原文稿第 `index` 句（插入的逆操作）。
 *
 * 口径：
 *   - 只删这一句，`plainText` 重建（AI 精选/片段命名读的是它）。
 *   - 润色稿里若有**时间与文字完全一致**的一轮（= 插入时同步带过去的那一轮），一并删掉；
 *     否则**不动**润色稿 —— 它是 LLM 改写，一句原文与一轮润色不是一一对应，硬删会连带吞掉
 *     相邻几句的改写（同"改原文不回写润色稿"的既有约定）。
 *   - **拒绝删到空稿**：`parseTranscriptSidecar` 遇到 0 段会把整份 sidecar 判为失效
 *     ⇒ 文件还在、稿子却读不出来（比"删不掉"糟得多）。
 */
export function deleteSegment(transcript: AudioTranscript, index: number): AudioTranscript | null {
  const segs = transcript.segments;
  if (!Number.isInteger(index) || index < 0 || index >= segs.length) return null;
  if (segs.length <= 1) return null;
  const target = segs[index];
  const segments = segs.filter((_, i) => i !== index);
  const out: AudioTranscript = { ...transcript, segments, plainText: plainTextOf(segments) };
  const turns = transcript.polished?.turns;
  if (turns) {
    const kept = turns.filter((t) => !isSameLine(t, target));
    if (kept.length !== turns.length) {
      if (kept.length > 0) out.polished = { ...transcript.polished!, turns: kept };
      else delete out.polished; // 空润色块不合法（`isTranscriptPolish` 要求 turns.length > 0）
    }
  }
  return out;
}

/**
 * 删掉润色稿第 `index` 轮（插入的逆操作）。
 *
 * 口径与 `deleteSegment` 对称：
 *   - 只删这一轮；原文稿里**时间与文字完全一致**的那一段一并删掉（= 插入时同步的那一段）。
 *   - 多句并一轮的轮被删时，原文句子**保留** —— 原文是事实，润色只是改写；删改写不等于删对话。
 *   - 不把原文删空：删完会 0 段时保留原段（0 段 sidecar 整份失效，见 `parseTranscriptSidecar`）。
 */
export function deletePolishedTurn(transcript: AudioTranscript, index: number): AudioTranscript | null {
  const polished = transcript.polished;
  if (!polished || !Number.isInteger(index) || index < 0 || index >= polished.turns.length) return null;
  const target = polished.turns[index];
  const turns = polished.turns.filter((_, i) => i !== index);

  const segs = transcript.segments;
  const kept = segs.filter((s) => !isSameLine(target, s));
  // 删到 0 段会让整份 sidecar 失效 ⇒ 宁可保留原文，也不把稿子弄成读不出来的状态
  const segments = kept.length > 0 ? kept : segs;
  const out: AudioTranscript = { ...transcript, segments, plainText: plainTextOf(segments) };
  if (turns.length > 0) out.polished = { ...polished, turns };
  else delete out.polished;
  return out;
}

/**
 * 说话人显示名的**归一化**（折叠空白 + 去首尾 + 截到 `MAX_SPEAKER_NAME_LEN`）。
 *
 * 必须**导出**：客户端提交前要用它做"有没有变化"的判断，服务端落盘前用它做同一次归一化 ——
 * 若各写一套，用户输入 ` 张三 `（库里已是 `张三`）时客户端判"有变化"、服务端判"无变化"，
 * 于是弹出"保存失败"却什么都没发生（同 `updateSegmentText` 那两份口径必须一致的理由）。
 */
export function normalizeSpeakerName(name: string): string {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEAKER_NAME_LEN);
}

/**
 * 改**一个说话人**的显示名（去空白后为空 = 恢复默认 `Speaker N`）。
 *
 * 与 `updateSegmentSpeakers` 的分工：这条只动 `speakerNames` 那个显示映射、**绝不碰 `segments`**。
 * 于是"给 Speaker 2 起个名"和"某轮归错人了"是两条互不干扰的路径：名字改错了再改一次即可，
 * 回滚也不该把归属一起动 —— 反过来同理。
 *
 * 名字归一化见 `normalizeSpeakerName`（显示名会进 Markdown 导出的标题行，换行/超长会把版面顶坏）。
 * 与库里现有值相同 ⇒ 返回 `null`（无变化不写盘）。
 */
export function updateSpeakerName(
  transcript: AudioTranscript,
  id: number,
  name: string,
): AudioTranscript | null {
  if (!Number.isInteger(id) || id < 0 || id > MAX_SPEAKER_ID) return null;
  const next = normalizeSpeakerName(name);
  const cur = transcript.speakerNames ?? {};
  if ((cur[id] ?? '') === next) return null;
  const names: Record<number, string> = { ...cur };
  if (next) names[id] = next;
  else delete names[id];
  const out: AudioTranscript = { ...transcript };
  // 名字全清空 ⇒ 整个字段收起，老 sidecar 的字段形状不变
  if (Object.keys(names).length > 0) out.speakerNames = names;
  else delete out.speakerNames;
  return out;
}

/**
 * **批量**改说话人显示名（面板里"列出所有人 → 一次改完 → 统一保存"的那条路）。
 *
 * 为什么不复用单条 `updateSpeakerName` 让前端循环调 N 次：那会**写 N 次盘、弹 N 条提示**，
 * 半路失败还会留下"一半改了一半没改"的中间态 —— 而界面语义是一个动作（统一保存）。
 * 本函数给的是"一次读改写"⇒ 整批落盘或整批不落，回滚也只需恢复**整套**映射。
 *
 * 规则**不另立一套**：逐条委托 `updateSpeakerName`（归一化、范围校验、空名删键、全空收起字段
 * 都在那边）。差异只在拒绝口径：非法条目（`NaN`/越界）在这里**跳过**而不是整批拒绝 ——
 * 一批里混进一两个脏键时，用户真正想改的那几个不该陪葬（单条路径仍严格拒绝）。
 *
 * 全部条目都没造成变化（含"改了一圈又绕回原状"）⇒ 返回 `null`（无变化不写盘）。
 *
 * ⚠️ 入参形状由**调用方**负责（路由层已把 JSON 归一成 `{ id: number, name: string }`）：
 * 本文件是纯函数层，不再重复防御（同 `updateSegmentText` 的分工）。
 */
export function updateSpeakerNames(
  transcript: AudioTranscript,
  entries: ReadonlyArray<{ id: number; name: string }>,
): AudioTranscript | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let out = transcript;
  for (const e of entries) {
    const next = updateSpeakerName(out, e.id, e.name);
    if (next) out = next;
  }
  if (out === transcript) return null;
  // 逐条委托可能绕回原点（`Speaker 1` 先改名、又改回空）⇒ 终态与原文一致就不算变化
  const before = transcript.speakerNames ?? {};
  const after = out.speakerNames ?? {};
  const keys = Object.keys(before);
  if (
    keys.length === Object.keys(after).length &&
    keys.every((k) => before[Number(k)] === after[Number(k)])
  ) {
    return null;
  }
  return out;
}

/**
 * 播放时刻 → 当前段下标（`-1` = 还没到第一段）。
 *
 * 语义取"最后一段 `t ≤ time`"，与 `end` 无关：`end` 是**推算**出来的（下一段起点/末段兜底），
 * 拿它做右开区间会在"段间隔"里把高亮闪掉。MeetingReplay 的 `onPlaybackTime`
 * （`MeetingReplay.tsx:257-272`）就是这套，此处抽出来给两处共用（禁止两处各写一遍）。
 *
 * ⚠️ 入参刻意只要求 `{ t: number }` 这个**最小结构**，不要求本文件的 `TranscriptSegment`：
 * 会议回放用的是 `lib/core/meeting-transcript` 的段（**没有 `end` 字段**，那是回放侧不需要的量）。
 * 若这里写死本文件的类型，会逼着调用方去凑一个用不上的字段（或复制一份函数）——
 * 函数实际只读 `.t`，类型就该只要求 `.t`。
 */
export function activeSegmentIndex(segments: ReadonlyArray<{ t: number }>, time: number): number {
  if (segments.length === 0) return -1;
  const t = Number(time);
  if (!Number.isFinite(t)) return -1;
  if (t < segments[0].t) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].t <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

/**
 * 区间**严格校验**（越界即拒绝，不做边界钳位；只留一个测量容差）。
 *
 * 为什么是"拒绝"而不是"钳到边界"：这个函数的两个消费者（AI 精选建议、批量截取请求）
 * 都**不该**把越界输入"修好"——钳位会把模型的胡说变成一段看起来合法的片段
 * （`end = 时长 + 60` 被钳成 `时长` 后，与"模型本来就想截到结尾"无法区分），
 * 也会把客户端的算错悄悄吞掉。倒置/负起点/NaN **一律返回 null**，由调用方如实报错。
 *
 * 为什么上界留 `endToleranceSec`（默认 0.5s）而不是严格 `≤ duration`：
 * **时长是两个不同测法的读数** —— 服务端用 ffprobe（`probeAudioDurationSec`），
 * 客户端用解码器（WaveSurfer `ready` 给的真实时长），同一文件差几十毫秒是常态。
 * 于是"按播放器时长截到结尾"这个完全正常的请求，会被服务端的严格判据误判成越界
 * （`60.00 > 59.98 + 1e-6`）⇒ 用户看到"range is outside the audio"却什么都没做错。
 * 0.5s 远小于任何真实片段长度，却足以吸收测法差异；越界超过 0.5s 才判错。
 *
 * @param durationSec 源音频时长；未知（null/NaN/≤0）时只校验非负与最短跨度
 * @param minSpanSec  最短跨度（默认 1s；批量截取服务端另有 0.1s 的下限）
 * @param endToleranceSec 上界容差（秒），见上
 */
export function validRange(
  start: unknown,
  end: unknown,
  durationSec: number | null | undefined,
  minSpanSec = 1,
  endToleranceSec = 0.5,
): { start: number; end: number } | null {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (s < 0) return null;
  const max = Number(durationSec);
  const tol = Number.isFinite(Number(endToleranceSec)) && Number(endToleranceSec) >= 0 ? Number(endToleranceSec) : 0;
  if (Number.isFinite(max) && max > 0 && e > max + tol) return null;
  if (!(e - s >= minSpanSec)) return null;
  return { start: round1(s), end: round1(e) };
}

/**
 * 老润色稿（≤ v0.7.741）里的插入轮同样没有 `inserted` 字段。
 *
 * 插入轮总是紧跟在锚点轮之后，且与插入段的时间区间完全一致。两条判据：
 *   1. **时间 + 文字全等** —— 最可靠（润色没改过插入行时）；
 *   2. **同区间的后一轮** —— 覆盖"用户在润色视图里改过这行文字"的老数据；
 *      正常分轮不会产出两轮完全同区间（那需要两段同区间，只可能是插入行）。
 * 对不上就保持原样（不猜），不至于把普通轮误标成插入轮。
 */
function materializePolishedInserted(
  polished: TranscriptPolish,
  segments: ReadonlyArray<TranscriptSegment>,
): TranscriptPolish {
  const insertedAt = (start: number, end: number, text?: string) => {
    for (let i = 0; i < segments.length; i++) {
      if (!isInsertedSegment(segments, i)) continue;
      const s = segments[i];
      if (s.t !== start || s.end !== end) continue;
      if (text === undefined || s.text === text) return true;
    }
    return false;
  };
  let changed = false;
  const turns = polished.turns.map((turn, i) => {
    if (turn.inserted === true) return turn;
    if (!insertedAt(turn.start, turn.end)) return turn;
    const prev = i > 0 ? polished.turns[i - 1] : null;
    const exactText = insertedAt(turn.start, turn.end, turn.text);
    const followsSameRange = !!prev && prev.start === turn.start && prev.end === turn.end;
    if (!exactText && !followsSameRange) return turn;
    changed = true;
    return { ...turn, inserted: true as const };
  });
  return changed ? { ...polished, turns } : polished;
}

/** 宽松解析 sidecar JSON → `AudioTranscript`；版本不符/脏数据一律返回 null（当作没转过） */
export function parseTranscriptSidecar(raw: string): AudioTranscript | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Partial<AudioTranscript>;
  if (Number(o.version) !== TRANSCRIPT_VERSION) return null;
  if (!Array.isArray(o.segments)) return null;
  const segments: TranscriptSegment[] = [];
  for (const item of o.segments) {
    if (typeof item !== 'object' || item === null) continue;
    const seg = item as { t?: unknown; end?: unknown; speaker?: unknown; text?: unknown; inserted?: unknown };
    const t = Number(seg.t);
    const end = Number(seg.end);
    const text = typeof seg.text === 'string' ? seg.text : '';
    if (!Number.isFinite(t) || t < 0 || !text) continue;
    const speaker =
      typeof seg.speaker === 'number' && Number.isFinite(seg.speaker) ? seg.speaker : null;
    const safeEnd = Number.isFinite(end) && end > t ? end : t + MIN_SEGMENT_SPAN_SEC;
    segments.push({ t, end: safeEnd, speaker, text, ...(seg.inserted === true ? { inserted: true as const } : {}) });
  }
  if (segments.length === 0) return null;
  /*
    老 sidecar（≤ v0.7.741）里手工插入的断句**没有** `inserted` 字段：升级后如果只看标记，
    这些断句仍会被并进邻轮（改说话人连带整轮的老 bug 复发）。插入行的 `t/end` 是从上一行
    原样复制的 ⇒ 与上一段时间区间完全一致只可能是插入行，这里就地**固化**成标记。
  */
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].inserted !== true && isInsertedSegment(segments, i)) {
      segments[i] = { ...segments[i], inserted: true };
    }
  }
  const src = o.source as Partial<TranscriptSource> | null | undefined;
  const source =
    src && Number.isFinite(Number(src.size)) && Number.isFinite(Number(src.mtimeMs))
      ? { size: Number(src.size), mtimeMs: Number(src.mtimeMs) }
      : null;
  const range =
    o.range && Number.isFinite(Number(o.range.start)) && Number.isFinite(Number(o.range.end))
      ? { start: Number(o.range.start), end: Number(o.range.end) }
      : null;
  const diarize =
    o.diarize === 'auto' || o.diarize === 'duo' || o.diarize === 'group' ? o.diarize : null;
  const polishedRaw = isTranscriptPolish(o.polished) ? o.polished : undefined;
  const polished =
    polishedRaw && polishedRaw.turns.some((turn) => turn.inserted !== true)
      ? materializePolishedInserted(polishedRaw, segments)
      : polishedRaw;
  /*
    说话人显示名：逐项校验，**只丢坏的那一项**（一个畸形名字不该让用户丢掉整份转写稿）。
    键必须是 0..MAX_SPEAKER_ID 的整数（JSON 里键是字符串，`Number(k)` 归一），值必须是字符串；
    名字仍按 `normalizeSpeakerName` 归一，避免读回的名字与刚存的不是同一个。
  */
  const speakerNames: Record<number, string> = {};
  const rawNames = o.speakerNames as Record<string, unknown> | undefined | null;
  if (rawNames && typeof rawNames === 'object' && !Array.isArray(rawNames)) {
    for (const [k, v] of Object.entries(rawNames)) {
      if (Object.keys(speakerNames).length >= MAX_SPEAKER_NAMES) break;
      const id = Number(k);
      if (!Number.isInteger(id) || id < 0 || id > MAX_SPEAKER_ID || typeof v !== 'string') continue;
      const name = normalizeSpeakerName(v);
      if (name) speakerNames[id] = name;
    }
  }
  const duration = Number(o.durationSec);
  const covered = Number(o.coveredUntilSec);
  return {
    version: TRANSCRIPT_VERSION,
    segments,
    plainText: typeof o.plainText === 'string' ? o.plainText : segments.map((s) => s.text).join('\n'),
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    engine: typeof o.engine === 'string' ? o.engine : '',
    range,
    // 老 sidecar 没有该字段：不硬写 null，交给 UI 从 engine 文本推断
    ...(diarize ? { diarize } : {}),
    ...(polished ? { polished } : {}),
    ...(Object.keys(speakerNames).length > 0 ? { speakerNames } : {}),
    at: typeof o.at === 'string' ? o.at : '',
    source,
    // 只有真的还在中间态才带 partial（`false` 不写 ⇒ 老 sidecar 的字段形状不变）
    ...(o.partial === true ? { partial: true } : {}),
    ...(Number.isFinite(covered) && covered >= 0 ? { coveredUntilSec: covered } : {}),
  };
}
