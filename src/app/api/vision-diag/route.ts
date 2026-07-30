import { NextRequest, NextResponse } from 'next/server';
import { readSettingsFromFile } from '@/lib/settings-server';

/** 视觉模型配置诊断端点：返回服务端实际读取到的视觉设置和解析结果 */
export async function GET(_req: NextRequest) {
  const settings = await readSettingsFromFile();
  const vision = settings.vision || {};

  // 模拟 resolveVisionConfig
  const resolved: { level: string; model?: string; hasKey: boolean; baseUrl?: string } | null = (() => {
    if (vision.defaultModel && vision.apiKey) {
      return { level: '1.primary', model: vision.defaultModel, hasKey: true, baseUrl: vision.baseUrl || undefined };
    }
    if (vision.apiKey && !vision.defaultModel) {
      for (const p of settings.providers || []) {
        if (!p.selectedModels?.length) continue;
        const v = p.selectedModels.find(m =>
          ['vl', 'vision', '-4o', '4o-', 'gemini', 'claude', 'glm-4v', 'glm-4-plus', 'doubao-vision'].some(kw => m.modelId.toLowerCase().includes(kw))
        );
        if (v) return { level: '1.5.key-no-model', model: v.modelId, hasKey: true, baseUrl: vision.baseUrl || undefined };
      }
    }
    if (vision.auxiliaryModel && vision.auxiliaryApiKey) {
      return { level: '2.auxiliary', model: vision.auxiliaryModel, hasKey: true, baseUrl: vision.auxiliaryBaseUrl || undefined };
    }
    for (const p of settings.providers || []) {
      if (!p.apiKey?.trim() || !p.selectedModels?.length) continue;
      const v = p.selectedModels.find(m =>
        ['vl', 'vision', '-4o', '4o-', 'gemini', 'claude', 'glm-4v', 'glm-4-plus', 'doubao-vision'].some(kw => m.modelId.toLowerCase().includes(kw))
      );
      if (v) return { level: '3.chat-provider', model: v.modelId, hasKey: true };
    }
    return null;
  })();

  return NextResponse.json({
    success: true,
    visionRaw: {
      defaultModel: vision.defaultModel || null,
      hasApiKey: !!vision.apiKey,
      apiKeyLen: vision.apiKey?.length || 0,
      apiKeyPreview: vision.apiKey ? vision.apiKey.slice(0, 10) + '...' : null,
      baseUrl: vision.baseUrl || null,
      hasAuxModel: !!vision.auxiliaryModel,
      hasAuxKey: !!vision.auxiliaryApiKey,
    },
    resolved,
    providers: (settings.providers || []).map(p => ({
      type: p.type,
      hasKey: !!p.apiKey,
      models: (p.selectedModels || []).map(m => m.modelId),
      visionCandidates: (p.selectedModels || []).filter(m =>
        ['vl', 'vision', '-4o', '4o-', 'gemini', 'claude', 'glm-4v', 'glm-4-plus', 'doubao-vision'].some(kw => m.modelId.toLowerCase().includes(kw))
      ).map(m => m.modelId),
    })),
  });
}
