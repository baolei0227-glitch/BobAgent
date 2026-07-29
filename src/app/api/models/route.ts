import { NextRequest, NextResponse } from 'next/server';

interface ModelsRequest {
  provider: string;
  apiKey: string;
  baseUrl?: string;
}

interface ProviderModelInfo {
  id: string;
  owned_by?: string;
}

export async function POST(request: NextRequest) {
  let body: ModelsRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { provider, apiKey, baseUrl } = body;

  if (!provider) {
    return NextResponse.json({ error: 'Missing provider' }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing apiKey' }, { status: 400 });
  }

  // 根据提供商确定 baseUrl
  const providerBaseUrls: Record<string, string> = {
    deepseek: 'https://api.deepseek.com',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    moonshot: 'https://api.moonshot.cn/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    openai: 'https://api.openai.com/v1',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  };

  const finalBaseUrl = (baseUrl || providerBaseUrls[provider] || '').replace(/\/+$/, '');

  if (!finalBaseUrl) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  }

  try {
    const response = await fetch(`${finalBaseUrl}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return NextResponse.json(
        { error: `API 返回 ${response.status}: ${errText.slice(0, 200)}` },
        { status: response.status }
      );
    }

    const data = await response.json();

    // OpenAI 兼容格式: { data: [{ id: "model-name", owned_by: "..." }] }
    const allModels: ProviderModelInfo[] = data.data || data.models || [];

    // 客观返回 API 提供的所有模型，不做主观过滤
    // 对非对话类模型标注 type 字段，让前端展示时可区分
    const NON_CHAT_PATTERNS = [
      { pattern: /embedding|bge-/i, type: 'embedding' },
      { pattern: /vision|vl-|多模态|visual|gpt-4o|claude-3[.\-]5|gemini.*(?:vision|pro|flash)|qvq|qwen.*vl|kimi-k[23]|glm-4v|step-1[vo]|janus|hunyuan.*(?:vision|vl)|yi-vision|gemma.*vision/i, type: 'vision' },
      { pattern: /tts|asr|whisper/i, type: 'audio' },
      { pattern: /dall-?e/i, type: 'image-gen' },
      { pattern: /moderation/i, type: 'moderation' },
      { pattern: /rerank/i, type: 'rerank' },
    ];

    // 先按正则做初步 thinking 判断（快速路径）
    const THINKING_PATTERN = /think|reason|r1|z1|k2[.\-]5|k2[.\-]6|k3|k2-thinking/i;

    const chatModels = allModels.map((m) => {
      const id = (m.id || '').toLowerCase();
      const nonChat = NON_CHAT_PATTERNS.find((p) => p.pattern.test(id));
      return {
        modelId: m.id,
        ownedBy: m.owned_by || '',
        thinking: THINKING_PATTERN.test(id),
        type: nonChat ? nonChat.type : 'chat',
      };
    });

    // 对 chat 模型实际探测是否支持 thinking（发送极简请求，检查 reasoning_content）
    // 仅对正则未识别为 thinking 的 chat 模型进行探测，避免不必要的请求
    const chatModelsToProbe = chatModels.filter(
      (m) => m.type === 'chat' && !m.thinking
    );

    if (chatModelsToProbe.length > 0 && chatModelsToProbe.length <= 15) {
      // 并行探测所有未识别的 chat 模型
      const probeResults = await Promise.allSettled(
        chatModelsToProbe.map(async (m) => {
          const probeResponse = await fetch(`${finalBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: m.modelId,
              messages: [{ role: 'user', content: '1+1=?' }],
              stream: false,
              max_tokens: 50,
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (!probeResponse.ok) {
            return { modelId: m.modelId, thinking: false };
          }

          const probeData = await probeResponse.json();
          const choice = probeData.choices?.[0];
          const message = choice?.message || {};
          // 如果返回了 reasoning_content 字段（即使为空字符串），说明模型支持思考
          const hasReasoning =
            typeof message.reasoning_content === 'string' &&
            message.reasoning_content !== '';
          return { modelId: m.modelId, thinking: hasReasoning };
        })
      );

      // 用探测结果更新 thinking 字段
      for (const result of probeResults) {
        if (result.status === 'fulfilled') {
          const model = chatModels.find((m) => m.modelId === result.value.modelId);
          if (model) {
            model.thinking = result.value.thinking;
          }
        }
      }
    }

    return NextResponse.json({ models: chatModels, total: chatModels.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `连接失败: ${message}` },
      { status: 500 }
    );
  }
}
