import { NextRequest, NextResponse } from 'next/server';
import { resolveTaskModel } from '@/lib/wanted/task-model';
import { parseTodoTime } from '@/lib/todo-time-parse';

/**
 * /api/sticky-notes/parse-time — 从一条待办文本里解析「事件开始时间」。
 *
 * 调用方：StickyTodoDock 的「Add to calendar」弹窗——点行尾 + 弹窗后异步调用，
 * 用识别出的日期/时刻预填（用户手改过则不覆盖）。
 * 分层：正则快路径（lib/todo-time-parse，零延迟）→ LLM 回退（覆盖「下周三下午开会」等任意表达）。
 *
 * 与 /api/wanted/schedule-parse 的区别：那个解析「查询区间」（整天边界，供检索），
 * 这里解析「单个事件的开始时刻」，语义不同故独立成端点。
 *
 * 返回：{ success: true, date: 'YYYY-MM-DD', time?: 'HH:MM', topic?: string, source: 'regex'|'llm', model_used? }
 *      topic = 原文剔除时间表达后的事项本身（「明天下午3点跟张三开会」→「跟张三开会」），
 *      调用方用它预填弹窗 Todo 一栏，让主题与时间各归其位（时间落在 Date/Time 字段）。
 *      识别不到 / 无可用模型 → { success: false, error }（调用方保持弹窗默认时段，不打扰用户）
 */

interface ParsedTimeResponse {
  success: boolean;
  /** 本地日期 YYYY-MM-DD */
  date?: string;
  /** 本地时刻 HH:MM；缺省表示文本里只有日期 */
  time?: string;
  /** 原文剔除时间表达后的事项主题；缺省表示无可剔除内容（调用方保留原文） */
  topic?: string;
  source?: 'regex' | 'llm';
  model_used?: string;
  error?: string;
}

const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const TIME_RE = /^(\d{1,2}):(\d{1,2})$/;

/** 校验并规整日期/时刻（LLM 返回值不可信）；非法返回 null */
function normalizeDateTime(date: unknown, time: unknown): { date: string; time?: string } | null {
  const dm = typeof date === 'string' ? date.trim().match(DATE_RE) : null;
  if (!dm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const d = Number(dm[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;

  const out: { date: string; time?: string } = {
    date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  };
  const tm = typeof time === 'string' ? time.trim().match(TIME_RE) : null;
  if (tm) {
    const h = Number(tm[1]);
    const mi = Number(tm[2]);
    if (h <= 23 && mi <= 59) out.time = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  return out;
}

/** 当前本地时间（含星期与时区偏移），作为相对时间解析锚点 */
function nowAnchor(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` +
    `（${week}，UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}）`
  );
}

/** LLM 解析：要求严格 JSON；JSON 不合法时重试 1 次 */
async function callModelForTime(
  cfg: { model: string; apiKey: string; baseUrl: string },
  userText: string,
  attempt: number = 1,
): Promise<{ found: boolean; date?: string; time?: string; topic?: string }> {
  const SYSTEM_PROMPT = `你是日程时间解析助手。用户给出了一条待办/日程文本，请提取其中表示的「事件开始时间」，并把事项本身整理成主题。

当前系统本地时间（解析相对时间的锚点）：${nowAnchor()}

只返回严格 JSON（不要 markdown 代码块，不要任何其他文字）：
{
  "found": true,
  "date": "YYYY-MM-DD（本地日期）",
  "time": "HH:MM（24 小时制本地时刻；文本只说了日期、没给具体时刻时留空字符串 \\"\\"）",
  "topic": "事项主题：把原文里的日期/时刻表达剔除后剩下的内容，保持原措辞，不要改写、不要补充"
}

规则：
1. 相对时间一律以锚点为基准换算成绝对日期：今天/明天/后天/大后天/下周X/本周X/N天后 等；「周五」「周三」若在本周已过，指下周同一周几。
2. 只有日期没有时刻 → time 留空字符串。
3. 只有时刻没有日期 → date 取锚点当天；若该时刻已过则取次日。
4. 文本完全没有时间信息（如「写完报告」「跟张三对接」）→ found=false，date/time/topic 留空。
5. 严禁臆造：文本没提时间就不要编。
6. 时间表达可能混在事项描述中间（如「明天下午3点跟张三开会」「先看材料，周一上午10点汇报」）。
7. topic 必须剔除全部日期/时刻词（含「明天」「下午3点」「上午」这类），但不丢事项本身与其它信息（人名、地点等）；剔除后为空则留空字符串；多个事项时保留全部非时间内容。
只返回 JSON。`;

  const userPrompt = `待办文本：
--- 输入开始 ---
${userText}
--- 输入结束 ---
请只返回 JSON。`;

  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  const payload: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  };
  let resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  // 网关不支持 json_object（400/404）时降级为纯文本提示（与 schedule-parse 同一约定）
  if (resp.status === 400 || resp.status === 404) {
    delete payload.response_format;
    resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Model call failed (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content: string =
    data?.choices?.[0]?.message?.content || data?.choices?.[0]?.delta?.content || '';

  let cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    if (attempt < 2) return callModelForTime(cfg, userText + '\n\n（提示：上一次返回的不是合法 JSON，请只输出 JSON 文本）', attempt + 1);
    throw new Error('Model response is not valid JSON');
  }

  const topic = typeof parsed.topic === 'string' ? parsed.topic.trim().slice(0, 200) : '';
  return {
    found: parsed.found === true,
    date: typeof parsed.date === 'string' ? parsed.date : undefined,
    time: typeof parsed.time === 'string' ? parsed.time : undefined,
    topic: topic || undefined,
  };
}

export async function POST(req: NextRequest) {
  try {
    let text = '';
    try {
      const body = await req.json();
      text = String(body?.text ?? '').trim();
    } catch {
      text = '';
    }
    if (!text) {
      return NextResponse.json({ success: false, error: 'Missing text (body.text)' }, { status: 400 });
    }
    if (text.length > 2000) {
      return NextResponse.json({ success: false, error: 'Text too long (max 2000 chars)' }, { status: 400 });
    }

    // 1) 正则快路径：常见表达零延迟、零成本（覆盖绝大多数待办）
    const fast = parseTodoTime(text);
    if (fast) {
      const result: ParsedTimeResponse = {
        success: true,
        source: 'regex',
        date: fast.date,
        time: fast.time,
        topic: fast.topic,
      };
      return NextResponse.json(result);
    }

    // 2) LLM 回退：任意自然表达（「下周三下午跟客户过方案」等）
    const cfg = await resolveTaskModel();
    if (!cfg) {
      return NextResponse.json({ success: false, error: 'No model configured' });
    }
    const r = await callModelForTime(cfg, text);
    if (!r.found) {
      return NextResponse.json({ success: false, error: 'No time expression found' });
    }
    const norm = normalizeDateTime(r.date, r.time);
    if (!norm) {
      return NextResponse.json({ success: false, error: 'Model returned an invalid date' });
    }
    const result: ParsedTimeResponse = {
      success: true,
      source: 'llm',
      model_used: cfg.model,
      date: norm.date,
      time: norm.time,
      topic: r.topic,
    };
    return NextResponse.json(result);
  } catch (e: unknown) {
    console.error('sticky-notes/parse-time error:', e);
    const msg = e instanceof Error ? e.message : 'Time parse failed';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
