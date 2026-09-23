/**
 * AI Markdown 编辑接口：自然语言指令修改 markdown 文档的选中片段
 *
 * 两种模式（对齐 HtmlViewer 双粒度）：
 *   - mode='inline'：对选中的文字片段生成优化后的新文字（可含行内语法如 **bold** / `code`）
 *   - mode='block'：对选中的段落/标题/列表块生成优化后的完整 markdown 片段（可含多行）
 *
 * 输出：SSE 流式 token；最后一个 event:done 携带完整 JSON 结果（success + text）
 * 约定：AI 只输出「替换片段」本身，不做整篇重写、不输出解释/围栏
 */
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { resolveModelConfig } from '@/lib/ai/resolve-model-config';
import { modelOutputTokenMaxForModel } from '@/lib/context-limits';

interface MdEditRequest {
  md: string;
  instruction: string;
  mode?: 'inline' | 'block';
  selection?: {
    text: string;
  };
  /** modelId = '' 表示 Auto（走 chatModel.defaultModel，再兜底首个可用）；否则用 isCustomModel('qwen:xxx') 解析 */
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  providerModelId?: string;
}

/** 行内模式：只改写选中文字，保留 markdown 行内语法 */
function buildInlineMessages(md: string, selection: string, instruction: string, drawing: boolean) {
  const context = md.length > 6000 ? md.slice(0, 3000) + '\n<!-- ... 截断 ... -->\n' + md.slice(-3000) : md;
  return [
    {
      role: 'system' as const,
      content: `你是资深文档编辑。用户给你一篇 markdown 文档 + 被选中的一段文字 + 一条改写指令，你只输出这段文字改写后的新内容。

❗️输出格式铁律（违反即失败）：
1. 只输出改写后的文字本身：绝对禁止输出解释、思考过程、markdown 代码块围栏（\`\`\` 禁止）
2. 可以保留/使用行内 markdown 语法（**加粗**、*斜体*、\`代码\`、[链接](url)）；不画图时不要引入块级语法（#、列表项等）；唯一例外：指令要求画图时可输出 \`\`\`mermaid 代码块
3. 保持原意、语气与长度（除非指令明确要求扩写或压缩）
4. 结合文档上下文：修改必须与全文的术语、称谓、风格、事实保持一致，不得引入与上下文矛盾的内容
5. 开头和结尾不要有任何空行或其他字符
6. 你唯一被允许修改的对象就是 [被选中的文字]。输出必须是对这段文字的改写结果（将直接替换它）；绝对禁止修改、引用或输出文档中其它任何段落的内容。如果指令与该段文字无关、或你判断不该改，就原样返回这段文字（不做任何改动）
${drawing ? DRAWING_RULES : ''}`,
    },
    {
      role: 'user' as const,
      content: `[文档上下文]
${context}

[被选中的文字]
${selection}

[改写指令]
${instruction}`,
    },
  ];
}

/** 块级模式：改写整个块（段落/标题/列表项），输出完整 markdown 片段 */
function buildBlockMessages(md: string, block: string, instruction: string, drawing: boolean) {
  const context = md.length > 6000 ? md.slice(0, 3000) + '\n<!-- ... 截断 ... -->\n' + md.slice(-3000) : md;
  return [
    {
      role: 'system' as const,
      content: `你是资深文档编辑。用户给你一篇 markdown 文档 + 一个被选中的块（段落/标题/列表项等）+ 一条改写指令，你只输出这个块改写后的完整 markdown 片段。

❗️输出格式铁律（违反即失败）：
1. 只输出改写后的 markdown 块本身：绝对禁止输出解释、思考过程、markdown 代码块围栏（\`\`\` 禁止）
2. 保持块类型一致：原来是标题仍是标题（# 前缀不变），原来是列表项仍是列表项（- 或数字. 前缀不变），除非指令明确要求改结构
3. 可以包含行内 markdown 语法，可以输出多行
4. 只围绕这个块改写，不要输出其他块或整篇文档
5. 开头和结尾不要有任何空行或其他字符
6. 你唯一被允许修改的对象就是 [被选中的块]。输出必须是对这个块的改写结果（将直接替换它）；绝对禁止修改、引用或输出文档中其它任何块的内容。如果指令与该块无关、或你判断不该改，就原样返回这个块（不做任何改动）
${drawing ? DRAWING_RULES : ''}`,
    },
    {
      role: 'user' as const,
      content: `[文档上下文]
${context}

[被选中的块]
${block}

[改写指令]
${instruction}`,
    },
  ];
}

/** 去除首尾 markdown 围栏 */
function stripFences(output: string): string {
  return output.replace(/^```(?:md|markdown)?\n?/i, '').replace(/\n?```$/i, '').trim();
}

/** 批注指令是否要求画图（命中才注入 bob-ui 绘图规则，避免每轮膨胀上下文） */
function needsDrawing(instruction: string): boolean {
  return /画图|画个图|画一张|绘图|图表|流程图|结构图|架构图|时序图|序列图|状态图|甘特图|饼图|思维导图|时间线|桑基|示意图|mermaid|diagram|\bchart\b/i.test(
    instruction || '',
  );
}

