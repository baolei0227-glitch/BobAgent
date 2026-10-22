/**
 * 录音打点（marks）的持久化与解析。
 *
 * 打点挂在**转写 md** 上，一行注释即可：`<!-- bob-marks: [{"t":12.3,"label":"预算"}] -->`
 * （与 `bob-audio` 指针同款注释行：正文与 `## 全文转写` 的分段解析都读不到它，md 肉眼可读、可手改）。
 *
 * 三条口径：
 *   1. t 为**秒**（保留一位小数）——直接对应播放器的 currentTime，与段级 `[mm:ss]` 戳无关；
 *      Live 45s / Import 60s 的段粒度太粗，打点精度只认播放器真实时刻。
 *   2. 返回前按 t 升序排好，渲染端不必再排。
 *   3. 任何异常（不是 JSON / 不是数组 / 字段非法）都当**没有打点**——绝不因一行注释让回放报错。
 */

export interface AudioMark {
  /** 打点时刻（秒） */
  t: number;
  /** 备注（可空） */
  label?: string;
  /**
   * 来源位：`true` = **按转写自动生成**的点（不是用户手打的）。
   *
   * 用途只有一个，但很关键：让「清除自动生成的点」可以只删自动点、不动手打点，
   * 也让"落点"这个动作的撤销有原子粒度（见 lib/audio/mark-ops.ts 的 marksFromRanges）。
   * 手打点**恒不写**该字段 ⇒ 旧数据（无该字段）语义正好等于"手打点"，无需迁移。
   *
   * ⚠️ 可选字段在**四处**序列化/解析里都必须保住（本文件已把两侧收敛成
   * `serializeMark` / `normalizeMarks` 各一份，别再各自展开写）。
   */
  auto?: true;
}

/** md 里的打点指针行（与 bob-audio 同款注释行格式） */
export const MARK_HINT_RE = /^<!--\s*bob-marks:\s*(.+?)\s*-->\s*$/m;

/** 音频指针行：upsert 用它决定插入位置（打点行紧跟在 bob-audio 行之后） */
const AUDIO_LINE_RE = /^<!--\s*bob-audio:.*-->\s*$/m;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * 单条打点 → JSON 项（`t` 保留一位小数；`label` 空则**不写字段**；`auto` 仅 true 时才写）。
 *
 * ⚠️ 字段顺序是 `t → label → auto`，且 label 为空时不写该键 ——
 * `marks.test.ts:51` 有逐字节断言（`[{"t":12.3},{"t":5,"label":"要点"}]`），顺序变了那条用例会红。
 */
function serializeMark(m: AudioMark): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { t: round1(m.t) };
  const label = m.label?.trim();
  if (label) out.label = label;
  if (m.auto) out.auto = true;
  return out;
}

/**
 * 脏 JSON → 打点（**唯一的解析实现**：md 注释行与 sidecar 两条路共用）。
 *
 * 为什么收敛成一份：`auto` 这类可选字段一旦在两条路径里各写一遍遍历，
 * 漏掉一处就是**静默丢字段**（写进去、读出来没了），tsc 与 eslint 都抓不到。
 * 容错口径：非对象 / t 非有限数 / t < 0 跳过；label 去空白，空则省略；结果按 t 升序。
 */
