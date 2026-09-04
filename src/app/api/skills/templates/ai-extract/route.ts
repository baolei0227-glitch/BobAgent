import { NextRequest, NextResponse } from 'next/server';
import { resolveTaskModel } from '@/lib/wanted/task-model';

/**
 * /api/skills/templates/ai-extract — 用 LLM 从粘贴文本中抽取模板字段值（顺丰式智能粘贴识别）。
 *
 * 调用方：templates 面板的「智能粘贴识别区」。用户在面板选好模板/字段后，
 * 粘贴一段信息文本（如 AI 回复里解析出的当事人信息），点击识别填充，
 * 本接口把文本中的信息抽取到每个字段，前端再回填到当前展开行。
 *
 * 请求：{ fields: [{ key, label }], text }
 * 返回：{ success: true, values: { [key]: value } } 或 { success: false, error }
 */
interface ExtractField {
  key: string;
  label?: string;
}

async function callModelForExtract(
  cfg: { model: string; apiKey: string; baseUrl: string },
  fields: ExtractField[],
  text: string,
): Promise<Record<string, string>> {
  const fieldSpec = fields
    .map((f, i) => `${i + 1}. "${f.key}"${f.label ? `（含义：${f.label}）` : ''}`)
    .join('\n');

  const SYSTEM_PROMPT = `你是信息抽取助手。用户粘贴了一段文本，请从中抽取指定字段的值。
严格规则：
1. 输出严格 JSON 对象（不要 markdown 代码块，只返回纯 JSON），键为字段 key，值为抽取到的字符串。
2. 只抽取文本中实际存在的信息，禁止编造、猜测、补全。
3. 某个字段在文本中找不到对应信息 → 该字段值为空字符串 ""。
4. 值保留原文（人名、证件号、日期、金额、地址等），不要改写、不要加单位、不要翻译。
5. 一个字段对应多个候选时，取最明确、最直接的一个。

字段列表：
${fieldSpec}

只返回 JSON。`;

  const userPrompt = `请从以下文本中抽取字段值并返回严格 JSON：
--- 文本开始 ---
${text}
--- 文本结束 ---
只返回 JSON 对象，不要加任何其他文字。`;

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
  if (resp.status === 400 || resp.status === 404) {
    // 网关不支持 response_format 时降级为纯文本提示
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

  let cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const f of fields) {
    const v = parsed[f.key];
    values[f.key] = typeof v === 'string' ? v : v == null ? '' : String(v);
  }
  return values;
}

export async function POST(req: NextRequest) {
  try {
    let body: { fields?: ExtractField[]; text?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const fields = Array.isArray(body.fields)
      ? body.fields.filter((f) => f && typeof f.key === 'string' && f.key.trim())
      : [];
    const text = String(body.text || '').trim();

    if (fields.length === 0) {
      return NextResponse.json({ success: false, error: 'Missing fields (body.fields)' }, { status: 400 });
    }
    if (!text) {
      return NextResponse.json({ success: false, error: 'Missing pasted text (body.text)' }, { status: 400 });
    }
    if (text.length > 20000) {
      return NextResponse.json({ success: false, error: 'Text too long (max 20000 chars)' }, { status: 400 });
    }

    const cfg = await resolveTaskModel();
    if (!cfg) {
      return NextResponse.json(
        { success: false, error: 'No model configured. Please configure a model in Settings before using AI fill.' },
        { status: 400 },
      );
    }

    const values = await callModelForExtract(cfg, fields, text);
    return NextResponse.json({ success: true, values });
  } catch (e: unknown) {
    console.error('skills/templates/ai-extract error:', e);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'AI extraction failed' },
      { status: 500 },
    );
  }
}
