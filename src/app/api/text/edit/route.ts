import { NextRequest, NextResponse } from 'next/server';
import { PROVIDER_PRESETS } from '@/lib/types';
import { readSettingsFromFile } from '@/lib/settings-server';
import { executeTool, type ToolDefinition } from '../../chat/tools';

/** 从 settings 中解析 Text Edit 模型配置（优先），若未配置则降级到 Wanted 模型或普通聊天模型 */
async function resolveEditModel(): Promise<{ model: string; apiKey: string; baseUrl: string } | null> {
  const settings = await readSettingsFromFile();

  // 优先：独立 Text Edit 模型
  const te = settings.textEditModel || {};
  if (te.apiKey && te.defaultModel) {
    const providerType = (te.defaultProvider as string) || inferProvider(te.defaultModel);
    const baseUrl = te.baseUrl
      || PROVIDER_PRESETS.find((p) => p.type === providerType)?.baseUrl
      || PROVIDER_PRESETS[0].baseUrl;
    return { model: te.defaultModel, apiKey: te.apiKey, baseUrl };
  }

  // 降级 1：Wanted 模型
  const tm = settings.taskModel || {};
  if (tm.apiKey && tm.defaultModel) {
    const providerType = (tm.defaultProvider as string) || inferProvider(tm.defaultModel);
    const baseUrl = tm.baseUrl
      || PROVIDER_PRESETS.find((p) => p.type === providerType)?.baseUrl
      || PROVIDER_PRESETS[0].baseUrl;
    return { model: tm.defaultModel, apiKey: tm.apiKey, baseUrl };
  }

  // 降级 2：第一个可用聊天模型
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

function inferProvider(modelId: string): string {
  if (modelId.includes('deepseek')) return 'deepseek';
  if (modelId.includes('glm')) return 'glm';
  if (modelId.includes('moonshot')) return 'moonshot';
  if (modelId.includes('qwen')) return 'qwen';
  if (modelId.includes('doubao')) return 'doubao';
  return 'openai';
}

const EDIT_SYSTEM_PROMPT = `你是一个专业的文档编辑助手。你的任务是根据用户的修改指令，对提供的原文进行修改，并输出修改后的完整文本。

规则：
1. 只输出修改后的完整文本，不要输出任何解释、说明或 markdown 格式标记
2. 严格遵循用户的修改指令，只改需要改的部分，保持其他内容不变
3. 保持原文的语气风格和语言
4. 如果用户的指令是"精简"或"简洁"，请删除冗余表述但保留核心信息
5. 如果用户的指令是"润色"或"优化"，请改善表达但不改变原意
6. 不要添加原文中没有的内容

你可以使用以下工具来获取辅助信息（如查资料、查上游节点、查日历等），但最终必须直接输出编辑后的文本：
- web_search: 搜索网页信息
- read_file: 读取文件内容
- read_upstream_node: 读取上游连线节点的文档
- read_material: 读取项目资料
- read_calendar: 查询日历待办事项`;

/** 文本编辑可用的工具（只读、辅助型） */
const EDIT_TOOLS: ToolDefinition[] = [];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { selected_text, instruction, preset_prompt, current_result } = body;

    if (!selected_text || !instruction) {
      return NextResponse.json(
        { success: false, error: 'selected_text and instruction are required' },
        { status: 400 },
      );
    }

    const cfg = await resolveEditModel();
    if (!cfg) {
      return NextResponse.json(
        { success: false, error: 'No text edit model configured. Please set up Text Edit Model in Settings.' },
        { status: 400 },
      );
    }

    // 如果有 preset_prompt，用它拼接 system prompt
    const systemPrompt = preset_prompt
      ? `你是一个专业的文档编辑助手。${preset_prompt}\n\n只输出修改后的完整文本，不要任何解释。`
      : EDIT_SYSTEM_PROMPT;

    const userPrompt = current_result
      ? `--- 原文 ---\n${selected_text}\n--- 原文结束 ---\n\n--- 当前修改结果 ---\n${current_result}\n--- 当前结果结束 ---\n\n修改意见：${instruction}`
      : `--- 原文 ---\n${selected_text}\n--- 原文结束 ---\n\n修改指令：${instruction}`;

    const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';

    // 筛选编辑可用的工具
    const editToolNames = new Set(['web_search', 'read_file', 'read_upstream_node', 'read_material', 'read_calendar']);
    const availableTools = EDIT_TOOLS.length > 0 ? EDIT_TOOLS : [];
    // 延迟导入 tools 定义，避免循环依赖
    if (availableTools.length === 0) {
      const { TOOL_DEFINITIONS } = await import('../../chat/tools');
      availableTools.push(...TOOL_DEFINITIONS.filter(t => editToolNames.has(t.function.name)));
    }

    interface ChatMsg {
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    }

    const messages: ChatMsg[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const MAX_ROUNDS = 3;
    let editedText = '';

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const isLastRound = round === MAX_ROUNDS - 1;

      const reqBody: Record<string, unknown> = {
        model: cfg.model,
        temperature: 0.3,
        messages: isLastRound
          ? [...messages, { role: 'user', content: '请基于以上工具调用结果，直接输出修改后的完整文本，不要调用任何工具。' }]
          : messages,
      };

      if (!isLastRound && availableTools.length > 0) {
        reqBody.tools = availableTools;
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(reqBody),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return NextResponse.json(
          { success: false, error: `Model call failed (HTTP ${resp.status}): ${errText.slice(0, 200)}` },
          { status: 502 },
        );
      }

      const data = await resp.json();
      const msg = data?.choices?.[0]?.message;

      if (!msg) {
        return NextResponse.json({ success: false, error: 'Model returned empty response' }, { status: 502 });
      }

      // 有工具调用 → 执行并继续
      if (msg.tool_calls && msg.tool_calls.length > 0 && !isLastRound) {
        const toolCalls = msg.tool_calls as Array<{
          id: string; type: string; function: { name: string; arguments: string };
        }>;

        // 记录 assistant 消息（含 tool_calls）
        messages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });

        // 执行每个工具并添加结果
        for (const tc of toolCalls) {
          const result = await executeTool(tc.function.name, tc.function.arguments);
          messages.push({
            role: 'tool',
            content: result.result,
            tool_call_id: tc.id,
          });
        }
        continue;
      }

      // 无工具调用 → 提取编辑结果
      editedText = msg.content || '';
      if (editedText.trim()) break;
    }

    if (!editedText.trim()) {
      // 回退：直接请求不带工具的回答
      const fallbackResp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.3,
          messages: messages.slice(0, 2), // 只用 system + user
        }),
      });

      if (!fallbackResp.ok) {
        return NextResponse.json({ success: false, error: 'Model call failed' }, { status: 502 });
      }

      const fallbackData = await fallbackResp.json();
      editedText = fallbackData?.choices?.[0]?.message?.content || '';
    }

    if (!editedText.trim()) {
      return NextResponse.json(
        { success: false, error: 'Model returned empty content' },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, edited_text: editedText.trim() });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
