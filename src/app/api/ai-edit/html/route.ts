/**
 * AI HTML 编辑接口：自然语言指令修改 HTML 文档/元素
 *
 * 三种模式：
 *   - mode='document'：全文档重生成（未选中元素时）
 *   - mode='element'：元素级精准修改（选中元素后，输出完整 outerHTML）
 *   - mode='text'：快速文案草稿（只输出纯文字，不做 HTML 校验，供前端二次编辑后本地替换）
 *
 * 优化：
 *  1. SSE 流式响应 — 边生成边推，降低首屏等待；最后一个事件携带完整 JSON 结果（success+html）
 *  2. HTML 最小化预处理 — 去除注释/压缩空白，减少 context token 浪费
 *  3. 强化 system prompt — 明确禁止 markdown 围栏/解释，避免 2 倍重试
 *  4. 后端 180s 超时保护（service 层约束）
 */
import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { readSettingsFromFile } from '@/lib/settings-server';
import { getProviderPreset, parseCustomModel, isCustomModel, type ProviderConfig } from '@/lib/types';
import { modelOutputTokenMaxForModel } from '@/lib/context-limits';
import { resolveAppRoot } from '@/lib/app-root';
import { join } from 'path';

/** AI HTML 编辑请求日志：落盘 <BOBWORK_HOME>/.logs/ai-edit.jsonl（同步 IO，永不抛错）。
 *  用途：回溯每次编辑的 mode / 目标元素 / 校验结果 / 输出规模，排查"改一部分变整体"类问题。 */
