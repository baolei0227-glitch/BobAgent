/**
 * 文本 → 结构化任务（模型解析）共享内核（2026-09-21）。
 *
 * 调用方：
 *   - /api/tasks/summarize（/todo 指令、WANTED 面板 → lib/wanted/executor.ts）
 *   - lib/sticky-calendar-sync.ts（便签行自动入日历：与 /todo 同一口径，逐行 single=true 调用）
 *
 * 单任务模式（single=true）是便签与 /todo 的公共口径：一行/一条指令 = 恰好一个任务，
 * 保证「一行 ↔ 一个事件」一一对应，不需要按文本反查映射。
 * 模型不可用/解析失败由调用方各自降级（/todo 用默认时段兜底；便签退回正则+默认时段）。
 */

/** 解析出的任务结构 */
export interface SummarizedTask {
  title: string;
  start_time: string; // ISO 8601
  end_time?: string | null;
  all_day: boolean;
  priority?: 'high' | 'normal' | 'low';
  category_path?: string[]; // 主题层级分类，最多3级，如 ["工作", "项目A", "前端"]
  location?: string; // 地点（如会议室、地址等）
  /** 提前提醒分钟数（如 [1440] = 提前 1 天，可多个）；用户未提及提醒时**不返回该字段**
   *  （注意与空数组区分：空数组 = 明确关闭提醒，undefined = 按系统默认 30 分钟） */
  reminder_minutes?: number[];
  description?: string; // 模型补充说明
  source_raw?: string; // 对应的原始文本片段
}

/** 模型调用配置（resolveTaskModel 的产物） */
export interface TaskModelConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** 模型返回的单个任务 JSON（未经校验，字段可能缺失） */
interface ModelRawTask {
  title?: string;
  start_time?: string;
  end_time?: string | null;
  all_day?: boolean | string;
  priority?: string;
  category_path?: string[];
  location?: string;
  reminder_minutes?: number[];
  description?: string;
  source_raw?: string;
}

/** 模型返回的整体 JSON 载荷 */
interface ModelSummarizePayload {
  tasks?: ModelRawTask[];
  ambiguous_items?: string[];
}

