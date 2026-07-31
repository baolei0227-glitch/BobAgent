import { homedir } from 'os';
import { NextRequest } from 'next/server';
import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import OpenAI from 'openai';
import {
  PROVIDER_PRESETS,
  type ProviderType,
  type ThinkingLevel,
  REASONING_EFFORT_MAP,
  SYSTEM_PROMPT_INJECTIONS,
} from '@/lib/types';
import { TOOL_DEFINITIONS, getToolDefinitions, registerCustomTools, registerMcpTools, executeTool, getToolSummary } from './tools';
import { getCurrentProject, buildVisionModelConfig } from '@/lib/project/project-manager';
import { parseImage } from '@/lib/parse/image-parser';
import { readSettingsFromFile } from '@/lib/settings-server';
import { applyPdfBridge } from '@/lib/pdf/bridge';
import { matchAndBuildContext } from '@/lib/skills';
import { matchSkills } from '@/lib/skills/matcher';
import { buildSkillContext } from '@/lib/skills/context';
import { getAllSkills } from '@/lib/skills/loader-server';
import { getEnabledSkillsForAgent, hasAgentConfig } from '@/lib/skills/registry-server';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** 基础系统提示（不包含思考指令） */
const BASE_SYSTEM_PROMPT = `你是一个能使用工具的智能助手，正在无限画布上的对话节点中与用户交流。回答简洁明了，适合在卡片中阅读。

回答格式说明：
- 你的回答会被渲染为 HTML 显示在卡片中。你可以直接使用 HTML 标签来美化排版，也可以使用 Markdown 语法（会自动转换）。
- 支持的 HTML 标签：<h1>-<h3>、<p>、<strong>、<em>、<ul>、<ol>、<li>、<blockquote>、<a>、<img>、<table>、<tr>、<td>、<th>、<hr>、<br>、<details>、<summary>、<code>、<pre>
- 支持的 Markdown 语法：# 标题、**粗体**、*斜体*、- 列表、> 引用、[链接](url)、![图片](url)、行内代码、代码块（三反引号包裹）
- 代码块请使用 Markdown 的三反引号语法，不要用 pre 标签
- 所有内容会经过安全过滤，危险的脚本和样式会被自动移除
- 不要使用 <script>、<style>、<iframe>、<object>、<embed> 等危险标签

IMPORTANT: 在回答的最末尾，请用以下格式添加一个对话标题建议：
<!-- TITLE: 简短标题（不超过20字） -->
标题应简洁概括本次对话的核心主题。不要将标题放在回答的其他位置，只在最后使用此 HTML 注释格式。回答正文中不要重复标题内容。

你可以使用以下工具来获取信息或执行操作：
- read_file: 读取文件内容
- write_file: 写入或创建文件
- list_directory: 列出目录内容
- search_files: 按模式搜索文件
- run_command: 执行 shell 命令
- web_search: 搜索网页信息
- read_attachment: 读取用户上传的附件内容
- read_upstream_node: 读取上游连线节点的完整 .md 文档（传入节点标题）
- read_material: 读取项目的 materials 文件夹中的参考资料（通过 @ 引用）
- read_calendar: 查询日历中的待办事项（支持 today/week/upcoming/all 过滤）

当用户的问题需要读取文件、列出目录、搜索文件、执行命令、搜索网络或读取附件时，请主动使用相应的工具来获取信息，然后基于工具返回的结果回答用户。不要猜测文件内容或命令输出，始终通过工具获取真实数据。

工具使用边界（严格遵守）：
- read_file、list_directory、search_files 这些工具只能操作 ~/BobAgent/sandbox/ 目录下的内容，绝对禁止访问用户个人文件（如桌面、文档、下载、图片等目录）
- write_file 和 run_command 可以在 ~/BobAgent/sandbox/、~/BobAgent/skills/ 和 ~/BobAgent/projects/ 下写入
- 创建技能时，请写入 ~/BobAgent/skills/<技能名>/SKILL.md，技能目录会自动被系统加载
- 生成文档输出（.docx、.md、.pdf 等）请写入当前项目的目录下，例如 ~/BobAgent/projects/<项目名>/
- 如果你无法从训练知识、上下文信息或用户上传的附件中找到答案，请直接承认"我不确定"或"这超出我的能力范围"，而不要试图遍历用户本地文件来寻找线索
- 用户上传的 PDF、图片等附件会通过系统自动解析，你只需要基于消息中已有内容回答。只有当消息中明确提示"使用 read_attachment"时才调用该工具
- 你不是在用户电脑上进行系统诊断或安全分析，不要尝试读取 ~/.ssh、~/.bashrc、/etc/passwd 等系统文件

工作区文件读写：
- 通用文件读写的工作区根目录为 ~/BobAgent/sandbox/，相对路径均基于此目录
- 创建技能请写入 ~/BobAgent/skills/<技能名>/SKILL.md
- 如果用户需要你处理文件，请告知用户将文件放入工作区文件夹，然后使用 read_file 读取
- 可使用 list_directory 列出工作区中的文件，帮助用户确认文件是否存在

附件处理规则：
- 如果用户消息中包含文本类附件（如 .txt, .md, .docx 等），请使用 read_attachment 工具读取附件内容，然后基于附件内容回答用户的问题
- 图片附件会自动通过视觉模型描述，你无需手动处理，直接基于描述内容回答即可
- PDF 附件会自动提取文本内容并注入到消息中，你无需手动处理（扫描件会在消息中提示使用 read_attachment）
- 每个附件只需读取一次，读取后请基于内容直接回答
- 不要忽略用户上传的附件，始终主动读取与问题相关的附件

资料引用处理规则：
- 如果用户消息中包含"引用资料列表"（以"--- 引用资料列表 ---"开头），列出的是用户在 materials 文件夹中通过 @ 引用的资料文件
- 当用户的问题涉及这些引用资料时，请使用 read_material 工具读取资料内容（传入资料路径）
- 每个资料只需读取一次，读取后请基于内容直接回答
- 不要猜测资料内容，始终通过 read_material 工具获取真实数据

工具使用原则：
- read_upstream_node: 每个上游节点最多调用 1 次，获取到内容后直接基于内容回答，不要重复读取同一节点
- web_search 每个问题最多调用 1-2 次，获取到结果后立即基于结果回答，不要反复搜索同一问题
- 拿到工具结果后应直接组织回答，不要重复调用相同工具
- 如果工具返回的结果足够回答问题，就不要再调用其他工具

当现有工具无法直接解决问题时：
- 先判断缺的是什么：
  - 缺可执行程序（如 ffmpeg、rembg、pandoc 等）→ 使用 run_command 安装
  - 缺外部信息 → 使用 web_search 搜索
  - 缺专业知识/工作流程 → 先尝试基于自身知识推理解决
- 如果专业知识超出你的能力范围，搜索 GitHub 上的社区技能：
  - 使用 web_search 搜索：site:github.com SKILL.md <关键词>
  - 如果找到相关技能 → 向用户提议安装，等待确认后用 run_command git clone 到 ~/BobAgent/skills/
  - 如果找不到 → 诚实承认 + 主动提出："我可以帮你写一个新的 skill 来覆盖这个场景"

与用户互动原则：
- 当用户需求不明确、信息不足或存在多种可能的理解时，主动向用户提问以澄清需求，而不是猜测
- 当需要用户在多个方案中做选择时，列出选项并让用户决定
- 当任务涉及用户的偏好、风格或主观判断时，先询问用户意见
- 提问应简洁具体，每次提问数量请遵循上方思考要求中的限制

提问格式（重要）：
当你需要向用户提问时，在回答末尾附上结构化提问数据。不要在正文中重复列问题，只在末尾输出一次 JSON 块：

<!-- QUESTIONS -->
[{"id":"q1","question":"问题文字","options":["选项A","选项B","选项C"],"allowCustom":true}]
<!-- /QUESTIONS -->

字段说明：
- id: 问题唯一标识（q1, q2, q3...）
- question: 你要问用户的问题
- options: 推荐答案列表，每道题 2-4 个选项
- allowCustom: 是否允许用户自行输入其他答案（通常设为 true）
- 问题之间用换行分隔
- 请确保 JSON 格式正确，可以被 JSON.parse 解析`;

