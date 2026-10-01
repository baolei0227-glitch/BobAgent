/**
 * 会议归档工具（会议记录员 Recorder 专属；2026-09-27）
 *
 * 两枚只读工具，让「与 Recorder 对话」就能办成两件事：
 *   - meeting_search    ：跨会议检索转写/纪要正文（无 query = 最近会议清单；带 path = 取某场全文）
 *   - meeting_summarize ：按用户自定义要求对**指定一场**会议重新出总结
 *
 * 两个刻意的设计：
 *   ① 检索与阅读都走 /api/butler/meeting 的 search / read action（HTTP 自调用宿主），
 *      复用会议路由里已有的扫盘与路径收口（resolveInSide + 产物名白名单），本文件不碰文件系统；
 *   ② 总结走 summarizeMeetingText（**只调模型、不落库**）——记录员的输出只回对话，
 *      不写收件箱、不落 `会议纪要 - X.md`（否则同场会多出几份口径不一的产物，污染 History 与角标）。
 *
 * 场景门控：两枚工具挂在 'meeting' 场景（registry.ts SCENED_TOOLS），只有 recorder 画像拿得到。
 */
import { summarizeMeetingText } from '@/lib/core/meeting-finalize';
import type { Tool, ToolExecContext } from './index';

/** 会议产物在归档里的最小信息（与 butler/meeting 的 briefEntry 对齐） */
interface MeetingBrief {
  title: string;
  kind: 'minutes' | 'transcript' | 'podcast';
  source: 'local' | 'project';
  path: string;
  place: string;
  time: number;
  snippet?: string;
}