/** 系统当前时间（ISO），用于相对时间解析的锚点 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 当前本地时间 + 1 小时（无时间待办的默认完成时间） */
export function oneHourLaterLocalIso(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 批量拆分模式的系统提示：解析并拆分为多个结构化待办/日程 */
function buildBulkSystemPrompt(): string {
  return `你是一个任务规划助手。你的任务是将用户粘贴的一段原始文本（会议记录、待办事项、聊天记录、日程邮件等）
解析并拆分为结构化的待办/日程条目，输出严格的 JSON 格式。

当前系统时间（锚点，用于解析相对时间）：${nowIso()}

你会把结果直接写进用户的日历事件：下面 JSON 里的字段就是日历事件的全部可填字段
（标题 / 开始时间 / 结束时间 / 全天 / 优先级 / 提前提醒 / 地点 / 主题分类 / 描述）。
用户提到的信息要尽量落到对应字段，不要一股脑塞进标题。

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
      "location": "任务地点。有地点信息时必须提取：会议室名称、物理地址、线上会议链接/平台等，如 "会议室A"、"Zoom链接"、"上海办公室"。没有明确地点信息时必须返回空字符串 "，不要省略该字段",
      "reminder_minutes": [提前提醒的分钟数，如 [1440] = 提前1天、[30] = 提前30分钟，可多个。用户没有提到提醒时，不要输出这个字段（不要输出空数组）],
      "description": "模型补充的说明或原始文本对应片段。默认保留该任务对应的原始文本片段（可精简，保留关键信息）；原文无其他内容时返回空字符串 "，不要省略该字段",
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
   - 完全没有任何时间线索 → 不丢弃：start_time 使用当前系统时间加 1 小时（即"创建后 1 小时到期"的默认待办时间），不要在 title/description 中标注时间未知
2. 任务拆分：按"动词+目标"拆分，避免一条任务内混杂多个不同动作。
3. 优先级：含"紧急/重要/尽快/截止/马上"等高优先级关键词 → high；
   含"有时间/有空/顺便"等低优先级关键词 → low；其余 normal。
4. 标题要简洁，不要写"任务1"、"Todo"等无意义前缀；使用中文动词开头更清晰。
5. 主题分类（category_path）：根据任务内容推断所属领域/项目/模块层级，最多3级。
   时间、地点、人名不作为分类依据。如无明确主题填 ["其他"]。
6. 地点识别（location）：从原文中提取任务的地点信息，包括会议室名称、物理地址、线上会议链接/平台等。
   如"在会议室A开会"→"会议室A"；"Zoom会议"→"Zoom"；"线下在上海办公室"→"上海办公室"。
   无地点信息则填空字符串""。
7. 保持原文的意图，不要过度脑补细节；不确定的信息放入 ambiguous_items 而不是编造。
8. 提前提醒（reminder_minutes）：用户说"提前 3 天提醒""提前一周提醒""提前半小时提醒"时，
   换算成分钟填入数组（1 天 = 1440，1 小时 = 60，1 周 = 10080），多个提前量就填多个。
   注意这是【提醒时间点】，不是事件开始时间：不要因为"提前 3 天提醒"就把 start_time 往前挪 3 天。
   用户没有提到提醒时不要输出该字段。`;
}

/** 单任务模式的系统提示：一条 /todo 指令只生成一个待办/日程，绝不拆分 */
function buildSingleSystemPrompt(): string {
  return `你是一个日历待办生成助手。用户输入的是一条 /todo 指令，代表【一个】待办/日程。
你必须把整段输入归纳为【恰好一个任务】输出，不要把内容拆分成多个任务。

当前系统时间（锚点，用于解析相对时间）：${nowIso()}

你会把结果直接写进用户的日历事件：下面 JSON 里的字段就是日历事件的全部可填字段
（标题 / 开始时间 / 结束时间 / 全天 / 优先级 / 提前提醒 / 地点 / 主题分类 / 描述）。
用户提到的信息要尽量落到对应字段，不要一股脑塞进标题。

输出 JSON（不要包含 markdown 代码块标记，只返回纯 JSON）：
{
  "tasks": [
    {
      "title": "简洁任务标题，不超过20字",
      "start_time": "ISO 8601格式的绝对时间，如 2026-07-29T14:00:00+08:00。全日任务填当天的09:00",
      "end_time": "ISO 8601格式或null（未指定结束时间）",
      "all_day": true 或 false,
      "priority": "high" | "normal" | "low",
      "category_path": ["一级主题", "二级主题", "三级主题"] 最多3级，按任务所属领域/项目/模块归纳，如 ["工作", "项目Alpha", "前端"]、["生活", "健康"]、["学习"]。时间/地点/人名不作为分类依据，
      "location": "任务地点。有地点信息时必须提取：会议室名称、物理地址、线上会议链接/平台等，如 "会议室A"、"Zoom链接"、"上海办公室"。没有明确地点信息时必须返回空字符串 "，不要省略该字段",
      "reminder_minutes": [提前提醒的分钟数，如 [1440] = 提前1天、[30] = 提前30分钟，可多个。用户没有提到提醒时，不要输出这个字段（不要输出空数组）],
      "description": "模型补充的说明或原始文本对应片段。默认保留该任务对应的原始文本片段（可精简，保留关键信息）；原文无其他内容时返回空字符串 "，不要省略该字段",
      "source_raw": "该任务对应的原始文本片段（尽可能完整保留）"
    }
  ],
  "ambiguous_items": []
}

解析规则：
1. 识别时间：
   - 绝对日期：如 "7月30日" → 当年当月当日；"2026/8/1" 对应绝对日期
   - 相对日期："今天"/"今天晚上" → 锚点日期；"明天" → +1天；"后天" → +2天
   - 星期："下周一"/"周三" → 最近的那一天
   - 时间："3点"/"15:00"/"下午3点半" 都解析为 24 小时制
   - 如 "下午3点到4点半" → start=15:00, end=16:30
   - 只有日期没有具体时间 → 视为全天任务（all_day=true）
   - 完全没有任何时间线索 → 不丢弃：start_time 使用当前系统时间加 1 小时（即"创建后 1 小时到期"的默认待办时间），不要在 title/description 中标注时间未知
2. 【关键】任务数量：整段输入只输出 1 个任务。即使原文包含多个动作（如"开会并整理纪要发给团队"）也只合成一条，把次要信息并入 title 或 description，绝不拆成多个 tasks。
3. 优先级：含"紧急/重要/尽快/截止/马上"等高优先级关键词 → high；
   含"有时间/有空/顺便"等低优先级关键词 → low；其余 normal。
4. 标题要简洁，不要写"任务1"、"Todo"等无意义前缀；使用中文动词开头更清晰。
5. 主题分类（category_path）：根据任务内容推断所属领域/项目/模块层级，最多3级。
   时间、地点、人名不作为分类依据。如无明确主题填 ["其他"]。
6. 地点识别（location）：从原文中提取任务的地点信息，包括会议室名称、物理地址、线上会议链接/平台等。
   如"在会议室A开会"→"会议室A"；"Zoom会议"→"Zoom"；"线下在上海办公室"→"上海办公室"。
   无地点信息则填空字符串""。
7. 保持原文的意图，不要过度脑补细节；不确定的信息并入 description 而非编造。
8. 提前提醒（reminder_minutes）：用户说"提前 3 天提醒""提前一周提醒""提前半小时提醒"时，
   换算成分钟填入数组（1 天 = 1440，1 小时 = 60，1 周 = 10080），多个提前量就填多个。
   注意这是【提醒时间点】，不是事件开始时间：不要因为"提前 3 天提醒"就把 start_time 往前挪 3 天。
   用户没有提到提醒时不要输出该字段。`;
}

/** 调用 LLM，要求严格 JSON 输出；失败自动重试 1 次 */
export async function parseTasksWithModel(
  cfg: TaskModelConfig,
  userText: string,
  single: boolean = false,
  attempt: number = 1,
): Promise<{ tasks: SummarizedTask[]; ambiguous_items: string[] }> {
  const SYSTEM_PROMPT = single ? buildSingleSystemPrompt() : buildBulkSystemPrompt();

  const userPrompt = single
    ? `请将以下输入解析为【恰好一个】结构化任务，并返回严格 JSON：

--- 原始文本开始 ---
${userText}
--- 原始文本结束 ---

请只返回 JSON，不要加任何其他文字。重要：只能输出 1 个任务（tasks 数组只含 1 项），不要拆分，不要遗漏内容。`
    : `请将以下原始文本解析为结构化任务，并返回严格 JSON：

--- 原始文本开始 ---
${userText}
--- 原始文本结束 ---

请只返回 JSON，不要加任何其他文字。重要：必须返回原始文本中识别到的所有任务，不要遗漏任何一条。tasks 数组中应包含每一条可识别的任务。`;

  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  // item 5：结构化输出——json_object 约束严格 JSON，消除格式漂移与"解析失败重试"；
  // 网关不支持该参数（400/404）时降级为纯文本提示重试，行为与原逻辑一致
  const payload: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0.3,
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

  let parsed: ModelSummarizePayload;
  try {
    parsed = JSON.parse(cleaned) as ModelSummarizePayload;
  } catch (e) {
    if (attempt < 2) {
      return parseTasksWithModel(cfg, userText + `\n\n（提示：上一次返回的不是合法 JSON，请只输出 JSON 文本，不要 markdown 或其他说明）`, single, attempt + 1);
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
    // 无时间线索的条目：用"当前时间 + 1 小时"兜底（默认 1 小时后完成），不再移入 ambiguous，避免内容丢失
    const startTime = String(t.start_time || '').trim() || oneHourLaterLocalIso();
    // 提前提醒：只接受正整数分钟，去重降序；模型没给（或给了空数组）→ undefined = 按系统默认，
    // 与「空数组 = 明确关闭提醒」的存储语义区分开。上限 30 天，避免模型产出无意义的超大提前量
    const reminderNums = (Array.isArray(t.reminder_minutes) ? t.reminder_minutes : [])
      .map((n) => Math.round(Number(n)))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= 30 * 1440);
    tasks.push({
      title,
      start_time: startTime,
      end_time: t.end_time ?? null,
      all_day: t.all_day === true || t.all_day === 'true',
      priority: (t.priority === 'high' || t.priority === 'low') ? t.priority : 'normal',
      category_path: Array.isArray(t.category_path) ? t.category_path.slice(0, 3).filter((s) => typeof s === 'string' && s.trim()) : undefined,
      location: typeof t.location === 'string' && t.location.trim() ? t.location.trim() : undefined,
      reminder_minutes: reminderNums.length > 0 ? [...new Set<number>(reminderNums)].sort((a, b) => b - a) : undefined,
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
  // 单任务模式硬性保证：只保留第一个任务，绝不返回多个
  if (single && tasks.length > 1) {
    tasks.length = 1;
  }
  return { tasks, ambiguous_items: ambiguous };
}