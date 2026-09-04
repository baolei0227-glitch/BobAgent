/**
 * /api/ai-generate/illust-prompt — 根据卡片内容自动生成结构化插画提示词
 *
 * 输入：卡片内容（问题/回答/标题/要点/标签/正文）+ 插画风格
 * 输出：一段可直接用于文生图的中文插画提示词（纯文本）
 *
 * 模型来源：复用「设置 → 模型 → 对话模型」（chatModel），不新增配置项。
 * 语言模型比图像模型更懂文案，用默认对话模型即可；不可用时回退到第一个启用 provider。
 */
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { readSettingsFromFile } from '@/lib/settings-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IllustPromptRequest {
  question?: string;
  answer?: string;
  title?: string;
  points?: string[];
  tags?: string[];
  body?: string;
  /** 插画风格中文名（如 治愈手绘 / 扁平插画），由前端传入便于生成贴合风格的提示词 */
  styleLabel?: string;
  /** 可选覆盖模型（provider:modelId 或裸 modelId） */
  model?: string;
}

/** 从 settings 解析对话模型配置：chatModel 优先，回退第一个启用 provider */
async function resolveChatConfig(modelHint?: string): Promise<{ apiKey: string; baseURL: string; models: string[] } | null> {
  const settings = await readSettingsFromFile();
  const chat = settings.chatModel as {
    defaultProvider?: string; defaultModel?: string; apiKey?: string; baseUrl?: string;
    pool?: Array<{ provider: string; modelId: string }>;
  } | undefined;
  const models: string[] = [];
  const push = (id?: string | null) => {
    const t = id?.trim();
    if (t && !models.includes(t)) models.push(t);
  };
  push(modelHint);
  push(chat?.defaultModel);
  (chat?.pool ?? []).forEach((p) => push(p.modelId));

  const cfg = (chat?.apiKey && chat?.baseUrl)
    ? { apiKey: chat.apiKey, baseURL: chat.baseUrl }
    : null;
  if (!cfg) {
    // 回退：第一个可用 provider（与 /api/chat 压缩模型同款优先级）
    for (const p of settings.providers ?? []) {
      if (!p.apiKey || !p.baseUrl) continue;
      const sel = (p.selectedModels ?? []).find((s) => (typeof s === 'string' ? s : s.modelId));
      const m = typeof sel === 'string' ? sel : sel?.modelId;
      if (m) {
        push(m);
        return { apiKey: p.apiKey, baseURL: p.baseUrl, models };
      }
    }
    return null;
  }
  return { ...cfg, models };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as IllustPromptRequest;
    const { question = '', answer = '', title = '', points = [], tags = [], body: bodyText = '', styleLabel = '' } = body;

    const contentText = [
      `标题：${title || question || '（无）'}`,
      points.length ? `要点：${points.filter(Boolean).join('；')}` : '',
      tags.filter(Boolean).length ? `标签：${tags.filter(Boolean).join('、')}` : '',
      answer.trim() ? `正文摘要：${answer.trim().slice(0, 500)}` : '',
      bodyText.trim() ? `正文：${bodyText.trim().slice(0, 500)}` : '',
    ].filter(Boolean).join('\n') || '（无内容）';

    const system = `你是小红书知识卡片的插画提示词专家。根据卡片内容，生成一段可直接用于文生图模型的中文插画提示词。
要求：
- 画面主体：提炼卡片主题，给出一个具体具象的形象或场景（避免抽象词）
- 构图：主体居中、四周留白充足，用于卡片底部装饰区
- 配色：明亮治愈、贴合小红书风格
- 风格：${styleLabel || '治愈手绘'}，画面干净
- 氛围：温暖、有情绪感染力
- 80~150 字，只输出提示词正文本身，不要标题、引号、解释或序号`;

    const config = await resolveChatConfig(body.model);
    if (!config || config.models.length === 0) {
      return Response.json(
        { success: false, error: '未配置对话模型，请先在 设置 → 模型 中配置对话模型与 API Key' },
        { status: 400 },
      );
    }

    const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    let prompt = '';
    let lastError: unknown = null;
    for (const model of config.models) {
      try {
        const resp = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `卡片内容：\n${contentText}` },
          ],
          temperature: 0.8,
          max_tokens: 400,
        });
        prompt = resp.choices?.[0]?.message?.content?.trim() || '';
        if (prompt) break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!prompt) {
      throw lastError ?? new Error('模型未返回提示词');
    }

    return Response.json({ success: true, prompt, model: config.models[0] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
}
