import { NextRequest, NextResponse } from 'next/server';
import { PROVIDER_PRESETS } from '@/lib/types';
import { readSettingsFromFile } from '@/lib/settings-server';

/** 前端期望的任务结构 */
interface SummarizedTask {
  title: string;
  start_time: string;      // ISO 8601
  end_time?: string | null;
  all_day: boolean;
  priority?: 'high' | 'normal' | 'low';
  category_path?: string[];  // 主题层级分类，最多3级，如 ["工作", "项目A", "前端"]
  description?: string;      // 模型补充说明
  source_raw?: string;       // 对应的原始文本片段
}

interface SummarizeResponse {
  success: boolean;
  tasks: SummarizedTask[];
  ambiguous_items?: string[];   // 无法解析的条目，提示用户确认
  model_used?: string;
  raw_text?: string;            // 调试用（可选）
}

/** 系统当前时间（ISO），用于相对时间解析的锚点 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 从 settings 中解析 Wanted 模型配置，若未配置则降级到可用的普通聊天模型 */
async function resolveTaskModel(): Promise<{ model: string; apiKey: string; baseUrl: string } | null> {
  const settings = await readSettingsFromFile();

  // 1) 优先用用户配置的任务归纳小模型
  const tm = settings.taskModel || {};
  if (tm.apiKey && tm.defaultModel) {
    const providerType = (tm.defaultProvider as any) || tm.defaultModel.includes('deepseek')
      ? 'deepseek'
      : tm.defaultModel.includes('glm') ? 'glm'
      : tm.defaultModel.includes('moonshot') ? 'moonshot'
      : tm.defaultModel.includes('qwen') ? 'qwen'
      : tm.defaultModel.includes('doubao') ? 'doubao'
      : 'openai';
    const baseUrl = tm.baseUrl
      || PROVIDER_PRESETS.find((p) => p.type === providerType)?.baseUrl
      || PROVIDER_PRESETS[0].baseUrl;
    return {
      model: tm.defaultModel,
      apiKey: tm.apiKey,
      baseUrl,
    };
  }

  // 2) 降级：使用已配置的普通 chat 模型中的第一个
  for (const prov of settings.providers) {
    if (prov.apiKey && prov.selectedModels && prov.selectedModels.length > 0) {
      const firstChat = prov.selectedModels.find((s) => !s.modelId.match(/vision|vl|embedding|rerank|audio/i))
        || prov.selectedModels[0];
      const preset = PROVIDER_PRESETS.find((p) => p.type === prov.type);
      return {
        model: firstChat.modelId,
        apiKey: prov.apiKey,
        baseUrl: preset?.baseUrl || PROVIDER_PRESETS[0].baseUrl,
      };
    }
  }

  return null;
}

