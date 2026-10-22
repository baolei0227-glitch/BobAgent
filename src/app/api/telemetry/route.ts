import { NextRequest } from 'next/server';

import { guardRequestSource } from '@/lib/http/loopback-guard';
import { appendCodingTelemetry } from '@/lib/sandbox/telemetry';

/**
 * POST /api/telemetry — 客户端 coding 会话收尾时上报一轮关键指标。
 * 仅本机回环可写；只收数值/短 id，不接愿望、代码、模型输出或个人信息。
 */
export async function POST(request: NextRequest) {
  const denied = await guardRequestSource(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ success: false, error: 'invalid body' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  await appendCodingTelemetry({
    appId: typeof b.appId === 'string' ? b.appId : undefined,
    modelId: typeof b.modelId === 'string' ? b.modelId : undefined,
    durationMs: typeof b.durationMs === 'number' ? b.durationMs : 0,
    firstCodeMs: typeof b.firstCodeMs === 'number' ? b.firstCodeMs : undefined,
    firstPreviewMs: typeof b.firstPreviewMs === 'number' ? b.firstPreviewMs : undefined,
    toolCalls: typeof b.toolCalls === 'number' ? b.toolCalls : undefined,
    toolErrors: typeof b.toolErrors === 'number' ? b.toolErrors : undefined,
    autoRepair: b.autoRepair === true,
    consoleErrors: typeof b.consoleErrors === 'number' ? b.consoleErrors : undefined,
  });
  return Response.json({ success: true });
}