/** 提取最后一条用户消息的纯文本内容 */
function extractLastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content;
    }
  }
  return '';
}

/** 匹配技能并注入上下文到系统提示。返回匹配到的技能名列表。 */
function injectSkillContext(messages: ChatMessage[], forcedSkills?: string[]): { messages: ChatMessage[]; matchedSkillNames: string[] } {
  const userContent = extractLastUserContent(messages);
  if (!userContent) return { messages, matchedSkillNames: [] };

  const allDefs = getAllSkills();
  if (!allDefs.length) return { messages, matchedSkillNames: [] };

  const AGENT_ID = 'default';
  const SYSTEM_DEFAULT_SKILLS = new Set([
    'character-creator',
    'bob-plugin-creator',
    'skill-creator',
    'user-guide',
    'intern-lawyer',
    'legal-drafter',
    'quiet-musing',
  ]);
  const enabledSet = hasAgentConfig(AGENT_ID)
    ? getEnabledSkillsForAgent(AGENT_ID)
    : SYSTEM_DEFAULT_SKILLS;

  if (!enabledSet.size) return { messages, matchedSkillNames: [] };

  const availableSkills = allDefs
    .filter(d => enabledSet.has(d.meta.name))
    .map(d => d.meta);

  const defMap = new Map(allDefs.map(d => [d.meta.name, d]));

  let skillCtx: string;
  let matchedNames: string[] = [];

  if (forcedSkills && forcedSkills.length > 0) {
    // 手动指定：直接注入 L1 + L2，不依赖关键词匹配
    console.log('[技能注入] forcedSkills 参数:', forcedSkills);
    const forcedDefs = allDefs.filter(d => forcedSkills.includes(d.meta.name));
    console.log('[技能注入] 匹配到的技能定义:', forcedDefs.map(d => d.meta.name));
    matchedNames = forcedDefs.map(d => d.meta.name);
    const forcedMetas = forcedDefs.map(d => d.meta);
    // 直接构建完整上下文（L1 目录 + L2 正文），确保技能 body 被注入
    const forcedMatches = forcedDefs.map(d => ({ skillMeta: d.meta, score: 1.0, matchedKeywords: ['手动触发'] }));
    skillCtx = buildSkillContext(forcedMatches, defMap, forcedMetas);
    console.log('[技能注入] 手动指定:', matchedNames, '上下文长度:', skillCtx?.length || 0);
  } else {
    // 自动匹配
    skillCtx = matchAndBuildContext(userContent, availableSkills, defMap);
    const matches = matchSkills(userContent, availableSkills);
    matchedNames = matches.map((m) => m.skillMeta.name);
    console.log('[技能注入] 自动匹配:', matchedNames, '可用技能数:', availableSkills.length, '上下文长度:', skillCtx?.length || 0);
  }

  if (!skillCtx) return { messages, matchedSkillNames: matchedNames };

  const result = [...messages];
  const sysIdx = result.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) {
    result[sysIdx] = {
      ...result[sysIdx],
      content: skillCtx + '\n\n' + result[sysIdx].content,
    };
  } else {
    result.unshift({ role: 'system', content: skillCtx });
  }

  return { messages: result, matchedSkillNames: matchedNames };
}