/** 调用 LLM，要求严格 JSON 输出；失败自动重试 1 次 */
async function callModelForTasks(
  cfg: { model: string; apiKey: string; baseUrl: string },
  userText: string,
  attempt: number = 1,
): Promise<{ tasks: SummarizedTask[]; ambiguous_items: string[] }> {
  const SYSTEM_PROMPT = `你是一个任务规划助手。你的任务是将用户粘贴的一段原始文本（会议记录、待办事项、聊天记录、日程邮件等）
解析并拆分为结构化的待办/日程条目，输出严格的 JSON 格式。

当前系统时间（锚点，用于解析相对时间）：${nowIso()}

输出 JSON 格式要求（不要包含 markdown 代码块标记，只返回纯 JSON）：
{
  "tasks": [
    {
      "title": "简短任务标题，不超过20字",
      "start_time": "ISO 8601格式的绝对时间，如 2026-07-29T14:00:00+08:00。全日任务填当天的09:00",
      "end_time": "ISO 8601格式或null（未指定结束时间）",
      "all_day": true 或 false,
      "priority": "high" | "normal" | "low",
      "category_path": ["一级主题", "二级主题", "三级主题"] 最多3级，按任务所属领域/项目/模块归纳，如 ["工作", "项目Alpha", "前端"]、["生活", "健康"]、["学习"]。时间/地点不作为分类依据，
      "description": "模型补充的说明（选填），或原始文本对应片段",
      "source_raw": "该任务对应的原始文本片段（尽可能完整保留）"
    }
  ],
  "ambiguous_items": [
    "无法可靠识别时间或内容的条目原文，让用户手动确认"
  ]
}

解析规则：
1. 识别时间：
   - 绝对日期：如 "7月30日" → 当年当月当日；"2026/8/1" 对应绝对日期
   - 相对日期："今天"/"今天晚上" → 锚点日期；"明天" → +1天；"后天" → +2天
   - 星期："下周一"/"周三" → 最近的那一天
   - 时间："3点"/"15:00"/"下午3点半" 都解析为 24 小时制
   - 如 "下午3点到4点半" → start=15:00, end=16:30
   - 只有日期没有具体时间 → 视为全天任务（all_day=true）
   - 完全没有任何时间线索 → 放入 ambiguous_items
2. 任务拆分：按"动词+目标"拆分，避免一条任务内混杂多个不同动作。
3. 优先级：含"紧急/重要/尽快/截止/马上"等高优先级关键词 → high；
   含"有时间/有空/顺便"等低优先级关键词 → low；其余 normal。
4. 标题要简洁，不要写"任务1"、"Todo"等无意义前缀；使用中文动词开头更清晰。
5. 主题分类（category_path）：根据任务内容推断所属领域/项目/模块层级，最多3级。
   时间、地点、人名不作为分类依据。如无明确主题填 ["其他"]。
6. 保持原文的意图，不要过度脑补细节；不确定的信息放入 ambiguous_items 而不是编造。`;

  const userPrompt = `请将以下原始文本解析为结构化任务，并返回严格 JSON：

--- 原始文本开始 ---
${userText}
--- 原始文本结束 ---

请只返回 JSON，不要加任何其他文字。重要：必须返回原始文本中识别到的所有任务，不要遗漏任何一条。tasks 数组中应包含每一条可识别的任务。`;

  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content: string =
    data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.delta?.content
    || '';

  // 提取 JSON：先尝试移除 markdown 代码块，再查找 JSON 对象
  let cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  // 如果仍有包装文字，尝试提取第一个 { 到最后一个 } 之间的内容
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    if (attempt < 2) {
      return callModelForTasks(cfg, userText + `\n\n（提示：上一次返回的不是合法 JSON，请只输出 JSON 文本，不要 markdown 或其他说明）`, attempt + 1);
    }
    throw new Error('模型返回内容无法解析为 JSON，请重试或缩短文本');
  }

  // 基本校验 + 补全
  const tasks: SummarizedTask[] = [];
  const ambiguous: string[] = [];
  const rawTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  for (const t of rawTasks) {
    const title = String(t.title || '').trim();
    if (!title) continue;
    const startTime = String(t.start_time || '').trim();
    if (!startTime) {
      ambiguous.push(title + (t.source_raw ? `（原文：${t.source_raw}）` : ''));
      continue;
    }
    tasks.push({
      title,
      start_time: startTime,
      end_time: t.end_time ?? null,
      all_day: t.all_day === true || t.all_day === 'true',
      priority: (t.priority === 'high' || t.priority === 'low') ? t.priority : 'normal',
      category_path: Array.isArray(t.category_path) ? t.category_path.slice(0, 3).filter((s: any) => typeof s === 'string' && s.trim()) : undefined,
      description: t.description ?? undefined,
      source_raw: t.source_raw ?? undefined,
    });
  }
  if (Array.isArray(parsed?.ambiguous_items)) {
    for (const it of parsed.ambiguous_items) {
      const s = String(it || '').trim();
      if (s) ambiguous.push(s);
    }
  }
  return { tasks, ambiguous_items: ambiguous };
}

export async function POST(req: NextRequest) {
  try {
    let rawText: string;
    try {
      const body = await req.json();
      rawText = String(body.text || body.content || '').trim();
    } catch {
      rawText = '';
    }
    if (!rawText) {
      return NextResponse.json(
        { success: false, error: '缺少待解析的文本内容（body.text）' },
        { status: 400 },
      );
    }
    if (rawText.length > 20000) {
      return NextResponse.json(
        { success: false, error: '文本过长，请拆分后重新上传（单次不超过 20000 字）' },
        { status: 400 },
      );
    }

    const cfg = await resolveTaskModel();
    if (!cfg) {
      return NextResponse.json(
        { success: false, error: '尚未配置任何模型。请在【设置 → Wanted】中配置，或至少配置一个聊天模型。' },
        { status: 400 },
      );
    }

    const { tasks, ambiguous_items } = await callModelForTasks(cfg, rawText);

    const result: SummarizeResponse = {
      success: true,
      tasks,
      ambiguous_items,
      model_used: cfg.model,
    };
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('tasks/summarize error:', e);
    return NextResponse.json(
      { success: false, error: e?.message || '任务归纳失败' },
      { status: 500 },
    );
  }
}