/**
 * bob-ui 绘图能力注入段（仅需画图时附加）：文档编辑器支持 ```mermaid / ```widget:mermaid 渲染，
 * AI 可在替换片段中输出 Mermaid 代码块实现"修订即画图"。
 */
const DRAWING_RULES = `
需要画图时（如流程图/时序图/状态图/甘特图/饼图/思维导图/时间线/桑基图），你可以在输出中直接包含 Mermaid 代码块（\`\`\`mermaid 开头，\`\`\` 结尾），文档会渲染为图表。规则：
- 常用类型：flowchart（流程/决策）、sequenceDiagram（时序）、classDiagram（类图）、stateDiagram（状态）、gantt（甘特）、pie（饼图）、mindmap（思维导图）、gitGraph、timeline（时间线）、sankey（桑基）
- 节点与参与者使用中文；语法必须合法，否则渲染失败会回退为源码块
- 配色纪律：焦点节点唯一着色，主色用品牌紫 #4b3fe3（accent 浅填充 + 描边）；起点节点用跑道形、决策节点用菱形；成功/失败终态仅在语义明确时才用绿/红
- 输出铁律仍适用：整个输出就是替换片段本身，代码块外不要输出解释文字`;

/** 写 SSE 事件 */
function sseEvent(stream: TransformStreamDefaultController<string>, event: string, data: Record<string, unknown> | string) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  stream.enqueue(`event: ${event}\ndata: ${payload.replace(/\n/g, '\\n')}\n\n`);
}

/** SSE 消费 OpenAI stream，逐 token push */
async function streamCompletion(
  client: OpenAI,
  config: { model: string },
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  stream: TransformStreamDefaultController<string>,
  maxTokens: number,
): Promise<string> {
  const streamResp = await client.chat.completions.create({
    model: config.model,
    messages,
    temperature: 0.3,
    max_tokens: maxTokens,
    stream: true,
  });
  let full = '';
  for await (const chunk of streamResp as unknown as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>) {
    const piece = chunk.choices?.[0]?.delta?.content;
    if (piece) {
      full += piece;
      sseEvent(stream, 'token', { t: piece });
    }
  }
  return stripFences(full);
}

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const timeoutMs = 180_000;
  const timeoutAbort = new AbortController();
  const timeoutT = setTimeout(() => timeoutAbort.abort(new Error('AI markdown edit timeout (180s)')), timeoutMs);

  const { readable, writable } = new TransformStream<string, string>();
  const writer = writable.getWriter();
  const streamController = {
    enqueue: (s: string) => writer.write(s),
  } as unknown as TransformStreamDefaultController<string>;

  const run = async () => {
    try {
      const body = (await request.json()) as MdEditRequest;
      const { md, instruction, mode = 'inline', selection } = body;

      if (!md || !instruction) {
        sseEvent(streamController, 'error', 'md and instruction are required');
        sseEvent(streamController, 'done', { success: false, error: 'md and instruction are required' });
        return;
      }
      if (!selection?.text) {
        sseEvent(streamController, 'error', 'selection.text is required');
        sseEvent(streamController, 'done', { success: false, error: 'selection.text is required' });
        return;
      }

      const config = await resolveModelConfig(body);
      if (!config) {
        sseEvent(streamController, 'error', '未配置可用模型，请先在设置中配置 API Key');
        sseEvent(streamController, 'done', { success: false, error: '未配置可用模型，请先在设置中配置 API Key' });
        return;
      }

      sseEvent(streamController, 'meta', { mode, model: config.model });

      const messages =
        mode === 'block'
          ? buildBlockMessages(md, selection.text, instruction, needsDrawing(instruction))
          : buildInlineMessages(md, selection.text, instruction, needsDrawing(instruction));

      const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
      // block 2000；inline 按模型能力
      const maxTokens = mode === 'block' ? 2000 : modelOutputTokenMaxForModel(config.model);

      // 步骤日志：inline/block 为单轮，发一条执行摘要
      sseEvent(streamController, 'step', { text: mode === 'block' ? '重写选中区块' : '改写选中文字' });

      let output = await streamCompletion(client, config, messages, streamController, maxTokens);

      // 输出太短视为异常，重试一次
      if (output.length < 1) {
        const retryMsgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          ...messages,
          {
            role: 'user' as const,
            content: '你的输出为空。请严格按照要求输出改写后的内容，不要输出任何其他文字。重新输出：',
          },
        ];
        const second = await streamCompletion(client, config, retryMsgs, streamController, maxTokens);
        if (second.length > 0) output = second;
      }

      sseEvent(streamController, 'done', {
        success: true,
        text: output,
        mode,
        model: config.model,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try { sseEvent(streamController, 'error', msg); } catch { /* ignore */ }
      try { sseEvent(streamController, 'done', { success: false, error: msg }); } catch { /* ignore */ }
    } finally {
      try { await writer.close(); } catch { /* ignore */ }
      clearTimeout(timeoutT);
    }
  };

  run();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