/** 根据思考深度构建系统提示并注入到消息列表 */
function injectThinkingPrompt(
  messages: ChatMessage[],
  level: ThinkingLevel,
  modelSupportsThinking = true,
): ChatMessage[] {
  let injection = SYSTEM_PROMPT_INJECTIONS[level];

  if (injection && !modelSupportsThinking) {
    // 非推理模型：去掉 <think></think> 标签引用，但保留思考引导内容
    injection = injection
      .replace(/思考过程用 <think><\/think> 标签包裹[。.]?/g, '')
      .replace(/用 <think><\/think> 标签包裹[。.]?/g, '')
      .replace(/用 <think> 标签包裹[。.]?/g, '')
      .replace(/所有分析用 <think> 标签包裹[。.]?/g, '')
      .replace(/\n{3,}/g, '\n\n');
  }

  const result = [...messages];

  const sysIdx = result.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) {
    // 已有系统消息：追加工具说明 + 思考注入
    const existingContent = result[sysIdx].content;
    result[sysIdx] = {
      ...result[sysIdx],
      content: BASE_SYSTEM_PROMPT + '\n\n' + existingContent + (injection || ''),
    };
  } else {
    const sysContent = injection
      ? BASE_SYSTEM_PROMPT + injection
      : BASE_SYSTEM_PROMPT;
    result.unshift({ role: 'system', content: sysContent });
  }

  return result;
}

