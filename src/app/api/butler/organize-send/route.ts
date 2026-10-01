/**
 * Butler 一键整理（浏览器侧边栏 ChatSidebar → Butler 收件箱）
 *
 * 扩展 sidebar.js 的「📥 整理到 Butler」按钮调用本接口：
 *   收集当前会话全部问答对 → POST 本路由 → 后端调 /api/chat 生成
 *   「三层结构」分析报告 → insertInbox 落库收件箱（web 分类邮件），
 *   原始对话作为 messages 附件一并存档。
 * 请求为一次性非流式调用，不占用 ChatNode 上下文。
 */
import { NextRequest } from 'next/server';
import { insertInbox } from '@/lib/core/inbox';
import { resolveButlerModel, BUTLER_PLACEHOLDER_NODE_ID } from '@/lib/butler/entry';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface QaMessage {
  role: string;
  text?: string;
  content?: string;
}

/** 把侧边栏问答记录拼成报告 prompt（三层结构：结论 → 细节依据 → 建议/动作） */
function buildReportPrompt(qa: QaMessage[], pageTitle: string, pageUrl: string): string {
  const lines: string[] = [];
  if (pageTitle || pageUrl) {
    lines.push(`页面：${pageTitle || ''}${pageUrl ? ` (${pageUrl})` : ''}`);
  }
  lines.push('');
  for (const m of qa) {
    const text = (m.text ?? m.content ?? '').trim();
    if (!text) continue;
    const role = m.role === 'user' ? '用户' : 'AI';
    lines.push(`--- ${role} ---`);
    lines.push(text);
  }
  return [
    '你是 BobWork 的浏览器助手。以下是你与用户在浏览器侧边栏对话中的完整问答记录。',
    '请整理成一份结构化分析报告（Markdown），按三层结构：',
    '1) 核心结论：本次对话围绕什么问题、最终得到什么结论；',
    '2) 关键细节与依据：引用对话中的具体信息、数据或页面内容；',
    '3) 延伸建议：后续可执行的动作或值得进一步探索的方向（如有）。',
    '要求：忠实于原文，不编造内容；简明扼要；若对话无实质内容请如实说明。',
    '',
    '== 原始对话 ==',
    ...lines,
  ].join('\n');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const qa: QaMessage[] = Array.isArray(body?.messages)
      ? (body.messages as QaMessage[]).filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      : [];
    if (qa.length === 0) {
      return Response.json({ success: false, error: 'no conversation to organize' }, { status: 400 });
    }
    const pageTitle = String(body?.pageTitle || '').slice(0, 200);
    const pageUrl = String(body?.pageUrl || '').slice(0, 500);

    // 1. 调 /api/chat（sandbox 问答，不绑定节点/项目）生成分析报告
    const model = await resolveButlerModel();
    const base = `http://localhost:${process.env.PORT || '5000'}`;
    const prompt = buildReportPrompt(qa, pageTitle, pageUrl);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('请求超时（180 秒），请稍后重试')), 180_000);
    let report = '';
    try {
      const chatResp = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          nodeId: BUTLER_PLACEHOLDER_NODE_ID,
          thinkingLevel: 'medium',
          sandbox: true,
          ...(model.custom
            ? { apiKey: model.apiKey, baseUrl: model.baseUrl, providerModelId: model.providerModelId }
            : { modelId: model.modelId }),
        }),
      });
      const raw = await chatResp.text();
      if (!chatResp.ok) {
        let err = '';
        try {
          err = (JSON.parse(raw).error as string) || '';
        } catch {
          /* 非 JSON */
        }
        throw new Error(err || `BobWork chat failed (HTTP ${chatResp.status})`);
      }
      // 聚合 SSE 流（与 node-chat 相同的数据格式：data: { content / reasoning / error }）
      for (const chunk of raw.split('\n\n')) {
        const line = chunk.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (data.error) throw new Error(String(data.error));
          if (typeof data.content === 'string') report += data.content;
        } catch {
          /* 忽略无法解析的 chunk */
        }
      }
    } finally {
      clearTimeout(timer);
    }
    const reportBody = report.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '(empty report)';

    // 2. 落库收件箱（web 分类；原始对话作为 messages 附件存档）
    const title = `Web Report — ${pageTitle || new Date().toLocaleString()}`.slice(0, 120);
    const record = await insertInbox({
      kind: 'web',
      title,
      body: reportBody,
      messages: qa.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.text ?? m.content ?? '',
      })),
      source: 'panel',
    });
    return Response.json({ success: true, id: record.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[butler/organize-send] 整理失败:', e);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
}
