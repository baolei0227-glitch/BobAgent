/**
 * 带戳会议转写的分段解析（从 MeetingReplay 抽出的纯函数，便于单测）。
 *
 * 产物格式（见 audio-parser 拼装 + recordTranscriptText 落盘）：
 *
 *   ## 全文转写
 *
 *   [00:00]
 *   [说话人 1]
 *   这一段的正文……
 *
 * 三条口径：
 *   1. 只取最后一个 `## 全文转写` 之后的部分——前面的抬头/纪要正文不参与分段；
 *   2. `[mm:ss]` **独占一行**作段起点（回放的段起点正则也是这么定的），其后非空行累积成正文；
 *   3. `[说话人 N]`（同样独占一行）抽成 `speaker`（0 基），**真正的文稿不改一字**——
 *      人名是渲染时才映射的，故声纹库里改了名，翻旧录音的字幕也会跟着变。
 *      这些 `[说话人 N]` 只可能来自**会后的整段重转**：会议进行中不做说话人识别。
 */
export interface TranscriptSegment {
  /** 段起点（秒） */
  t: number;
  /** 0 基簇号；未贴标签的段为 null（老产物 / 单人录音） */
  speaker: number | null;
  text: string;
}

/** 文稿里的说话人标签行（会后整段重转拼的 `[说话人 N]`，N 从 1 起） */
export const SPEAKER_LABEL_RE = /^\[说话人\s*(\d+)\]$/;

/** 无戳的旧产物返回空数组，由调用方退化为纯文本展示 */
export function parseTranscriptSegments(md: string): TranscriptSegment[] {
  const marker = '## 全文转写';
  const at = md.lastIndexOf(marker);
  const body = at >= 0 ? md.slice(at + marker.length) : md;
  const out: TranscriptSegment[] = [];
  let cur: { t: number; speaker: number | null; lines: string[] } | null = null;
  const flush = () => {
    if (cur) out.push({ t: cur.t, speaker: cur.speaker, text: cur.lines.join('\n').trim() });
  };
  for (const raw of body.split(/\r?\n/)) {
    const m = /^\[(\d{1,3}):(\d{2})\]\s*$/.exec(raw.trim());
    if (m) {
      flush();
      cur = { t: Number(m[1]) * 60 + Number(m[2]), speaker: null, lines: [] };
      continue;
    }
    const line = raw.trim();
    if (!cur || !line || line.startsWith('#')) continue;
    const sp = SPEAKER_LABEL_RE.exec(line);
    if (sp) {
      if (cur.speaker === null) cur.speaker = Number(sp[1]) - 1;
      continue;
    }
    cur.lines.push(line);
  }
  flush();
  return out.filter((s) => s.text);
}
