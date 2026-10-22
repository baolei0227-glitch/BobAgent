/**
 * 音频编辑器的 AI 路由：AI 精选片段（`highlights`）+ 片段智能命名（`suggest_clip_name`）
 * + 转写润色（`polish_turns`，走 DSH 任务模型，只改文字不改时间/说话人）。
 *
 * 为什么**独立于** `api/audio/clip` 而不是并进去：
 *   - 那一族 action 是"**文件操作**"（截取/打点/波形），失败语义是"I/O 或参数"；
 *     这一族是"**模型任务**"，失败语义是"没配模型 / 超时 / 返回不可解析"。
 *     混在一个路由里，两类失败会在同一个 try/catch 与同一个 `maxDuration` 下互相牵连。
 *   - 超时量级也不同：模型调用 10–20s，音频截取是分钟级。
 *
 * 口径：模型侧的一切失败都返回 **200 + `{success:false,error}`**（用户可读的业务原因），
 * 只有真正的意外（如请求体不是 JSON 之外的程序错误）才由外层兜成 500。
 */
import { NextRequest, NextResponse } from 'next/server';
import { generateHighlights, polishTurns, suggestClipName, MAX_HIGHLIGHTS, MAX_POLISH_TURNS, type PolishInputTurn } from '@/lib/audio/ai';
import type { TranscriptSegment } from '@/lib/audio/transcript';

/** 模型任务的时限：精选要读完整份转写，给足 60s（远小于音频截取的量级） */
export const maxDuration = 60;

/**
 * 客户端传来的段列表 → 可信段列表。
 *
 * 虽然这些段本来是服务端写进 sidecar 的，但**路由不能假设调用方是自家 UI**
 * （仓库里已有跨包直连 fetch 的先例）。脏项直接丢弃，避免下面 `s.text.replace` 抛 TypeError
 * 把一次正常的 AI 调用变成 500。
 */
/** 润色入参 → 可信轮列表：id 必须是整数，text 非空；脏项丢弃（不让一次正常调用变 500） */
function sanitizePolishTurns(raw: unknown): PolishInputTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: PolishInputTurn[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as { id?: unknown; speaker?: unknown; text?: unknown };
    const id = Number(o.id);
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!Number.isInteger(id) || !text) continue;
    const speaker = o.speaker === null || o.speaker === undefined ? null : Number(o.speaker);
    out.push({ id, speaker: Number.isFinite(speaker) ? speaker : null, text });
    if (out.length >= MAX_POLISH_TURNS) break;
  }
  return out;
}

function sanitizeSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as { t?: unknown; end?: unknown; speaker?: unknown; text?: unknown };
    const t = Number(o.t);
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!Number.isFinite(t) || t < 0 || !text) continue;
    const end = Number(o.end);
    const speaker = Number.isFinite(Number(o.speaker)) ? Number(o.speaker) : null;
    out.push({
      t,
      end: Number.isFinite(end) && end > t ? end : t + 1,
      speaker,
      text,
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'highlights') {
      const segments = sanitizeSegments(body.segments);
      const rawDuration = Number(body.durationSec);
      const durationSec = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;
      const max = Number(body.max);
      const result = await generateHighlights(
        segments,
        durationSec,
        Number.isFinite(max) && max > 0 ? Math.min(max, MAX_HIGHLIGHTS) : MAX_HIGHLIGHTS,
      );
      return result.ok
        ? NextResponse.json({ success: true, highlights: result.value, model: result.model })
        : NextResponse.json({ success: false, error: result.error });
    }

    if (action === 'polish_turns') {
      const turns = sanitizePolishTurns(body.turns);
      if (turns.length === 0) {
        return NextResponse.json({ success: false, error: '没有可润色的转写文本。' });
      }
      const result = await polishTurns(turns);
      return result.ok
        ? NextResponse.json({ success: true, turns: result.value, model: result.model })
        : NextResponse.json({ success: false, error: result.error });
    }

    if (action === 'suggest_clip_name') {
      const result = await suggestClipName(String(body.text || ''));
      return result.ok
        ? NextResponse.json({ success: true, name: result.value, model: result.model })
        : NextResponse.json({ success: false, error: result.error });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('audio/ai POST error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
