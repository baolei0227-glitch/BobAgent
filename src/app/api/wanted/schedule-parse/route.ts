import { NextRequest, NextResponse } from 'next/server';
import { resolveTaskModel } from '@/lib/wanted/task-model';

/**
 * /api/wanted/schedule-parse — 用 LLM 把自然语言查询解析成查询时间范围。
 *
 * 调用方：/todo check 子命令（query_text）与日程查询统一管线
 * （lib/wanted/schedule.ts resolveReadCalendarQuery）。
 * 正则快路径（lib/wanted/schedule.ts parseScheduleInput）解析失败时回退到本接口，
 * 让用户可以用自己的语言描述查询目标（如 "最近三天"、"下周五之前"、"这个月的会"），
 * 不再受固定用语限制。
 *
 * 返回：
 *   success + overdue=true                    → 查已过期待办
 *   success + rangeStart/rangeEnd             → 查指定时间范围（UTC ISO）
 *   success=false                             → 无法识别时间（含 AI 不可用/解析失败）
 */

interface ScheduleParseResult {
  success: boolean;
  label?: string;
  rangeStart?: string;
  rangeEnd?: string;
  overdue?: boolean;
  keyword?: string;
  allTime?: boolean;
  error?: string;
  model_used?: string;
}

/** 模型返回的原始时间范围 JSON（未经校验，字段可能缺失） */
interface RawRangeJson {
  label?: string;
  range_start?: string;
  range_end?: string;
  overdue?: boolean;
  keyword?: string;
  all_time?: boolean;
  unclear?: boolean;
}

/** 系统当前时间（UTC ISO），作为相对时间解析锚点 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 调用 LLM 解析时间范围，要求严格 JSON；失败自动重试 1 次 */
async function callModelForRange(
  cfg: { model: string; apiKey: string; baseUrl: string },
  userText: string,
  attempt: number = 1,
): Promise<{ label?: string; rangeStart?: string; rangeEnd?: string; overdue: boolean; keyword?: string; allTime?: boolean; unclear: boolean }> {
  const SYSTEM_PROMPT = `你是日程查询助手。用户的输入是一句"想查询哪些日程/待办"的自然语言描述（可能是按时间、也可能是按内容主题，如公司名/人名/项目/事项）。
当前系统时间（锚点，用于解析相对时间）：${nowIso()}
你的任务：把描述解析成查询条件，输出严格的 JSON（不要 markdown 代码块，只返回纯 JSON）：
{
  "label": "简短的人类可读标签，如 \"今天\"、\"最近3天\"、\"8/1 - 8/7\"、\"华为公司\"、\"所有待办\"",
  "range_start": "查询起点，ISO 8601（UTC）字符串；无法确定则为空字符串 \\"\\"",
  "range_end": "查询终点，ISO 8601（UTC）字符串；无法确定则为空字符串 \\"\\"",
  "overdue": false,
  "keyword": "按内容搜索的关键词（2-8字，只取最可能出现在事件标题里的短词，优先公司/人名/项目名等实体，其次事项关键词；不是按内容查询则为空字符串 \\"\\"）",
  "all_time": false,
  "unclear": false
}

解析规则：
1. 按时间解析（含任意自然表达，包括但不限于）：今天/今日/明天/明日/后天/昨天/本周/这周/下周/上周/本月/下月/最近N天/最近一周/这半个月/下周五之前/8月1日到8月7日/8月1日至8月7日/周末/今年上半年/这个季度/这两天/下个月初 等。
   - "X之前"（如 下周五之前、8月8日之前）→ range_start 取足够早的过去（1970-01-01T00:00:00Z），range_end 取 X 当天的结束时刻（即 X+1 天的 00:00Z，排他终点）
   - "X之后/X起" → range_start 取 X 当天 00:00 UTC，range_end 取足够远的未来（2100-01-01T00:00:00Z）
   - "最近N天" → range_start = 今天往前 N-1 天的 00:00 UTC，range_end = 明天 00:00 UTC
   - 单日（如 8月8日、下周三、周六）→ 当日 00:00 UTC 起、次日 00:00 UTC 止
   - "所有/全部 待办/日程/事件"（含"所有过往/历史/过去"）→ all_time=true（全部时间）；若明确"过往/历史/过去"，则 range_start=1970-01-01T00:00:00Z、range_end=当前时刻
   - "最近待办/最近" → range_start=7 天前 00:00 UTC，range_end=明天 00:00 UTC
2. 按内容主题解析：输入是公司名/人名/项目名/事项等主题词（如"华为公司"、"华为公司起草合同"、"解决纠纷"、"起草合同"、"给张三发邮件"）→ keyword 只提取最可能出现在事件标题里的短实体词（2-8字）：优先公司/人名/项目名（如"华为公司起草合同"→"华为公司"、"给张三发邮件"→"张三"），没有实体时取事项关键词（如"起草合同"、"解决纠纷"）；不要输出完整句子。带时间+主题（如"本周华为合同"）→ keyword 与 range 同时给出。
3. "已过期/过期/逾期/超期/overdue" → overdue=true，忽略其他字段。
4. 范围起止均以 UTC 计算；保证 range_start < range_end。
5. 无法确定任何信息（如只有"看一下"、"全部"）→ unclear=true，其余字段留空。
只返回 JSON。`;

  const userPrompt = `请解析以下查询的时间范围并返回严格 JSON：
--- 输入开始 ---
${userText}
--- 输入结束 ---
请只返回 JSON，不要加任何其他文字。`;

  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  // item 5：结构化输出——json_object 约束严格 JSON，消除格式漂移与"解析失败重试"；
  // 网关不支持该参数（400/404）时降级为纯文本提示重试，行为与原逻辑一致
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
  if (resp.status === 400 || resp.status === 404) {
    delete payload.response_format;
    resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content: string =
    data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.delta?.content
    || '';

  // 提取 JSON：先移除 markdown 代码块，再查找 JSON 对象
  let cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }

  let parsed: RawRangeJson;
  try {
    parsed = JSON.parse(cleaned) as RawRangeJson;
  } catch (e) {
    if (attempt < 2) {
      return callModelForRange(cfg, userText + `\n\n（提示：上一次返回的不是合法 JSON，请只输出 JSON 文本）`, attempt + 1);
    }
    throw new Error('Model response could not be parsed as JSON, please retry');
  }

  return {
    label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : undefined,
    rangeStart: typeof parsed.range_start === 'string' && parsed.range_start.trim() ? parsed.range_start.trim() : undefined,
    rangeEnd: typeof parsed.range_end === 'string' && parsed.range_end.trim() ? parsed.range_end.trim() : undefined,
    overdue: parsed.overdue === true,
    keyword: typeof parsed.keyword === 'string' && parsed.keyword.trim() ? parsed.keyword.trim() : undefined,
    allTime: parsed.all_time === true,
    unclear: parsed.unclear === true,
  };
}