/** 自调用宿主 /api/butler/meeting（Node fetch 不支持相对路径，须用 ctx.baseUrl 拼绝对地址） */
async function callMeetingApi(
  ctx: ToolExecContext | undefined,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = ctx?.baseUrl ? ctx.baseUrl.replace(/\/$/, '') : '';
  const resp = await fetch(`${base}/api/butler/meeting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || data.success !== true) {
    throw new Error(String(data.error || `meeting api failed (HTTP ${resp.status})`));
  }
  return data;
}

/** 归档条目 → 给模型看的精简形态（时间转 ISO，便于它按"上个月"这类说法筛） */
const toBrief = (m: MeetingBrief, withSnippet = false) => ({
  title: m.title,
  kind: m.kind,
  time: new Date(m.time).toISOString(),
  place: m.place,
  source: m.source,
  path: m.path,
  ...(withSnippet ? { snippet: m.snippet || '' } : {}),
});

/** 定位本次要总结/阅读的那一场：给了 path 用它，否则取最新一场（listMeetingHistory 新→旧） */
async function loadTargetMeeting(
  ctx: ToolExecContext | undefined,
  args: Record<string, unknown>,
): Promise<{ title: string; text: string } | null> {
  const rel = String(args.path ?? '').trim();
  const source = args.source === 'project' ? 'project' : 'local';
  let target: { source: 'local' | 'project'; path: string } | null = rel ? { source, path: rel } : null;
  if (!target) {
    const found = await callMeetingApi(ctx, { action: 'search' });
    const hits = (Array.isArray(found.hits) ? found.hits : []) as MeetingBrief[];
    if (hits.length === 0) return null;
    target = { source: hits[0].source, path: hits[0].path };
  }
  const detail = await callMeetingApi(ctx, { action: 'read', source: target.source, path: target.path });
  const text = String(detail.text || '').trim();
  if (!text) return null;
  return { title: String(detail.title || '').trim() || 'Meeting', text };
}

/** 检索过往会议（清单 / 关键词命中片段 / 单场全文） */
async function toolMeetingSearch(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  try {
    const rel = String(args.path ?? '').trim();
    // 模式三：取某场全文（模型从上次检索结果里拿到 path，原样回传）
    if (rel) {
      const detail = await callMeetingApi(ctx, {
        action: 'read',
        source: args.source === 'project' ? 'project' : 'local',
        path: rel,
      });
      return JSON.stringify({
        ok: true,
        mode: 'full_text',
        title: detail.title,
        kind: detail.kind,
        time: detail.time ? new Date(Number(detail.time)).toISOString() : '',
        text: detail.text,
        note: 'This is the full text of ONE meeting. Quote only from it; do not invent anything beyond it.',
      });
    }
    // 模式一/二：无 query = 最近会议清单；有 query = 跨会议正文检索
    const query = String(args.query ?? '').trim();
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 10, 1), 30);
    const found = await callMeetingApi(ctx, { action: 'search', query, limit });
    const hits = (Array.isArray(found.hits) ? found.hits : []) as MeetingBrief[];
    return JSON.stringify({
      ok: true,
      mode: query ? 'search' : 'recent',
      query,
      totalMeetings: Number(found.total) || 0,
      matchCount: hits.length,
      matches: hits.map((m) => toBrief(m, Boolean(query))),
      note: query && hits.length === 0
        ? 'No meeting matched. Try ONE shorter keyword (the match is literal, not semantic). If it still fails, tell the user you could not find it — never make up meeting content.'
        : 'Matching is literal (case-insensitive substring, all keywords must appear). Use `path` to read a full meeting or pass it to meeting_summarize.',
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** 按用户要求对某场会议重新出总结（结果只回对话，不落库） */
async function toolMeetingSummarize(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  const instruction = String(args.instruction ?? '').trim();
  if (!instruction) {
    return JSON.stringify({
      ok: false,
      error: 'instruction is required — pass the user\'s own wording for how they want the summary (structure, focus, level of detail).',
    });
  }
  try {
    const target = await loadTargetMeeting(ctx, args);
    if (!target) {
      return JSON.stringify({
        ok: false,
        error: 'No meeting found to summarize. Search first (meeting_search) and tell the user there is nothing to summarize yet.',
      });
    }
    const minutes = await summarizeMeetingText(target.title, target.text, ctx?.baseUrl, undefined, instruction);
    if (!minutes) {
      return JSON.stringify({
        ok: false,
        error: `Failed to generate a summary for 「${target.title}」(model not configured or the call failed). Tell the user to retry later.`,
      });
    }
    return JSON.stringify({
      ok: true,
      title: target.title,
      instruction,
      minutes,
      note: 'This summary is final. Relay `minutes` to the user as-is (layout tweaks only); do not rewrite, drop or add points. Nothing was saved to the inbox or to the meeting files.',
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export const meetingArchiveToolDefs: Tool[] = [
  {
    name: 'meeting_search',
    description:
      'Search the archive of past meetings (verbatim transcripts + generated minutes). Three modes: (1) no `query` and no `path` → list the most recent meetings with title / kind / time / location / path; (2) `query` → the meetings whose text contains ALL space-separated keywords, each with a matching snippet; (3) `path` → the FULL text of that one meeting (get `path` from a previous meeting_search result). Matching is a literal, case-insensitive substring — there is NO semantic search and NO embedding index, so pass SHORT keywords taken from the user\'s own wording (pass "budget", not "the budget we discussed last quarter"); if nothing matches, retry once with a shorter keyword and otherwise tell the user you could not find it — never invent meeting content.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional literal keywords (space-separated = AND). Omit to list the most recent meetings.',
        },
        path: {
          type: 'string',
          description: 'Exact `path` of one meeting, as returned by a previous meeting_search. When given, the full text is returned.',
        },
        source: {
          type: 'string',
          enum: ['local', 'project'],
          description: 'Which side the `path` belongs to (defaults to "local"). Only meaningful together with `path`.',
        },
        limit: {
          type: 'integer',
          description: 'Max number of matching meetings to return (default 10, capped at 30).',
        },
      },
      required: [],
    },
    category: '系统',
    execute: toolMeetingSearch,
    maxOutput: 12000,
  },
  {
    name: 'meeting_summarize',
    description:
      'Produce a NEW summary of ONE past meeting, following the user\'s own requirements. The summary comes from the minutes model and is returned as final Markdown — relay it to the user as-is. Nothing is written to the Butler inbox or to the meeting files. Pass the user\'s wording verbatim as `instruction` (structure, focus, level of detail, e.g. "only action items with owners"); do not invent constraints they did not ask for. Identify the meeting with `path` (from meeting_search); omit it to use the most recent meeting — in that case state clearly in your reply which meeting you summarized.',
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'The user\'s own summary requirements, verbatim (e.g. "only action items and owners", "one page, in Chinese"). Required.',
        },
        path: {
          type: 'string',
          description: 'Exact `path` of the meeting to summarize (from meeting_search). Omit to use the most recent meeting.',
        },
        source: {
          type: 'string',
          enum: ['local', 'project'],
          description: 'Which side the `path` belongs to (defaults to "local"). Only meaningful together with `path`.',
        },
      },
      required: ['instruction'],
    },
    category: '系统',
    execute: toolMeetingSummarize,
    maxOutput: 12000,
  },
];
