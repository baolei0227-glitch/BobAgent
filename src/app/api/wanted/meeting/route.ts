/**
 * POST /api/wanted/meeting
 *
 * /meeting 会议纪要整理：把一段会议累积内容（文本 + 媒体转写，带 [图片识别结果] 等类型标注）
 * 按 meeting-minutes schema 整理为结构化 Markdown 纪要，供 executor 发送 BobMail。
 *
 * 输出结构（参考 github/awesome-copilot meeting-minutes 的 Strict Minutes Schema，精简适配）：
 *   - 元数据：标题 / 时间 / 参与人（AI 从内容推断，不确定标「待确认」）
 *   - 讨论要点（按话题归纳）
 *   - 决策 / 结论
 *   - 行动项（负责人 + 时间；AI 推断，不确定标「待确认」）
 *   - 未解决项
 * 红线：只依据提供的内容，不编造参与人 / 决策 / 负责人；不确定信息标「待确认」，不自行脑补。
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveTaskModel } from '@/lib/wanted/task-model';

interface MeetingSummaryResponse {
  success: boolean;
  minutes?: string;
  model_used?: string;
  error?: string;
}

/** 当前系统时间（ISO），用于纪要时间锚点 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 调用 LLM 生成纪要（失败自动重试 1 次） */
async function callModelForMinutes(
  cfg: { model: string; apiKey: string; baseUrl: string },
  title: string,
  meetingText: string,
  attempt: number = 1,
): Promise<string> {
  const SYSTEM_PROMPT = `你是一名会议纪要整理助手。将用户提供的一段会议内容（含文字消息、语音转写、图片 OCR、文件提取文本，可能带 [图片识别结果] 等类型标注）整理成结构化 Markdown 会议纪要。

当前系统时间（锚点）：${nowIso()}

输出要求（严格遵循以下结构，用 Markdown，不要代码块包裹）：

## 会议纪要：${title || '未命名会议'}

**时间**：<会议时间段，从内容推断；推断不出写"待确认">
**参与人**：<从内容推断的与会者；推断不出写"待确认">

### 讨论要点
- 按话题归纳要点，逐条列出；语音/图片转写的内容注明来源（如「语音转写」「图片」）

### 决策 / 结论
- 明确写出的决定；无则写"无明确决策"

### 行动项
- [ ] 事项（负责人，时间）—— 负责人与时间从内容推断，推断不出写"待确认"

### 未解决项
- 悬而未决、需要跟进的问题；无则写"无"

铁律：
1. 只依据提供的内容整理，严禁编造参与人、决策、负责人、时间。
2. 内容里没有的信息一律写"待确认"或"无"，不要脑补。
3. 保留关键数字、日期、地点、金额等事实信息。`;

  const userPrompt = `会议标题：${title || '未命名会议'}\n\n--- 会议内容开始 ---\n${meetingText}\n--- 会议内容结束 ---\n\n请输出上述结构的会议纪要 Markdown。`;

  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  const payload: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  };
  const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`模型调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content: string =
    data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.delta?.content
    || '';
  const minutes = content
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!minutes) {
    if (attempt < 2) {
      return callModelForMinutes(cfg, title, meetingText, attempt + 1);
    }
    throw new Error('模型返回内容为空，请重试');
  }
  return minutes;
}

export async function POST(req: NextRequest) {
  try {
    let title = '';
    let meetingText = '';
    try {
      const body = await req.json();
      title = String(body.title || '').trim();
      meetingText = String(body.text || body.content || '').trim();
    } catch {
      meetingText = '';
    }
    if (!meetingText) {
      return NextResponse.json(
        { success: false, error: '缺少会议内容（body.text）' },
        { status: 400 },
      );
    }
    if (meetingText.length > 50000) {
      return NextResponse.json(
        { success: false, error: '会议内容过长，请拆分或精简后重试（单次不超过 50000 字）' },
        { status: 400 },
      );
    }

    const cfg = await resolveTaskModel();
    if (!cfg) {
      return NextResponse.json(
        { success: false, error: '尚未配置任何模型。请在【设置 → Models】中添加 API Key 并勾选聊天模型，或在【Role Assignment → Chat Model】把模型加入候选池。' },
        { status: 400 },
      );
    }

    const minutes = await callModelForMinutes(cfg, title, meetingText);
    const result: MeetingSummaryResponse = { success: true, minutes, model_used: cfg.model };
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '会议纪要整理失败';
    console.error('wanted/meeting error:', e);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 },
    );
  }
}