/** 最大工具调用轮次（防止无限循环） */
const MAX_TOOL_ROUNDS = 8;
/** 同一工具+相同参数的最大重复次数 */
const MAX_DUPLICATE_CALLS = 2;

/** 检测聊天模型是否支持视觉 */
function chatModelSupportsVision(modelId: string, baseUrl?: string): boolean {
  if (!modelId) return false;
  const visionPatterns = /(vision|vl|4o|qwen-vl|glm-4v|gemini|claude-3-opus|claude-3.5)/i;
  return visionPatterns.test(modelId);
}

/** Vision Bridge：自动检测图片附件，用视觉模型描述后注入文本 */
async function applyVisionBridge(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const hasImageAttachment = messages.some((m) => {
    if (m.role !== 'user') return false;
    return m.content.includes('图片') && m.content.includes('路径: assets/');
  });

  if (!hasImageAttachment) {
    return messages;
  }

  try {
    const project = await getCurrentProject();
    const settings = await readSettingsFromFile();
    const visionModel = settings.vision.defaultModel;
    const visionApiKey = settings.vision.apiKey;

    if (!visionModel || !visionApiKey) {
      return messages;
    }

    const modelConfig = await buildVisionModelConfig(visionModel, visionApiKey, settings.vision.baseUrl || undefined);

    const imagePaths: string[] = [];
    messages.forEach((m) => {
      if (m.role === 'user') {
        const matches = m.content.match(/路径: (assets\/[^\\n]+)/g);
        if (matches) {
          matches.forEach((match) => {
            const path = match.replace('路径: ', '');
            const ext = path.split('.').pop()?.toLowerCase();
            if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
              imagePaths.push(path);
            }
          });
        }
      }
    });

    if (imagePaths.length === 0) {
      return messages;
    }

    const descriptions: string[] = [];
    for (const imgPath of imagePaths) {
      const filePath = `${project.path}/${imgPath}`;
      try {
        const result = await parseImage(
          filePath,
          project.path,
          {
            model: modelConfig.model,
            apiKey: modelConfig.apiKey,
            baseUrl: modelConfig.baseUrl,
            mode: 'general',
          }
        );
        descriptions.push(`图片描述: ${result.extracted_text}`);
      } catch (e) {
        console.warn('视觉模型分析图片失败:', e);
      }
    }

    if (descriptions.length === 0) {
      return messages;
    }

    const modifiedMessages: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'user') {
        const hasImage = m.content.includes('图片') && m.content.includes('路径: assets/');
        if (hasImage) {
          modifiedMessages.push({
            ...m,
            content: m.content + `\n\n[图片已通过视觉模型描述如下：\n${descriptions.join('\n')}\n]`,
          });
        } else {
          modifiedMessages.push(m);
        }
      } else {
        modifiedMessages.push(m);
      }
    }

    return modifiedMessages;
  } catch (e) {
    console.warn('Vision Bridge 执行失败:', e);
    return messages;
  }
}

