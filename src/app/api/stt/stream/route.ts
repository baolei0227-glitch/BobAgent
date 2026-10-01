import { NextRequest, NextResponse } from 'next/server';
import { resolveStreamingSttModel, startLocalSttStreamServer } from '@/lib/stt/sherpa';

/**
 * /api/stt/stream — 实时（边说边出字）本地转写的会话入口
 *
 * GET  ：返回 { available, modelId }，renderer 据此判断麦克风能否走实时链路
 *        （streaming 模型已下载就绪才 available；没有就退回「录完再转写」）
 * POST ：body { action: 'start' }     → { port, modelId }   按需拉起常驻 WS 服务端，返回直连端口
 *        body { action: 'keepalive' } → { port, modelId }   只续期「空闲回收」计时（复用同一实例，
 *        端口不变）。为什么需要：会议模式一整场只开**一条** WS 会话（不再每 45s 换块，见
 *        MeetingConsole），而常驻服务端空闲 3 分钟就回收——没有这个心跳，开录 3 分钟后引擎会被
 *        回收掉，整场会议剩下的时间就不再有实时转写了。
 *
 * 音频不走这里：renderer 拿到 port 后直连 ws://127.0.0.1:<port>，协议见 lib/stt/sherpa 顶部注释。
 * 服务端不需要 renderer 显式停：空闲 3 分钟自动回收，删除模型/卸载引擎时也会立即回收。
 */

// 冷启动要加载 int8 zipformer（最大 30s），给足时间
export const maxDuration = 60;

export async function GET() {
  try {
    const modelId = await resolveStreamingSttModel();
    return NextResponse.json({ success: true, available: !!modelId, modelId });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    if (action !== 'start' && action !== 'keepalive') {
      throw new Error("Unsupported action — use { action: 'start' } or { action: 'keepalive' }.");
    }
    const modelId = await resolveStreamingSttModel();
    if (!modelId) {
      throw new Error('No streaming STT model is ready. Download it in Settings → Roles → Audio STT Model.');
    }
    const { port } = await startLocalSttStreamServer(modelId);
    return NextResponse.json({ success: true, port, modelId });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}