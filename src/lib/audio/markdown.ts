/**
 * 把转写稿转成可读的 Markdown（导出 / 用 BobWork Markdown 阅读器打开）。
 *
 * 两种版本：
 *   - raw      = ASR 原文（逐句/逐段，保留时间戳）
 *   - polished = DeepSeek 润色后的对话轮（有则用；没有则自然退回 raw）
 *
 * 这里是纯函数：不读文件、不依赖当前项目，便于单测；落盘由音频路由负责。
 */
import { speakerLabel, type AudioTranscript, type TranscriptPolish } from './transcript';

export type TranscriptMarkdownVariant = 'raw' | 'polished';

function stamp(sec: number): string {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 标题行里的说话人叫法。
 *
 * 已归属的走 `speakerLabel`（显示名的单一真源）⇒ 用户起过的名字在**导出件**里同样出现，
 * 不会出现"面板上写了张三、导出的 markdown 还写着 Speaker 1"这种看起来像没保存的错位。
 * 未归属保持导出特有的措辞：「未标注说话人」说的是"这份稿子压根没做分离"，
 * 与面板里 `Unassigned`（做过分离但这轮没分出来）不是一回事。
 */
function speakerTitle(names: Record<number, string> | undefined, speaker: number | null): string {
  return speaker === null || !Number.isFinite(Number(speaker))
    ? '未标注说话人'
    : speakerLabel(names, Number(speaker));
}

/** 当前稿子是否真的有可用的润色版本 */
export function hasPolishedTranscript(t: AudioTranscript): t is AudioTranscript & { polished: TranscriptPolish } {
  return !!t.polished && t.polished.turns.length > 0;
}

export interface TranscriptMarkdownRange {
  start: number;
  end: number;
}

/** 该区间内是否至少有一句原文/润色对话（用于导出前挡住空文稿） */
export function hasTranscriptInRange(t: AudioTranscript, range: TranscriptMarkdownRange): boolean {
  const hit = (start: number, end: number) => end > range.start && start < range.end;
  return (
    t.segments.some((s) => hit(s.t, s.end)) ||
    (!!t.polished && t.polished.turns.some((turn) => hit(turn.start, turn.end)))
  );
}

export function transcriptToMarkdown(
  t: AudioTranscript,
  opts: {
    title: string;
    variant: TranscriptMarkdownVariant;
    generatedAt?: Date;
    /** 片段区间：只看这一段，时间改成片段内相对时间（00:00 起） */
    range?: TranscriptMarkdownRange;
  },
): string {
  const range = opts.range;
  const inRange = (start: number, end: number) => !range || (end > range.start && start < range.end);
  const polishedTurns = t.polished?.turns.filter((turn) => inRange(turn.start, turn.end)) ?? [];
  const wantsPolished = opts.variant === 'polished' && polishedTurns.length > 0;
  const rawTurns = t.segments
    .filter((s) => inRange(s.t, s.end))
    .map((s) => ({ speaker: s.speaker, start: s.t, end: s.end, text: s.text }));
  const turns = (wantsPolished ? polishedTurns : rawTurns).map((turn) => {
    if (!range) return turn;
    return {
      ...turn,
      start: Math.max(0, turn.start - range.start),
      end: Math.max(0, Math.min(range.end, turn.end) - range.start),
    };
  });

  const title = opts.title.trim() || '对话稿';
  const generated = (opts.generatedAt ?? new Date()).toLocaleString('zh-CN', { hour12: false });
  const duration = t.durationSec ? stamp(t.durationSec) : '';
  const lines: string[] = [
    `# ${title} — 对话稿`,
    '',
    `> 版本：${wantsPolished ? 'DeepSeek 润色' : 'ASR 原文'}${wantsPolished ? `（${t.polished?.model ?? 'DeepSeek'}）` : ''}`,
    `> 引擎：${t.engine || '未知'}`,
    ...(range
      ? [
          `> 源区间：${stamp(range.start)}–${stamp(range.end)}`,
          `> 片段时长：${stamp(range.end - range.start)}`,
        ]
      : duration
        ? [`> 时长：${duration}`]
        : []),
    `> 生成：${generated}`,
    '',
    '---',
    '',
  ];

  for (const turn of turns) {
    const text = String(turn.text || '').trim();
    if (!text) continue;
    lines.push(`### ${speakerTitle(t.speakerNames, turn.speaker)} · ${stamp(turn.start)}–${stamp(turn.end)}`, '', text, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
