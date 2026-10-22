import { NextRequest } from 'next/server';
import { guardRequestSource } from '@/lib/http/loopback-guard';
import { resolveAppIdentity } from '@/lib/sandbox/app-token';
import {
  executeSandboxChatStream,
  type SandboxChatMessage,
} from '@/lib/sandbox/chat-bridge';

/**
 * Bob Sandbox Chat Stream — 小程序流式模型调用
 *
 * POST /api/sandbox/chat-stream  { appId, model?, messages, temperature?, maxTokens? }
 *
 * 返回 SSE 流：逐块产出增量文本。协议（与宿主转发 iframe 对齐）：
 *   event: delta   data: {"text":"..."}
 *   event: done    data: {"model":"provider:modelId","provider":"...","usage":{...}}
 *
 * 鉴权与上限完全复用 chat-bridge 的安全闸（权限/模型白名单/token上限/出口审计）。
 * 小程序是可信度低的代码，本端点绝不暴露文件/工具能力。
 */
export async function POST(request: NextRequest) {
  const denied = await guardRequestSource(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => null);
    // 身份闸：与 /api/sandbox/bridge 一致，只认签名令牌
    const claimed = (body as Record<string, unknown> | undefined)?._appId ?? (body as Record<string, unknown> | undefined)?.appId;
    const identity = await resolveAppIdentity({
      token: String((body as Record<string, unknown> | undefined)?._appToken ?? ''),
      claimedAppId: claimed ? String(claimed) : undefined,
    });
    if (!identity.appId) {
      return Response.json(
        { success: false, error: `unauthorized: ${identity.error ?? 'invalid app token'}` },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const appId = String(identity.appId);
    const messages = ((body as Record<string, unknown> | undefined)?.messages as SandboxChatMessage[] | undefined) ?? [];

    if (!appId) {
      return Response.json({ success: false, error: 'appId is required' }, { status: 400 });
    }
    // 存在性闸：小程序已删除 → 410 Gone（与 /api/sandbox/bridge 一致）
    const { sanitizeAppId, appExists } = await import('@/lib/sandbox/apps');
    const safeAppId = sanitizeAppId(appId);
    if (!safeAppId || !(await appExists(safeAppId))) {
      return Response.json(
        { success: false, error: 'mini-program not found or deleted', appId: safeAppId ?? null },
        { status: 410, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const data = (body as Record<string, unknown>) || {};
    const params = {
      appId,
      messages,
      model: typeof data.model === 'string' ? data.model : undefined,
      temperature: typeof data.temperature === 'number' ? data.temperature : undefined,
      maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : undefined,
    };

    // 先在流外完成安全闸校验，鉴权失败时直接返回 JSON 错误（而非半截 SSE）
    // 采用惰性生成器：首迭代即触发 resolveSandboxChatConfig，据此区分鉴权失败与正常流
    const gen = executeSandboxChatStream(params);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // 手动迭代以便同时捕获 yield 的增量与 return 的元信息
          for (;;) {
            const step = await gen.next();
            if (step.done) {
              const meta = (step.value ?? {}) as unknown as Record<string, unknown>;
              controller.enqueue(
                encoder.encode(`event: done\ndata: ${JSON.stringify(meta)}\n\n`),
              );
              break;
            }
            controller.enqueue(
              encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: step.value })}\n\n`),
            );
          }
          controller.close();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // 权限/白名单等鉴权失败：作为 error 事件回传（前端 reject）
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`),
          );
          controller.close();
        }
      },
      cancel() {
        // 客户端中断：通知生成器 abort，终止上游请求
        void gen.return(undefined as never).catch(() => undefined);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