/** 检查是否重复调用同一工具+相同参数 */
function isDuplicateCall(
  toolName: string,
  args: Record<string, unknown>,
  history: Array<{ toolName: string; arguments: Record<string, unknown> }>,
): boolean {
  const argKey = JSON.stringify(args);
  const count = history.filter(
    (h) => h.toolName === toolName && JSON.stringify(h.arguments) === argKey,
  ).length;
  return count >= MAX_DUPLICATE_CALLS;
}

export async function POST(request: NextRequest) {
  try {
    const {
      messages,
      nodeId,
      modelId,
      thinking,
      temperature,
      apiKey,
      baseUrl,
      providerModelId,
      thinkingLevel,
      forcedSkills,
    } = await request.json() as {
      messages: ChatMessage[];
      nodeId?: string;
      modelId?: string;
      thinking?: 'enabled' | 'disabled';
      temperature?: number;
      apiKey?: string;
      baseUrl?: string;
      providerModelId?: string;
      thinkingLevel?: ThinkingLevel;
      forcedSkills?: string[];
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'messages is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const hasUserMessage = messages.some((m) => m.role === 'user');
    if (!hasUserMessage) {
      return new Response(
        JSON.stringify({ error: 'At least one user message is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 注入思考深度系统提示
    const level: ThinkingLevel = thinkingLevel ?? 'medium';
    const reasoningEffort = REASONING_EFFORT_MAP[level];

    const thinkingEnabled = level === 'off' ? 'disabled' : (thinking ?? 'enabled');

    // 判断当前模型是否支持推理（用于决定是否传 reasoning_effort 参数）
    const isCustom = !!(apiKey && baseUrl && providerModelId);
    const modelSupportsThinking = (() => {
      if (!isCustom) return thinking === 'enabled';
      // 自定义模型：通过模型名判断
      return /reason|r1|z1|think|k2/i.test(providerModelId);
    })();

    // 上游节点上下文已在前端注入到系统提示中，后端直接使用
    const messagesWithContext = messages;

    // Vision Bridge：自动检测图片附件，用视觉模型描述后注入文本
    const messagesWithVision = await applyVisionBridge(messagesWithContext);

    // PDF Bridge：自动检测 PDF 附件，提取文本内容后注入
    let messagesWithPdf = messagesWithVision;
    let currentProjectPath = '';
    try {
      const project = await getCurrentProject();
      if (project) {
        messagesWithPdf = await applyPdfBridge(messagesWithVision, project.path);
        currentProjectPath = project.path.replace(homedir(), '~');
      }
    } catch (e) {
      console.warn('PDF Bridge 执行失败:', e);
    }

    // 注入当前项目路径到系统提示，让 AI 知道文档应该写入哪里
    const projectPathInjection = currentProjectPath
      ? `\n\n当前项目路径：${currentProjectPath}\n当你需要生成文档（.md、.docx、.pdf 等）时，请写入 ${currentProjectPath}/homework/ 目录下，不要写入沙箱目录。homework 文件夹专门存放项目产出文档，与节点的 .md 文件分开。`
      : '';

    // off 模式不注入思考提示；非推理模型仍注入 MOOD（不含 <think> 要求），由系统提示区分
    const effectiveLevel: ThinkingLevel = level;
    const { messages: messagesWithSkill, matchedSkillNames } = injectSkillContext(messagesWithPdf, forcedSkills);
    const finalMessages = injectThinkingPrompt(messagesWithSkill, effectiveLevel, modelSupportsThinking);

    // 将项目路径注入追加到系统消息
    if (projectPathInjection) {
      const sysIdx = finalMessages.findIndex((m) => m.role === 'system');
      if (sysIdx >= 0) {
        finalMessages[sysIdx] = {
          ...finalMessages[sysIdx],
          content: finalMessages[sysIdx].content + projectPathInjection,
        };
      }
    }

    const encoder = new TextEncoder();

    if (isCustom) {
      // ---- 使用 OpenAI SDK 调用自定义提供商（支持工具调用循环） ----
      const client = new OpenAI({ apiKey, baseURL: baseUrl });

      // 注册自定义工具（每次请求都刷新，确保与 settings 同步）
      const settingsForTools = await readSettingsFromFile();
      registerCustomTools(settingsForTools.customTools || []);

      // 同步 MCP 服务器配置并注册 MCP 工具
      const { mcpManager } = await import('@/lib/mcp/manager');
      await mcpManager.syncServers(settingsForTools.mcpServers || []);
      await registerMcpTools().catch((e) => console.error('[MCP] 工具注册失败:', e));

      const toolDefs = getToolDefinitions();

      const isMoonshotThinking = baseUrl.includes('moonshot') && /kimi-k\d/i.test(providerModelId);
      const isDeepseekReasoner = baseUrl.includes('deepseek') && /reason/i.test(providerModelId);
      const finalTemp = isMoonshotThinking || isDeepseekReasoner ? 1 : (temperature ?? 0.7);

      const readableStream = new ReadableStream({
        async start(controller) {
          const send = (data: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };

          try {
            // 工具调用循环
            const conversationMessages: ChatMessage[] = [...finalMessages];
            const allToolCalls: Array<{
              toolName: string;
              arguments: Record<string, unknown>;
              result: string;
              durationMs: number;
              success: boolean;
            }> = [];

            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
              // 达到最后一轮时，不带 tools 参数，强制模型输出最终答案
              const isLastRound = round === MAX_TOOL_ROUNDS - 1;

              const requestBody: Record<string, unknown> = {
                model: providerModelId,
                messages: isLastRound
                  ? [
                      ...conversationMessages,
                      {
                        role: 'user' as const,
                        content: '请基于以上工具调用结果，直接给出最终回答，不要再调用任何工具。',
                      },
                    ]
                  : conversationMessages,
                stream: true,
                temperature: finalTemp,
              };

              // 最后一轮不传 tools，强制模型输出文本
              if (!isLastRound) {
                requestBody.tools = toolDefs;
              }

              if (reasoningEffort && modelSupportsThinking) {
                requestBody.reasoning_effort = reasoningEffort;
              }

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const completion = (await (client.chat.completions.create as any)({
                ...requestBody,
                stream: true,
              })) as AsyncIterable<{
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    reasoning_content?: string | null;
                    tool_calls?: Array<{
                      index: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string;
                }>;
              }>;

              // 收集流式内容
              let contentParts = '';
              let reasoningParts = '';
              const toolCallBuf: Map<number, { id: string; name: string; arguments: string }> = new Map();

              for await (const chunk of completion) {
                const delta = chunk.choices?.[0]?.delta;
                if (!delta) continue;

                // 思考过程
                const reasoning = delta.reasoning_content ?? undefined;
                if (reasoning) {
                  reasoningParts += reasoning;
                  send({ reasoning, nodeId });
                }

                // 文本内容
                if (delta.content) {
                  contentParts += delta.content;
                  send({ content: delta.content, nodeId });
                }

                // 工具调用增量
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCallBuf.has(idx)) {
                      toolCallBuf.set(idx, { id: '', name: '', arguments: '' });
                    }
                    const buf = toolCallBuf.get(idx)!;
                    if (tc.id) buf.id = tc.id;
                    if (tc.function?.name) buf.name += tc.function.name;
                    if (tc.function?.arguments) buf.arguments += tc.function.arguments;
                  }
                }
              }

              // 检查是否有工具调用
              if (toolCallBuf.size === 0 || isLastRound) {
                // 没有工具调用或已达最后一轮，流式输出已完成
                break;
              }

              // 构建 assistant 消息（含 tool_calls）
              const parsedToolCalls = Array.from(toolCallBuf.entries())
                .sort(([a], [b]) => a - b)
                .map(([, buf]) => ({
                  id: buf.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                  type: 'function' as const,
                  function: { name: buf.name, arguments: buf.arguments },
                }));

              conversationMessages.push({
                role: 'assistant',
                content: contentParts || '',
                tool_calls: parsedToolCalls,
              });

              // 执行每个工具调用（跳过重复调用）
              for (const tc of parsedToolCalls) {
                const toolName = tc.function.name;
                let parsedArgs: Record<string, unknown>;
                try {
                  parsedArgs = JSON.parse(tc.function.arguments);
                } catch {
                  parsedArgs = {};
                }

                // 检查是否重复调用同一工具+相同参数
                if (isDuplicateCall(toolName, parsedArgs, allToolCalls)) {
                  // 跳过重复调用，直接返回提示
                  const dupResult = '跳过重复调用：已执行过相同参数的此工具，请基于已有结果回答。';
                  conversationMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: dupResult,
                  });
                  send({
                    tool_call: { name: toolName, arguments: parsedArgs },
                    nodeId,
                  });
                  send({
                    tool_result: {
                      name: toolName,
                      result: dupResult,
                      durationMs: 0,
                      success: false,
                    },
                    nodeId,
                  });
                  continue;
                }

                // 发送 tool_call 事件
                send({
                  tool_call: {
                    name: toolName,
                    arguments: parsedArgs,
                  },
                  nodeId,
                });

                // 执行工具
                const execResult = await executeTool(toolName, tc.function.arguments);

                // 发送 tool_result 事件
                send({
                  tool_result: {
                    name: toolName,
                    result: execResult.result.slice(0, 2000),
                    durationMs: execResult.durationMs,
                    success: execResult.success,
                  },
                  nodeId,
                });

                // 记录工具调用
                allToolCalls.push({
                  toolName,
                  arguments: parsedArgs,
                  result: execResult.result,
                  durationMs: execResult.durationMs,
                  success: execResult.success,
                });

                // 工具结果加入对话历史
                conversationMessages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: execResult.result,
                });
              }

              // 继续下一轮循环，让模型基于工具结果继续思考
            }

            // 如果达到最大轮次，发送工具摘要
            if (allToolCalls.length > 0) {
              send({
                tool_summary: {
                  total: allToolCalls.length,
                  names: [...new Set(allToolCalls.map((t) => t.toolName))],
                },
                nodeId,
              });
            }

            send({ done: true, nodeId, matchedSkills: matchedSkillNames });
            controller.close();
          } catch (error) {
            let errorMessage =
              error instanceof Error ? error.message : 'Unknown error';
            if (errorMessage.includes('model') && (errorMessage.includes('not found') || errorMessage.includes('does not exist'))) {
              errorMessage = `模型 "${providerModelId}" 不可用，请检查该模型是否已在当前 API Key 下开通。可在设置中重新获取模型列表并选择可用模型。`;
            }
            if (errorMessage.includes('401') || errorMessage.includes('Authentication')) {
              errorMessage = 'API Key 认证失败，请检查设置中的 API Key 是否正确。';
            }
            if (errorMessage.includes('402') || errorMessage.includes('insufficient')) {
              errorMessage = 'API 账户余额不足，请充值后重试。';
            }
            if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
              errorMessage = '请求过于频繁，请稍后再试。';
            }
            send({ error: errorMessage, nodeId });
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } else {
      // ---- 使用 coze-coding-dev-sdk 调用托管模型 ----
      const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
      const config = new Config();
      const client = new LLMClient(config, customHeaders);

      const stream = client.stream(finalMessages as unknown as Parameters<typeof client.stream>[0], {
        model: modelId,
        thinking: thinkingEnabled,
        temperature: temperature ?? 1.0,
      });

      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) {
              const reasoning = chunk.additional_kwargs?.reasoning_content as string | undefined;
              if (reasoning) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ reasoning, nodeId })}\n\n`),
                );
              }
              if (chunk.content) {
                const text = chunk.content.toString();
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ content: text, nodeId })}\n\n`),
                );
              }
            }
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ done: true, nodeId, matchedSkills: matchedSkillNames })}\n\n`),
            );
            controller.close();
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error';
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ error: errorMessage, nodeId })}\n\n`),
            );
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