const AI_EDIT_LOG_DIR = join(resolveAppRoot(), '.logs');
const AI_EDIT_LOG_PATH = join(AI_EDIT_LOG_DIR, 'ai-edit.jsonl');
function logAiEdit(entry: Record<string, unknown>): void {
  try {
    const fs = require('fs');
    fs.mkdirSync(AI_EDIT_LOG_DIR, { recursive: true });
    fs.appendFileSync(AI_EDIT_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch { /* 日志失败不影响主链路 */ }
}

interface AiEditRequest {
  html: string;
  instruction: string;
  mode?: 'document' | 'element' | 'text';
  element?: {
    selector: string;
    outerHTML: string;
  };
  /** modelId = '' 表示 Auto（走 chatModel.defaultModel，再兜底首个可用） */
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  providerModelId?: string;
}

/** HTML 最小化：去除 HTML/JS 注释 + 压缩空行/多空格，保留 <pre> 内空白 */
function minifyHtml(html: string): string {
  if (!html) return '';
  // 保护 <pre>/<textarea>/<script>/<style> 内的空白
  const protectedBlocks: string[] = [];
  const placeholder = (i: number) => `\u0000PROTECTED_${i}\u0000`;
  let i = 0;
  const protect = (tag: string) => {
    const re = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi');
    html = html.replace(re, (m) => {
      protectedBlocks.push(m);
      return placeholder(i++);
    });
  };
  protect('pre');
  protect('textarea');
  protect('script');
  protect('style');
  // 去除 HTML 注释（<!-- ... -->，但保留条件注释太复杂这里省略）
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // 去除行尾/行首空格 + 合并多空行
  html = html.replace(/[ \t]+$/gm, '').replace(/^[ \t]+/gm, ' ').replace(/\n{2,}/g, '\n');
  // 标签之间的纯空白行
  html = html.replace(/>\s*\n\s*</g, '><');
  // 恢复保护块
  for (let j = 0; j < protectedBlocks.length; j++) {
    html = html.replace(placeholder(j), protectedBlocks[j]);
  }
  return html.trim();
}

/** 从 settings 解析模型配置：优先请求自定义，其次 modelId 解析，兜底 Auto=chatModel.defaultModel */
async function resolveModelConfig(req: Partial<AiEditRequest>) {
  if (req.apiKey && req.baseUrl && req.providerModelId) {
    return { apiKey: req.apiKey, baseUrl: req.baseUrl, model: req.providerModelId };
  }
  const settings = await readSettingsFromFile();
  const providers: ProviderConfig[] = settings.providers || [];
  const chatDefaultPool = settings.chatModel?.pool ?? [];
  const chatDefaultModel = settings.chatModel?.defaultModel;
  const firstProvider = providers.find((p) => p.apiKey && p.selectedModels?.length);
  const resolveByRef = (ref: string) => {
    if (isCustomModel(ref)) {
      const parsed = parseCustomModel(ref);
      if (!parsed) return null;
      const p = providers.find((c) => c.type === parsed.provider && c.apiKey);
      if (!p) return null;
      const preset = getProviderPreset(p.type);
      return {
        apiKey: p.apiKey,
        baseUrl: p.baseUrl || preset?.baseUrl || '',
        model: parsed.modelId,
      };
    }
    // 非 custom：把 modelId 当 provider+model 的引用名，优先匹配 chat pool 的 (provider,modelId) 组合
    const poolMatch = chatDefaultPool.find((c) => c.modelId === ref);
    if (poolMatch) {
      const p = providers.find((c) => c.type === poolMatch.provider && c.apiKey);
      if (p) {
        const preset = getProviderPreset(p.type);
        return {
          apiKey: p.apiKey,
          baseUrl: p.baseUrl || preset?.baseUrl || '',
          model: poolMatch.modelId,
        };
      }
    }
    // 退化为 firstProvider（provider 类型本身不暴露 provider/modelId 字段）
    if (firstProvider?.apiKey) {
      const preset = getProviderPreset(firstProvider.type);
      return {
        apiKey: firstProvider.apiKey,
        baseUrl: firstProvider.baseUrl || preset?.baseUrl || '',
        model: firstProvider.selectedModels?.[0]?.modelId || ref,
      };
    }
    return null;
  };
  if (req.modelId) {
    const r = resolveByRef(req.modelId);
    if (r) return r;
  }
  if (chatDefaultModel) {
    const r = resolveByRef(chatDefaultModel);
    if (r) return r;
  }
  if (chatDefaultPool.length) {
    const p = providers.find((c) => c.type === chatDefaultPool[0].provider && c.apiKey);
    if (p) {
      const preset = getProviderPreset(p.type);
      return {
        apiKey: p.apiKey,
        baseUrl: p.baseUrl || preset?.baseUrl || '',
        model: chatDefaultPool[0].modelId,
      };
    }
  }
  if (firstProvider?.apiKey) {
    const preset = getProviderPreset(firstProvider.type);
    return {
      apiKey: firstProvider.apiKey,
      baseUrl: firstProvider.baseUrl || preset?.baseUrl || '',
      model: firstProvider.selectedModels?.[0]?.modelId || '',
    };
  }
  return null;
}

/** 构建全文档修改的 messages（含强约束 prompt，减少格式校验失败重试） */
function buildDocumentMessages(html: string, instruction: string) {
  return [
    {
      role: 'system' as const,
      content: `你是资深前端工程师。用户给你一份 HTML 文档 + 一条修改指令，你必须输出修改后的完整 HTML 文档。

❗️输出格式铁律（违反即失败）：
1. 输出必须以 <!DOCTYPE html> 或 <html 开头，以 </html> 结尾
2. 输出内容里绝对禁止出现：解释、说明、思考过程、道歉、markdown 代码块围栏（\`\`\`html ... \`\`\` 禁止）
3. 除了 HTML 本身什么都不要写，开头和结尾不要有任何空行或其他字符
4. 保留未涉及部分的原有结构与内容，不要随意删减
5. 保持沙箱离线运行：不得引入外部 CDN / 网络资源
6. 优先使用内联 style 进行视觉修改`,
    },
    {
      role: 'user' as const,
      content: `[当前 HTML 文档]
${html}

[修改指令]
${instruction}`,
    },
  ];
}

/** 构建元素级修改的 messages */
function buildElementMessages(html: string, element: { selector: string; outerHTML: string }, instruction: string) {
  const context = html.length > 3000
    ? html.slice(0, 1500) + '\n<!-- ... 截断 ... -->\n' + html.slice(-1500)
    : html;
  return [
    {
      role: 'system' as const,
      content: `你是资深前端工程师。用户给你页面上下文 + 待修改元素的选择器与 HTML + 一条修改指令。

❗️输出格式铁律（违反即失败）：
1. 仅输出该元素修改后的完整 outerHTML（包含自身标签的开始与结束）
2. 输出必须以 < 开头、以 > 结尾
3. 绝对禁止输出：解释、说明、思考过程、道歉、markdown 代码块围栏
4. 除了元素 HTML 本身什么都不要写，开头结尾不要有其他字符或空行
5. 保持元素的标签类型不变（div 仍然是 div，除非指令明确要求更换）
6. 优先使用内联 style 修改视觉`,
    },
    {
      role: 'user' as const,
      content: `[页面上下文]
${context}

[待修改元素]
选择器: ${element.selector}
${element.outerHTML}

[修改指令]
${instruction}`,
    },
  ];
}

/** 构建文案优化草稿的 messages：只要纯文字输出（用于前端快速替换的中间态，无 HTML 校验） */
function buildTextMessages(html: string, element: { selector: string; outerHTML: string }, instruction: string) {
  const context = html.length > 3000
    ? html.slice(0, 1500) + '\n<!-- ... 截断 ... -->\n' + html.slice(-1500)
    : html;
  return [
    {
      role: 'system' as const,
      content: `你是资深文案编辑。用户给你页面上下文 + 一个待修改元素 + 一条改写指令，你只输出该元素的新文案（纯文字）。

❗️输出格式铁律（违反即失败）：
1. 只输出纯文字内容本身：绝对禁止输出任何 HTML 标签、markdown 代码块围栏、解释或多余字符
2. 只围绕该元素的文字内容做措辞优化/改写，不输出元素标签、属性、结构或其他内容
3. 保持原意与语气一致，长度适中（除非指令明确要求扩写或压缩）
4. 开头和结尾不要有任何空行或其他字符`,
    },
    {
      role: 'user' as const,
      content: `[页面上下文]
${context}

[待修改元素]
选择器: ${element.selector}
${element.outerHTML}

[改写指令]
${instruction}`,
    },
  ];
}

function validateDocumentOutput(output: string): boolean {
  const trimmed = output.trim();
  return (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) && trimmed.endsWith('</html>');
}

/** 从 HTML 字符串提取顶层根标签名（用于 element 模式校验模型是否返回正确层级） */
function extractTagName(html: string): string | null {
  const m = /^\s*<([a-zA-Z][\w-]*)/.exec(html);
  return m ? m[1].toLowerCase() : null;
}

/** 统计顶层根元素数量（忽略注释/纯文本；void 元素与自闭合标签不增加深度） */
function countRootElements(html: string): number {
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tagRe = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let depth = 0;
  let roots = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const full = m[0];
    if (full.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const name = m[1].toLowerCase();
    const isSelfClosing = /\s*\/\s*>$/.test(full) || voidTags.has(name);
    if (!isSelfClosing) {
      if (depth === 0) roots++;
      depth++;
    }
  }
  return roots;
}

interface ElementValidationResult { valid: boolean; reason: string; }

/**
 * element 模式校验：模型必须返回「单个、与目标元素同标签」的 outerHTML。
 * 模型误输出完整文档（<!DOCTYPE/<html>/<head>/<body>）或错误层级元素（如整页 section）时，
 * 前端会把它嵌进被选元素导致整体结构崩塌（表现为"整页变成一段文字"），必须在服务端拦截。
 */
function validateElementOutput(output: string, origTag: string | null): ElementValidationResult {
  const trimmed = output.trim();
  if (!trimmed.startsWith('<') || !trimmed.endsWith('>')) {
    return { valid: false, reason: '输出不是有效的 HTML 元素（未以 < 开始或以 > 结尾）' };
  }
  if (/^<!doctype\s+/i.test(trimmed)) {
    return { valid: false, reason: '输出是整个 HTML 文档而非单个元素' };
  }
  const rootTag = extractTagName(trimmed);
  if (!rootTag) {
    return { valid: false, reason: '无法解析输出的根标签' };
  }
  if (['html', 'head', 'body'].includes(rootTag)) {
    return { valid: false, reason: `输出以 <${rootTag}> 开头，是整页文档而非单个元素` };
  }
  if (countRootElements(trimmed) > 1) {
    return { valid: false, reason: '输出包含多个顶层元素（应只输出目标元素这一个）' };
  }
  if (origTag && rootTag !== origTag) {
    return { valid: false, reason: `输出根标签 <${rootTag}> 与目标元素 <${origTag}> 不一致（可能返回了整页/整块内容，而非目标元素本身）` };
  }
  return { valid: true, reason: '' };
}

/** 去除 markdown 围栏（首尾） */
function stripFences(output: string): string {
  return output.replace(/^```(?:html)?\n?/i, '').replace(/\n?```$/i, '').trim();
}

/** 写 SSE 事件：event:xxx / data:单行 */
function sseEvent(stream: TransformStreamDefaultController<string>, event: string, data: Record<string, unknown> | string) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  stream.enqueue(`event: ${event}\ndata: ${payload.replace(/\n/g, '\\n')}\n\n`);
}

/** SSE 消费 OpenAI stream，逐 token push，结束时尝试校验+返回最终 JSON */
async function streamCompletion(
  client: OpenAI,
  config: { model: string },
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  mode: 'document' | 'element' | 'text',
  stream: TransformStreamDefaultController<string>,
  maxTokens: number,
  /** element 模式的目标元素标签，用于校验模型返回的是目标元素本身而非整页/整块内容 */
  origTag: string | null = null,
): Promise<{ output: string; isValid: boolean; needRetry: boolean; failReason: string }> {
  const streamResp = await client.chat.completions.create({
    model: config.model,
    messages,
    temperature: 0.2,
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
  const output = stripFences(full);
  // text 模式只生成纯文字草稿，无需 HTML 起止标签校验；element 模式需校验"单个同标签元素"
  let isValid = false;
  let failReason = '';
  if (mode === 'text') {
    isValid = output.length > 0;
    if (!isValid) failReason = '输出为空';
  } else if (mode === 'element') {
    const v = validateElementOutput(output, origTag);
    isValid = v.valid;
    failReason = v.reason;
  } else {
    isValid = validateDocumentOutput(output);
    if (!isValid) failReason = '输出缺少完整文档结构（未以 <!DOCTYPE html>/<html 开头或 </html> 结尾）';
  }
  if (!isValid) {
    // 仅当看起来像是有解释文字或错误层级时才值得重试；完全为空直接返回失败
    const needRetry = output.length > 30;
    return { output, isValid: false, needRetry, failReason };
  }
  return { output, isValid: true, needRetry: false, failReason: '' };
}

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  // 后端 service 层 180 秒超时保护
  const timeoutMs = 180_000;
  const timeoutAbort = new AbortController();
  const timeoutT = setTimeout(() => timeoutAbort.abort(new Error('AI HTML edit timeout (180s)')), timeoutMs);

  // SSE 响应头：即便格式校验失败也通过最后一个 event:done 返回结果，保持一致的消费端
  const { readable, writable } = new TransformStream<string, string>();
  const writer = writable.getWriter();
  const streamController = {
    enqueue: (s: string) => writer.write(s),
  } as unknown as TransformStreamDefaultController<string>;

  const run = async () => {
    try {
      const body = await request.json() as AiEditRequest;
      const { html, instruction, mode = 'document', element } = body;

      if (!html || !instruction) {
        sseEvent(streamController, 'error', 'html and instruction are required');
        sseEvent(streamController, 'done', { success: false, error: 'html and instruction are required' });
        return;
      }
      if ((mode === 'element' || mode === 'text') && (!element?.selector || !element?.outerHTML)) {
        sseEvent(streamController, 'error', 'element.selector and element.outerHTML are required for element/text mode');
        sseEvent(streamController, 'done', { success: false, error: 'element.selector and element.outerHTML are required' });
        return;
      }

      const config = await resolveModelConfig(body);
      if (!config) {
        sseEvent(streamController, 'error', '未配置可用模型，请先在设置中配置 API Key');
        sseEvent(streamController, 'done', { success: false, error: '未配置可用模型，请先在设置中配置 API Key' });
        return;
      }

      const startTs = Date.now();
      logAiEdit({
        event: 'request',
        mode,
        model: config.model,
        htmlLen: html.length,
        instruction: instruction.slice(0, 200),
        selector: element?.selector,
      });

      // 1) 上下文最小化：减少 token → 降低 TTFT
      const minHtml = minifyHtml(html);
      const minElement = element
        ? { selector: element.selector, outerHTML: minifyHtml(element.outerHTML) }
        : undefined;
      // element 模式的原始标签：用于校验模型返回的是目标元素本身而非整页/整块内容
      const origTag = mode === 'element' && minElement ? extractTagName(minElement.outerHTML) : null;

      sseEvent(streamController, 'meta', {
        mode,
        model: config.model,
        originalChars: html.length,
        minifiedChars: minHtml.length,
      });

      const messages = mode === 'element'
        ? buildElementMessages(minHtml, minElement!, instruction)
        : mode === 'text'
          ? buildTextMessages(minHtml, minElement!, instruction)
          : buildDocumentMessages(minHtml, instruction);

      const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
      // element 模式只重写局部（2000 足够）；text 模式草稿很短（1200 足够）；document 模式输出完整 HTML，按模型能力放大输出上限
      const maxTokens = mode === 'element'
        ? 2000
        : mode === 'text'
          ? 1200
          : modelOutputTokenMaxForModel(config.model);

      // 2) 第一次流式生成
      const first = await streamCompletion(client, config, messages, mode, streamController, maxTokens, origTag);
      let output = first.output;

      if (!first.isValid && first.needRetry) {
        sseEvent(streamController, 'retry', { reason: 'format-mismatch' });
        const retryMsgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          ...messages,
          { role: 'assistant' as const, content: first.output },
          {
            role: 'user' as const,
            content:
              `你的上一次输出不符合要求：${first.failReason || '包含多余的解释、markdown 围栏或起止标签错误'}。请严格只输出要求的 HTML，不要写任何其他文字。重新输出：`,
          },
        ];
        const second = await streamCompletion(client, config, retryMsgs, mode, streamController, maxTokens, origTag);
        if (second.isValid) output = second.output;
        else if (!output && second.output) output = second.output;
      }

      // 兜底校验：重试后输出仍为空 / 不满足格式 → 明确失败，禁止把无效 HTML 当成功返回
      // （否则前端拿空壳 HTML 渲染 → 编辑区白屏，且 autoSave 会把损坏内容写回文件）
      const finalOutput = (output || '').trim();
      let finalValid = false;
      let failReason = '模型返回空结果';
      if (mode === 'text') {
        finalValid = finalOutput.length > 0;
      } else if (mode === 'element') {
        const v = validateElementOutput(finalOutput, origTag);
        finalValid = v.valid;
        failReason = v.reason || '模型输出不符合元素格式';
      } else {
        finalValid = validateDocumentOutput(finalOutput);
        failReason = '模型输出不符合完整 HTML 格式（缺少 <!DOCTYPE html>/<html> 或 </html> 结尾）';
      }
      if (!finalValid) {
        logAiEdit({
          event: 'result', mode, ok: false, failReason,
          outputLen: finalOutput.length, model: config.model, ms: Date.now() - startTs,
        });
        sseEvent(streamController, 'error', `${failReason}，请重新尝试。`);
        sseEvent(streamController, 'done', { success: false, error: failReason });
        return;
      }

      logAiEdit({
        event: 'result', mode, ok: true,
        outputLen: output.length, model: config.model, ms: Date.now() - startTs,
      });
      sseEvent(streamController, 'done', {
        success: true,
        html: output,
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