export async function POST(req: NextRequest) {
  try {
    let text: string;
    try {
      const body = await req.json();
      text = String(body.text || '').trim();
    } catch {
      text = '';
    }
    if (!text) {
      return NextResponse.json({ success: false, error: 'Missing query text (body.text)' }, { status: 400 });
    }
    if (text.length > 2000) {
      return NextResponse.json({ success: false, error: 'Query text too long (max 2000 chars)' }, { status: 400 });
    }

    const cfg = await resolveTaskModel();
    if (!cfg) {
      return NextResponse.json(
        { success: false, error: 'No model configured. Please configure a model in Settings before using schedule queries.' },
        { status: 400 },
      );
    }

    const r = await callModelForRange(cfg, text);
    const result: ScheduleParseResult = { success: true, model_used: cfg.model };
    if (r.overdue) {
      result.overdue = true;
      result.label = r.label || 'Overdue';
    } else if (r.keyword) {
      // 按内容关键词搜索；带时间则缩小范围，否则默认全部历史
      result.keyword = r.keyword;
      result.label = r.label || r.keyword;
      if (r.rangeStart && r.rangeEnd) {
        result.rangeStart = r.rangeStart;
        result.rangeEnd = r.rangeEnd;
      } else if (r.allTime) {
        result.allTime = true;
      }
    } else if (r.rangeStart && r.rangeEnd && !r.unclear) {
      result.rangeStart = r.rangeStart;
      result.rangeEnd = r.rangeEnd;
      result.label = r.label || 'Range';
    } else {
      return NextResponse.json({ success: false, error: 'Could not recognize a query from the description' });
    }
    return NextResponse.json(result);
  } catch (e) {
    console.error('wanted/schedule-parse error:', e);
    return NextResponse.json({ success: false, error: e instanceof Error && e.message ? e.message : 'Time parse failed' }, { status: 500 });
  }
}