function normalizeMarks(raw: unknown): AudioMark[] {
  if (!Array.isArray(raw)) return [];
  const out: AudioMark[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const t = Number((item as { t?: unknown }).t);
    if (!Number.isFinite(t) || t < 0) continue;
    const labelRaw = (item as { label?: unknown }).label;
    const label = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim() : undefined;
    const mark: AudioMark = label ? { t, label } : { t };
    if ((item as { auto?: unknown }).auto === true) mark.auto = true;
    out.push(mark);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 打点 → 注释行内容（JSON；字段口径见 serializeMark） */
export function serializeMarks(marks: AudioMark[]): string {
  return JSON.stringify(marks.map(serializeMark));
}

/** md → 打点（无指针 / 解析失败 → 空数组；结果按 t 升序） */
export function parseMarks(md: string): AudioMark[] {
  const m = MARK_HINT_RE.exec(md);
  if (!m) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return [];
  }
  return normalizeMarks(raw);
}

/**
 * 把打点写回 md：有打点则替换/插入注释行（紧跟在 bob-audio 行之后），无打点则删除该行。
 * 其余内容一字不动——打点是旁挂元信息，不能影响正文与分段解析。
 */
export function upsertMarkHint(md: string, marks: AudioMark[]): string {
  const line = marks.length > 0 ? `<!-- bob-marks: ${serializeMarks(marks)} -->` : null;
  const lines = md.split(/\r?\n/);
  const idx = lines.findIndex((l) => MARK_HINT_RE.test(l));
  if (idx >= 0) {
    if (line) lines[idx] = line;
    else lines.splice(idx, 1);
    return lines.join('\n');
  }
  if (!line) return md;
  const audioIdx = lines.findIndex((l) => AUDIO_LINE_RE.test(l));
  lines.splice(audioIdx >= 0 ? audioIdx + 1 : 0, 0, line);
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
// Sidecar 持久化（非会议音频用）
// ──────────────────────────────────────────────────────────────

/**
 * 音频打点 sidecar 的**文件名**规则：扩展名换成 `.marks.json`（`a.m4a` → `a.marks.json`）。
 *
 * 只管取名，**放哪个目录**由 lib/audio/library.ts 的 `marksFileFor` 决定
 * （库内音频就地放、库外音频进影子目录）——打点是应用产物，绝不落进 workspace。
 */
export function sidecarPath(audioAbs: string): string {
  return audioAbs.replace(/\.[^.]+$/, '.marks.json');
}

/** 读打点文件（文件不存在/解析失败 → 空数组，与 parseMarks 同口径） */
export async function readMarksFile(abs: string): Promise<AudioMark[]> {
  const { promises: fs } = await import('node:fs');
  try {
    const text = await fs.readFile(abs, 'utf-8');
    return parseMarksJson(text);
  } catch {
    return [];
  }
}

/** 往打点文件写（空数组时删除文件，不留垃圾） */
export async function writeMarksFile(abs: string, marks: AudioMark[]): Promise<void> {
  const { promises: fs } = await import('node:fs');
  const { dirname } = await import('node:path');
  if (marks.length === 0) {
    try { await fs.unlink(abs); } catch { /* 不存在就不管 */ }
    return;
  }
  // 自己 `mkdir -p` 一次（放在空数组分支**之后** ⇒ 删除语义不产生建目录副作用）。
  // 库外音频（项目 materials / 任意本地路径）的打点落在**影子目录**里，而该目录只有
  // 「导出过片段」或「算过波形缓存」才会存在（见 library.ts:71 的 sourceDir(…, ensure=false)）
  // ⇒ 给这样的音频打第一个点必然 ENOENT。理由与 peaks.ts:244 完全相同，那处已修，这里补上。
  // 注意：与 writePeaksCache 的「失败静默」不同——打点是**用户数据**，建目录/写盘失败必须抛出，
  // 不能让调用方以为存成功了。
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(marks.map(serializeMark)), 'utf-8');
}

/** sidecar JSON → 打点（与 parseMarks 共用同一实现，容错口径完全一致） */
function parseMarksJson(text: string): AudioMark[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  return normalizeMarks(raw);
}

// ──────────────────────────────────────────────────────────────
// 片段血缘（clips）
// ──────────────────────────────────────────────────────────────

/**
 * 片段引用：记录「某个音频被截出来的片段」。
 *
 * 片段**不进 workspace**（不落 materials / homework），统一存放在应用自有目录
 * `<APP_ROOT>/.audio-library/<源名>-<指纹>/`（见 lib/audio/library.ts）；归属靠
 * **记 lineage**（该目录下的 `.clips.json`）而非文件名前缀——片段可自由改名，
 * 靠 `片段 - <title> - …` 前缀认亲一旦改名即断。
 */
export interface AudioClipRef {
  /** 片段文件绝对路径（始终是应用自有目录下的本地文件） */
  path: string;
  /** 片段文件名（列表展示 + 下载时的默认文件名） */
  name: string;
  /** 相对源音频的起始秒 */
  start: number;
  /** 相对源音频的结束秒 */
  end: number;
}

/** 片段清单 → JSON（按 start 升序；t 保留一位小数，与打点同口径） */
export function serializeClips(clips: AudioClipRef[]): string {
  return JSON.stringify(
    [...clips]
      .sort((a, b) => a.start - b.start)
      .map((c) => ({ path: c.path, name: c.name, start: round1(c.start), end: round1(c.end) })),
  );
}

/** 追加/更新一条片段引用（同 path 视为重导，替换旧条目；结果按 start 升序） */
export function upsertClipRef(clips: AudioClipRef[], ref: AudioClipRef): AudioClipRef[] {
  const rest = clips.filter((c) => c.path !== ref.path);
  return [...rest, ref].sort((a, b) => a.start - b.start);
}

/** JSON → 片段清单（容错口径同 parseMarksJson：脏数据当空） */
export function parseClips(text: string): AudioClipRef[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: AudioClipRef[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as { path?: unknown; name?: unknown; start?: unknown; end?: unknown };
    const p = typeof o.path === 'string' ? o.path : '';
    if (!p) continue;
    const start = Number(o.start);
    const end = Number(o.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const name = typeof o.name === 'string' && o.name ? o.name : p.split('/').pop() || p;
    out.push({ path: p, name, start: round1(start), end: round1(end) });
  }
  return out.sort((a, b) => a.start - b.start);
}